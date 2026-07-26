import { randomUUID } from 'node:crypto'
import type { Settings } from '@aila/agent'
import {
  AILA_RUN_ARTIFACT_SCHEMA_VERSION,
  AILA_RUN_CHECKPOINT_SCHEMA_VERSION,
  type ChatMessage,
  type DurableRunExecutor,
  type ImageSideChannelBlock,
  type ModelCallToolCall,
  type ModelDescriptor,
  type ModelInfo,
  type ModelSelection,
  type PersistedToolResultRef,
  type RunArtifact,
  type RunCheckpoint,
  type RunEvent,
  type RunEventType,
  type RunHandlers,
  type RunIdentity,
  runRecoveryFromCursor,
  type ToolActivityTarget,
  type ToolCall,
  type ToolContext,
  type ToolRegistry,
  type UsageInfo,
} from '@aila/agent'
import { executeTool, getToolDefinitions, summarizeToolTarget } from '@aila/agent/host'
import {
  createRunCursor,
  type RunCursor,
  type RunTransition,
  reduceRunTransition,
  runDurableRun,
} from '@aila/agent/internal'
import { AssistantMessageBuilder } from './assistant-message-builder'
import { MissingApiKeyError, type NodeAuthInput, requireApiKey } from './auth'
import { createDefaultModelStreamClient } from './default-model-stream'
import { createProviderModelCallExecutor } from './model-call-executor'
import { prepareModelInput } from './model-input-pipeline'
import {
  type CreateModelRegistryInput,
  createModelRegistry,
  type ModelRegistry,
} from './model-registry'
import type { ModelStreamClient, ModelStreamToolDefinition, ModelStreamUsage } from './model-stream'
import { createProtocolRegistry, type ProtocolAdapter, type ProtocolRegistry } from './protocols'
import {
  createNodeToolResultStore,
  DEFAULT_MAX_INLINE_TOOL_RESULT_CHARS,
  DEFAULT_TOOL_RESULT_PREVIEW_CHARS,
  type ToolResultStore,
} from './tool-result-store'

type MaybePromise<T> = T | Promise<T>

const EVENT_PREVIEW_CHARS = 1000

/**
 * Backstop on how many tool-using model steps a single turn may take. Context
 * auto-compaction keeps the window bounded, so this is a runaway/cost guard, not
 * a context guard. Hitting it is graceful: the model gets one final, tool-free
 * step to wrap up (see TOOL_BUDGET_EXHAUSTED_NOTICE) instead of a thrown error.
 * Override per instance via DurableRunExecutorOptions.maxSteps.
 */
const DEFAULT_MAX_TOOL_STEPS = 50

const TOOL_BUDGET_EXHAUSTED_NOTICE =
  'You have reached the maximum number of tool-using steps for this turn. ' +
  'Do not request any more tools. Using the results you already have, give the ' +
  'user a clear final answer: what you did, the current state, and any remaining ' +
  'next steps they should take.'

export interface DurableRunExecutorOptions extends NodeAuthInput {
  modelRegistry?: ModelRegistry
  modelRegistryOptions?: CreateModelRegistryInput
  protocolRegistry?: ProtocolRegistry
  protocolAdapters?: ProtocolAdapter[]
  modelStreamClient?: ModelStreamClient
  settings?: Settings
  loadSettings?: () => Settings
  imageDir?: string
  dataDir?: string
  toolResultDir?: string
  toolResultStore?: ToolResultStore | null
  maxInlineToolResultChars?: number
  toolResultPreviewChars?: number
  /** Backstop on tool-using model steps per turn. Defaults to DEFAULT_MAX_TOOL_STEPS. */
  maxSteps?: number
  createStepId?: () => string
  createEventId?: () => string
}

export function createDurableRunExecutor(
  options: DurableRunExecutorOptions = {},
): DurableRunExecutor {
  const modelRegistry =
    options.modelRegistry ??
    createModelRegistry(options.modelRegistryOptions ?? { providers: options.providers })
  const protocolRegistry =
    options.protocolRegistry ?? createProtocolRegistry(options.protocolAdapters)
  const modelStreamClient =
    options.modelStreamClient ??
    createDefaultModelStreamClient({
      protocolRegistry,
      imageDir: options.imageDir,
    })
  const modelCallExecutor = createProviderModelCallExecutor({ modelStreamClient })
  const toolResultStore =
    options.toolResultStore === null
      ? null
      : (options.toolResultStore ??
        createNodeToolResultStore({
          dataDir: options.dataDir,
          toolResultDir: options.toolResultDir,
        }))
  const maxInlineToolResultChars =
    options.maxInlineToolResultChars ?? DEFAULT_MAX_INLINE_TOOL_RESULT_CHARS
  const toolResultPreviewChars = options.toolResultPreviewChars ?? DEFAULT_TOOL_RESULT_PREVIEW_CHARS
  const maxToolSteps = Math.max(1, Math.floor(options.maxSteps ?? DEFAULT_MAX_TOOL_STEPS))

  return async (req, handlers): Promise<void> => {
    const {
      conversationId,
      assistantMessageId,
      run: requestRun,
      loopMode = 'continuous',
      runCheckpoint,
      messages: requestMessages,
      contextPlan: requestContextPlan,
      selection: requestSelection,
      signal,
      onRunEvent,
      saveRunCheckpoint,
      saveRunArtifact,
      workspaceRoots: requestWorkspaceRoots,
      shellCwd,
      onToolPolicy,
      onToolApproval,
      settings: requestSettings,
      webSearch,
      generateImage,
      saveImage,
      runShell,
      fileSystem,
      toolRegistry,
    } = req

    const messages = cloneAgentMessages(runCheckpoint?.messages ?? requestMessages)
    const selection = cloneAgentValue(requestSelection)
    const contextPlan = cloneAgentValue(runCheckpoint?.contextPlan ?? requestContextPlan)
    const workspaceRoots = cloneAgentWorkspaceRoots(requestWorkspaceRoots)
    const builder = new AssistantMessageBuilder(runCheckpoint?.assistantMessage.blocks)
    let lastUsage: UsageInfo | null = runCheckpoint?.usage
      ? cloneAgentValue(runCheckpoint.usage)
      : null
    const toolTargets = new Map<string, ToolActivityTarget>()
    const run: RunIdentity = cloneAgentValue(
      runCheckpoint?.identity ??
        requestRun ?? {
          conversationId,
          turnId: assistantMessageId,
          runId: assistantMessageId,
        },
    )
    let activeStepId: string | undefined

    const createRunEvent = (
      type: RunEventType,
      data?: Record<string, unknown>,
      stepId = activeStepId,
    ): RunEvent => {
      const event: RunEvent = {
        timestamp: Date.now(),
        conversationId,
        messageId: assistantMessageId,
        type,
        turnId: run.turnId,
        runId: run.runId,
        ...(stepId ? { stepId } : {}),
        eventId: (options.createEventId ?? randomUUID)(),
        ...(data && { data: cloneAgentValue(data) }),
      }
      return event
    }
    const emitRunEvent = (
      type: RunEventType,
      data?: Record<string, unknown>,
      stepId?: string,
    ): void => {
      const pending = onRunEvent?.(cloneAgentValue(createRunEvent(type, data, stepId))) as unknown
      if (pending && typeof (pending as PromiseLike<void>).then === 'function') {
        void Promise.resolve(pending).catch(() => {})
      }
    }
    const emitDurableRunEvent = async (
      type: RunEventType,
      data?: Record<string, unknown>,
      stepId?: string,
    ): Promise<void> => {
      await onRunEvent?.(cloneAgentValue(createRunEvent(type, data, stepId)))
    }
    let runBoundaryPersisted = false
    const persistPreLoopFailure = async (message: string): Promise<void> => {
      if (runBoundaryPersisted) return
      runBoundaryPersisted = true
      const timestamp = Date.now()
      const loop = cloneAgentValue(
        runCheckpoint?.loop ?? createRunCursor<ModelCallToolCall>(run, loopMode),
      )
      if (!runCheckpoint) {
        const started: RunTransition = {
          type: 'run.started',
          timestamp,
          identity: cloneAgentValue(run),
          mode: loopMode,
        }
        loop.state = reduceRunTransition(loop.state, started)
        await emitDurableRunEvent(started.type, runTransitionData(started))
      }
      const failed: RunTransition = {
        type: 'run.failed',
        timestamp,
        identity: cloneAgentValue(run),
        error: message,
      }
      loop.state = reduceRunTransition(loop.state, failed)
      await emitDurableRunEvent(failed.type, runTransitionData(failed))
      if (!saveRunCheckpoint) return
      await saveRunCheckpoint({
        schemaVersion: AILA_RUN_CHECKPOINT_SCHEMA_VERSION,
        identity: cloneAgentValue(run),
        assistantMessageId,
        selection: cloneAgentValue(selection),
        executionMode: runCheckpoint?.executionMode ?? req.mode ?? 'agent',
        maxToolSteps: runCheckpoint?.maxToolSteps ?? maxToolSteps,
        loop,
        messages: cloneAgentMessages(messages),
        modelStepOutputs: cloneAgentValue(runCheckpoint?.modelStepOutputs ?? {}),
        ...(contextPlan ? { contextPlan: cloneAgentValue(contextPlan) } : {}),
        assistantMessage: builder.build(assistantMessageId, 'error', selection, message),
        ...(lastUsage ? { usage: cloneAgentValue(lastUsage) } : {}),
        ...(runCheckpoint?.plan
          ? { plan: cloneAgentValue(runCheckpoint.plan) }
          : req.plan
            ? {
                plan: {
                  id: req.plan.id,
                  ...(req.planOperation ? { operation: req.planOperation } : {}),
                },
              }
            : {}),
        recovery: runRecoveryFromCursor(loop),
        revision: (runCheckpoint?.revision ?? 0) + 1,
        createdAt: runCheckpoint?.createdAt ?? timestamp,
        updatedAt: timestamp,
      })
    }

    const settings = cloneAgentSettings(
      requestSettings ??
        options.settings ??
        options.loadSettings?.() ?? { apiKeys: {}, defaultModel: null },
    )
    const descriptor = modelRegistry.resolve(selection)
    if (!runCheckpoint) {
      emitRunEvent('turn.started', {
        providerId: selection.providerId,
        modelId: selection.modelId,
        provider: descriptor.provider,
        api: descriptor.api,
        inputMessageCount: messages.length,
      })
    }

    const onImageFromTool = (block: ImageSideChannelBlock): void => {
      const imageBlock = cloneAgentValue(block)
      builder.appendImage(imageBlock)
      callStreamHandler(handlers.onImageBlock, {
        conversationId,
        messageId: assistantMessageId,
        block: imageBlock,
      })
    }

    let apiKey: string
    try {
      apiKey = requireApiKey(descriptor, {
        ...options,
        settings,
      })
    } catch (err) {
      const message =
        err instanceof MissingApiKeyError
          ? `No API key for ${err.providerId}. Configure an API key and retry.`
          : err instanceof Error
            ? err.message
            : String(err)
      await persistPreLoopFailure(message)
      await callAsyncStreamHandler(handlers.onError, {
        conversationId,
        messageId: assistantMessageId,
        error: message,
        message: builder.build(assistantMessageId, 'error', selection, message),
      })
      emitRunEvent('turn.failed', { error: message })
      return
    }

    try {
      const totalUsage = runCheckpoint?.usage
        ? cloneAgentValue(runCheckpoint.usage)
        : createUsageAccumulator()
      const bridged = runCheckpoint
        ? { messages, usage: [] }
        : await prepareModelInput({
            messages,
            descriptor,
            selection,
            settings,
            modelRegistry,
            modelCallExecutor,
            authInput: options,
            signal,
            emitRunEvent: emitRunEvent,
            dataDir: options.dataDir,
            imageDir: options.imageDir,
          })
      for (const usage of bridged.usage) {
        addUsage(totalUsage, usage)
        lastUsage = usageInfo(totalUsage)
      }

      const toolContext: Parameters<typeof executeTool>[2] = {
        settings,
        conversationId,
        messageId: assistantMessageId,
        turnId: run.turnId,
        runId: run.runId,
        workspaceRoots,
        shellCwd,
        signal,
        onToolPolicy,
        onToolApproval,
        webSearch,
        generateImage,
        saveImage,
        runShell,
        fileSystem,
        onImage: onImageFromTool,
      }
      const tools = buildToolSchemas(toolRegistry)
      const modelMessages = cloneAgentMessages(bridged.messages)
      const startedToolCalls = new Set<string>()

      let toolBudgetNoticeSent = false
      const assistantTextByModelStep = new Map<number, string>(
        Object.entries(runCheckpoint?.modelStepOutputs ?? {}).map(([index, text]) => [
          Number(index),
          text,
        ]),
      )
      let checkpointRevision = runCheckpoint?.revision ?? 0
      const checkpointCreatedAt = runCheckpoint?.createdAt ?? Date.now()
      let latestLoopSnapshot: RunCursor<ModelCallToolCall> | undefined
      const persistRunCheckpoint = async (
        loop: RunCursor<ModelCallToolCall>,
        messageStatus: 'streaming' | 'done' | 'error' = 'streaming',
        messageError?: string,
      ): Promise<void> => {
        latestLoopSnapshot = cloneAgentValue(loop)
        if (!saveRunCheckpoint) return
        const timestamp = Date.now()
        const checkpoint: RunCheckpoint = {
          schemaVersion: AILA_RUN_CHECKPOINT_SCHEMA_VERSION,
          identity: cloneAgentValue(run),
          assistantMessageId,
          selection: cloneAgentValue(selection),
          executionMode: req.mode ?? 'agent',
          maxToolSteps,
          loop: cloneAgentValue(loop),
          messages: cloneAgentMessages(modelMessages),
          modelStepOutputs: Object.fromEntries(assistantTextByModelStep),
          ...(contextPlan ? { contextPlan: cloneAgentValue(contextPlan) } : {}),
          assistantMessage: builder.build(
            assistantMessageId,
            messageStatus,
            selection,
            messageError,
          ),
          ...(lastUsage ? { usage: cloneAgentValue(lastUsage) } : {}),
          ...(req.plan
            ? {
                plan: {
                  id: req.plan.id,
                  ...(req.planOperation ? { operation: req.planOperation } : {}),
                },
              }
            : {}),
          recovery: runRecoveryFromCursor(loop),
          revision: checkpointRevision + 1,
          createdAt: checkpointCreatedAt,
          updatedAt: timestamp,
        }
        const saved = await saveRunCheckpoint(cloneAgentValue(checkpoint))
        checkpointRevision = saved.revision
      }
      const persistRunArtifact = async (artifact: RunArtifact): Promise<void> => {
        if (!saveRunArtifact) return
        await saveRunArtifact(cloneAgentValue(artifact))
      }
      const initialSnapshot = runCheckpoint?.loop ? cloneAgentValue(runCheckpoint.loop) : undefined
      if (initialSnapshot) initialSnapshot.state.mode = loopMode
      const loopResult = await runDurableRun<ParsedModelToolCall>({
        identity: run,
        signal,
        maxToolSteps,
        ...(initialSnapshot ? { initialSnapshot } : {}),
        ...(options.createStepId
          ? {
              createStepId: () => options.createStepId?.() ?? randomUUID(),
            }
          : {}),
        policy: { mode: loopMode },
        onSnapshot: (snapshot) => persistRunCheckpoint(snapshot),
        onTransition: async (transition) => {
          if (transition.type === 'run.started' || transition.type === 'run.resumed') {
            runBoundaryPersisted = true
          }
          if (transition.type === 'step.started') activeStepId = transition.step.stepId
          await emitDurableRunEvent(
            transition.type,
            runTransitionData(transition),
            'step' in transition ? transition.step.stepId : undefined,
          )
          if (
            transition.type === 'step.completed' ||
            transition.type === 'step.failed' ||
            transition.type === 'step.cancelled'
          ) {
            activeStepId = undefined
          }
        },
        executeModelStep: async ({ step, modelStepIndex, toolsEnabled, reason }) => {
          activeStepId = step.stepId
          if (!toolsEnabled && !toolBudgetNoticeSent) {
            toolBudgetNoticeSent = true
            modelMessages.push({ role: 'system', content: TOOL_BUDGET_EXHAUSTED_NOTICE })
          }

          const modelCallStartedAt = Date.now()
          const requestMessages = cloneAgentMessages(modelMessages)
          const requestTools = toolsEnabled ? cloneAgentValue(tools) : []
          await persistRunArtifact({
            schemaVersion: AILA_RUN_ARTIFACT_SCHEMA_VERSION,
            artifactId: `${run.runId}:${step.stepId}:model_request`,
            conversationId,
            turnId: run.turnId,
            runId: run.runId,
            stepId: step.stepId,
            kind: 'model_request',
            createdAt: modelCallStartedAt,
            contentType: 'application/json',
            data: {
              reason,
              modelStepIndex,
              toolsEnabled,
              descriptor: inspectableModelDescriptor(descriptor),
              messages: requestMessages,
              tools: requestTools,
              ...(contextPlan ? { contextPlan: cloneAgentValue(contextPlan) } : {}),
              ...(settings.promptCache ? { cache: cloneAgentValue(settings.promptCache) } : {}),
            },
          })
          const result = await modelCallExecutor.execute(
            {
              descriptor,
              apiKey,
              conversationId,
              messages: requestMessages,
              ...(contextPlan ? { contextPlan } : {}),
              ...(settings.promptCache ? { cache: settings.promptCache } : {}),
              tools: requestTools,
              signal,
              stepIndex: modelStepIndex,
            },
            async (part) => {
              switch (part.type) {
                case 'text-delta':
                  builder.appendText('text', part.text)
                  callStreamHandler(handlers.onTextDelta, {
                    conversationId,
                    messageId: assistantMessageId,
                    delta: part.text,
                  })
                  break
                case 'reasoning-delta':
                  builder.appendText('reasoning', part.text)
                  callStreamHandler(handlers.onReasoningDelta, {
                    conversationId,
                    messageId: assistantMessageId,
                    delta: part.text,
                  })
                  break
                case 'tool-input-start':
                  recordToolInputStart({
                    id: part.id,
                    name: part.toolName,
                    args: '',
                    builder,
                    startedToolCalls,
                    emitRunEvent,
                    handlers,
                    conversationId,
                    assistantMessageId,
                  })
                  break
                case 'tool-input-delta':
                  builder.appendToolCallArgs(part.id, part.delta)
                  emitRunEvent('tool.input.delta', {
                    toolCallId: part.id,
                    deltaSize: part.delta.length,
                  })
                  callStreamHandler(handlers.onToolCallArgsDelta, {
                    conversationId,
                    messageId: assistantMessageId,
                    toolCallId: part.id,
                    delta: part.delta,
                  })
                  break
                case 'tool-call':
                  recordToolInputCompleted({
                    call: parseModelToolCall(part.toolCallId, part.toolName, part.input),
                    builder,
                    startedToolCalls,
                    toolTargets,
                    emitRunEvent,
                    handlers,
                    conversationId,
                    assistantMessageId,
                  })
                  break
                case 'tool-result': {
                  const toolResult = await prepareToolResultForModel({
                    store: toolResultStore,
                    content: stringifyToolOutput(part.output),
                    conversationId,
                    messageId: assistantMessageId,
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    maxInlineChars: maxInlineToolResultChars,
                    previewChars: toolResultPreviewChars,
                  })
                  recordToolResult({
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    result: toolResult.content,
                    ...(toolResult.resultRef && { resultRef: toolResult.resultRef }),
                    isError: false,
                    builder,
                    toolTargets,
                    emitRunEvent,
                    handlers,
                    conversationId,
                    assistantMessageId,
                  })
                  break
                }
                case 'tool-error':
                  recordToolResult({
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    result: part.error instanceof Error ? part.error.message : String(part.error),
                    isError: true,
                    builder,
                    toolTargets,
                    emitRunEvent,
                    handlers,
                    conversationId,
                    assistantMessageId,
                  })
                  break
                case 'finish-step':
                case 'finish':
                case 'abort':
                case 'error':
                  break
              }
            },
          )

          for (const usage of result.stepUsage) {
            addUsage(totalUsage, usage)
            lastUsage = usageInfo(totalUsage)
          }
          if (result.totalUsage) {
            const providerTotal = usageInfoFromModelUsage(result.totalUsage)
            lastUsage =
              (totalUsage.modelCallCount ?? 0) > 0
                ? {
                    ...providerTotal,
                    modelCallCount: totalUsage.modelCallCount,
                    maxInputTokens: totalUsage.maxInputTokens,
                    lastInputTokens: totalUsage.lastInputTokens,
                    lastOutputTokens: totalUsage.lastOutputTokens,
                    lastCacheReadTokens: totalUsage.lastCacheReadTokens,
                    lastCacheWriteTokens: totalUsage.lastCacheWriteTokens,
                    lastCacheMissTokens: totalUsage.lastCacheMissTokens,
                  }
                : providerTotal
          }

          assistantTextByModelStep.set(modelStepIndex, result.text)
          const modelCallCompletedAt = Date.now()
          await persistRunArtifact({
            schemaVersion: AILA_RUN_ARTIFACT_SCHEMA_VERSION,
            artifactId: `${run.runId}:${step.stepId}:model_response`,
            conversationId,
            turnId: run.turnId,
            runId: run.runId,
            stepId: step.stepId,
            kind: 'model_response',
            createdAt: modelCallCompletedAt,
            contentType: 'application/json',
            data: {
              modelStepIndex,
              startedAt: modelCallStartedAt,
              completedAt: modelCallCompletedAt,
              durationMs: Math.max(0, modelCallCompletedAt - modelCallStartedAt),
              outcome: result.outcome,
              text: result.text,
              reasoning: result.reasoning,
              toolCalls: cloneAgentValue(result.toolCalls),
              resolvedToolResults: cloneAgentValue(result.resolvedToolResults),
              stepUsage: cloneAgentValue(result.stepUsage),
              ...(result.totalUsage ? { totalUsage: cloneAgentValue(result.totalUsage) } : {}),
              ...(result.error ? { error: result.error } : {}),
            },
          })
          return {
            outcome: result.outcome,
            toolCalls:
              result.outcome === 'completed'
                ? result.toolCalls.filter(
                    (toolCall) =>
                      !result.resolvedToolResults.some(
                        (resolved) => resolved.toolCallId === toolCall.id,
                      ),
                  )
                : [],
            ...(result.error ? { error: result.error } : {}),
          }
        },
        executeToolBatch: async ({ step, toolCalls }) => {
          activeStepId = step.stepId
          const modelStepIndex = Math.max(0, Math.floor(step.index / 2))
          const toolResults: Array<{
            toolCallId: string
            toolName: string
            result: string
            isError: boolean
          }> = []
          modelMessages.push({
            role: 'assistant',
            content: assistantTextByModelStep.get(modelStepIndex) ?? '',
            tool_calls: toolCalls.map(toChatToolCall),
          })

          for (const toolCall of toolCalls) {
            const toolStartedAt = Date.now()
            const target = summarizeToolTarget(toolCall.name, toolCall.args)
            if (target) toolTargets.set(toolCall.id, target)
            const definitionPresent = tools.some((definition) => definition.name === toolCall.name)
            await persistRunArtifact({
              schemaVersion: AILA_RUN_ARTIFACT_SCHEMA_VERSION,
              artifactId: `${run.runId}:${step.stepId}:tool_request:${toolCall.id}`,
              conversationId,
              turnId: run.turnId,
              runId: run.runId,
              stepId: step.stepId,
              kind: 'tool_request',
              createdAt: toolStartedAt,
              contentType: 'application/json',
              data: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                args: cloneAgentValue(toolCall.args),
                definitionPresent,
                ...(target ? { target } : {}),
              },
            })

            if (!definitionPresent) {
              const message = `Unknown tool "${toolCall.name}"`
              recordToolResult({
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: message,
                isError: true,
                builder,
                toolTargets,
                emitRunEvent,
                handlers,
                conversationId,
                assistantMessageId,
              })
              modelMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: message })
              toolResults.push({
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: message,
                isError: true,
              })
              await persistRunArtifact({
                schemaVersion: AILA_RUN_ARTIFACT_SCHEMA_VERSION,
                artifactId: `${run.runId}:${step.stepId}:tool_result:${toolCall.id}`,
                conversationId,
                turnId: run.turnId,
                runId: run.runId,
                stepId: step.stepId,
                kind: 'tool_result',
                createdAt: Date.now(),
                contentType: 'application/json',
                data: {
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  outcome: 'failed',
                  error: message,
                  startedAt: toolStartedAt,
                  completedAt: Date.now(),
                },
              })
              continue
            }

            emitRunEvent('tool.execution.started', {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              input: previewEventValue(toolCall.args),
              ...(target && { target }),
            })
            let output: unknown
            try {
              output = await executeTool(
                toolCall.name,
                cloneAgentToolArgs(toolCall.args),
                { ...toolContext, stepId: step.stepId, toolCallId: toolCall.id },
                toolRegistry,
              )
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              emitRunEvent('tool.execution.failed', {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                error: message,
                ...(toolTargets.get(toolCall.id) && {
                  target: toolTargets.get(toolCall.id),
                }),
              })
              recordToolResult({
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: message,
                isError: true,
                builder,
                toolTargets,
                emitRunEvent,
                handlers,
                conversationId,
                assistantMessageId,
              })
              modelMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: message })
              toolResults.push({
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: message,
                isError: true,
              })
              const toolCompletedAt = Date.now()
              await persistRunArtifact({
                schemaVersion: AILA_RUN_ARTIFACT_SCHEMA_VERSION,
                artifactId: `${run.runId}:${step.stepId}:tool_result:${toolCall.id}`,
                conversationId,
                turnId: run.turnId,
                runId: run.runId,
                stepId: step.stepId,
                kind: 'tool_result',
                createdAt: toolCompletedAt,
                contentType: 'application/json',
                data: {
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  outcome: 'failed',
                  error: message,
                  ...(toolTargets.get(toolCall.id) ? { target: toolTargets.get(toolCall.id) } : {}),
                  startedAt: toolStartedAt,
                  completedAt: toolCompletedAt,
                  durationMs: Math.max(0, toolCompletedAt - toolStartedAt),
                },
              })
              continue
            }

            const outputText = stringifyToolOutput(output)
            emitRunEvent('tool.execution.completed', {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: previewEventValue(output),
              ...(toolTargets.get(toolCall.id) && {
                target: toolTargets.get(toolCall.id),
              }),
            })
            const toolResult = await prepareToolResultForModel({
              store: toolResultStore,
              content: outputText,
              conversationId,
              messageId: assistantMessageId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              maxInlineChars: maxInlineToolResultChars,
              previewChars: toolResultPreviewChars,
            })
            recordToolResult({
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: toolResult.content,
              ...(toolResult.resultRef && { resultRef: toolResult.resultRef }),
              isError: false,
              builder,
              toolTargets,
              emitRunEvent,
              handlers,
              conversationId,
              assistantMessageId,
            })
            modelMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResult.content,
            })
            toolResults.push({
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: toolResult.content,
              isError: false,
            })
            const toolCompletedAt = Date.now()
            await persistRunArtifact({
              schemaVersion: AILA_RUN_ARTIFACT_SCHEMA_VERSION,
              artifactId: `${run.runId}:${step.stepId}:tool_result:${toolCall.id}`,
              conversationId,
              turnId: run.turnId,
              runId: run.runId,
              stepId: step.stepId,
              kind: 'tool_result',
              createdAt: toolCompletedAt,
              contentType: 'application/json',
              data: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                outcome: 'completed',
                output: outputText,
                modelContent: toolResult.content,
                ...(toolResult.resultRef
                  ? { resultRef: cloneAgentValue(toolResult.resultRef) }
                  : {}),
                ...(toolTargets.get(toolCall.id) ? { target: toolTargets.get(toolCall.id) } : {}),
                startedAt: toolStartedAt,
                completedAt: toolCompletedAt,
                durationMs: Math.max(0, toolCompletedAt - toolStartedAt),
              },
            })
          }

          await persistRunArtifact({
            schemaVersion: AILA_RUN_ARTIFACT_SCHEMA_VERSION,
            artifactId: `${run.runId}:${step.stepId}:tool_batch`,
            conversationId,
            turnId: run.turnId,
            runId: run.runId,
            stepId: step.stepId,
            kind: 'tool_batch',
            createdAt: Date.now(),
            contentType: 'application/json',
            data: {
              toolCallIds: toolCalls.map((toolCall) => toolCall.id),
              completedCount: toolResults.length,
              errorCount: toolResults.filter((result) => result.isError).length,
              aborted: signal.aborted,
            },
          })
          return signal.aborted
            ? { outcome: 'cancelled', error: 'abort_signal' }
            : { outcome: 'completed' }
        },
        handleToolBudgetExhausted: ({ step, toolCalls }) => {
          activeStepId = step.stepId
          for (const toolCall of toolCalls) {
            recordToolResult({
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: TOOL_BUDGET_EXHAUSTED_NOTICE,
              isError: true,
              builder,
              toolTargets,
              emitRunEvent,
              handlers,
              conversationId,
              assistantMessageId,
            })
          }
        },
      })

      if (loopResult.state.status === 'cancelled' || loopResult.state.status === 'failed') {
        const cancelled = loopResult.state.status === 'cancelled'
        const message = cancelled ? 'Aborted' : (loopResult.state.error ?? 'Agent run failed')
        if (latestLoopSnapshot) {
          await persistRunCheckpoint(latestLoopSnapshot, 'error', message)
        }
        await callAsyncStreamHandler(handlers.onError, {
          conversationId,
          messageId: assistantMessageId,
          error: message,
          message: builder.build(assistantMessageId, 'error', selection, message),
        })
        emitRunEvent(
          cancelled ? 'turn.cancelled' : 'turn.failed',
          cancelled ? { phase: 'completed', reason: 'abort_signal' } : { error: message },
        )
        return
      }
      if (loopResult.state.status === 'paused') return

      if (latestLoopSnapshot) await persistRunCheckpoint(latestLoopSnapshot, 'done')
      emitRunEvent('turn.completed', {
        usage: lastUsage ?? undefined,
        outputBlockCount: builder.blocks.length,
      })
      await callAsyncStreamHandler(handlers.onDone, {
        conversationId,
        messageId: assistantMessageId,
        message: builder.build(assistantMessageId, 'done', selection),
        usage: lastUsage ?? undefined,
      })
    } catch (error) {
      const isAbort = signal.aborted
      const message = isAbort ? 'Aborted' : error instanceof Error ? error.message : String(error)
      if (!runBoundaryPersisted) await persistPreLoopFailure(message)
      await callAsyncStreamHandler(handlers.onError, {
        conversationId,
        messageId: assistantMessageId,
        error: message,
        message: builder.build(assistantMessageId, 'error', selection, message),
      })
      emitRunEvent(
        isAbort ? 'turn.cancelled' : 'turn.failed',
        isAbort ? { phase: 'completed', reason: 'abort_signal' } : { error: message },
      )
    }
  }
}

export function createModelInfoResolver(
  modelRegistry: ModelRegistry = createModelRegistry(),
): (selection: ModelSelection) => ModelInfo {
  return (selection) => modelRegistry.getModelInfo(selection)
}

type ParsedModelToolCall = ModelCallToolCall

function runTransitionData(transition: RunTransition): Record<string, unknown> | undefined {
  const identity = {
    ...(transition.identity.parentRunId && {
      parentRunId: transition.identity.parentRunId,
    }),
    ...(transition.identity.originStepId && {
      originStepId: transition.identity.originStepId,
    }),
  }

  switch (transition.type) {
    case 'run.started':
      return { ...identity, mode: transition.mode }
    case 'run.resumed':
      return { ...identity, nextAction: transition.nextAction }
    case 'run.paused':
      return { ...identity, nextAction: transition.nextAction, wait: transition.wait }
    case 'run.completed':
      return Object.keys(identity).length > 0 ? identity : undefined
    case 'run.failed':
      return { ...identity, error: transition.error }
    case 'run.cancelled':
      return { ...identity, reason: transition.reason }
    case 'step.started':
    case 'step.completed':
      return {
        ...identity,
        kind: transition.step.kind,
        index: transition.step.index,
        attempt: transition.step.attempt,
        ...(transition.nextAction ? { nextAction: transition.nextAction } : {}),
      }
    case 'step.failed':
      return {
        ...identity,
        kind: transition.step.kind,
        index: transition.step.index,
        attempt: transition.step.attempt,
        error: transition.error,
      }
    case 'step.cancelled':
      return {
        ...identity,
        kind: transition.step.kind,
        index: transition.step.index,
        attempt: transition.step.attempt,
        reason: transition.reason,
      }
  }
}

type EmitRunEvent = (type: RunEventType, data?: Record<string, unknown>) => void

interface ToolStreamEventContext {
  builder: AssistantMessageBuilder
  toolTargets: Map<string, ToolActivityTarget>
  emitRunEvent: EmitRunEvent
  handlers: RunHandlers
  conversationId: string
  assistantMessageId: string
}

interface ToolInputStartContext extends Omit<ToolStreamEventContext, 'toolTargets'> {
  startedToolCalls: Set<string>
}

interface ToolInputCompletedContext extends ToolStreamEventContext {
  call: ParsedModelToolCall
  startedToolCalls: Set<string>
}

interface ToolResultContext extends ToolStreamEventContext {
  toolCallId: string
  toolName: string
  result: string
  resultRef?: PersistedToolResultRef
  isError: boolean
}

interface PreparedToolResult {
  content: string
  resultRef?: PersistedToolResultRef
}

function parseModelToolCall(id: string, name: string, input: unknown): ParsedModelToolCall {
  const args =
    input && typeof input === 'object' && !Array.isArray(input)
      ? cloneAgentToolArgs(input as Record<string, unknown>)
      : {}
  return {
    id,
    name,
    args,
    argsJson: JSON.stringify(args),
  }
}

function toChatToolCall(toolCall: ParsedModelToolCall): ToolCall {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: toolCall.argsJson,
    },
  }
}

function recordToolInputStart(
  input: {
    id: string
    name: string
    args: string
  } & ToolInputStartContext,
): void {
  const {
    id,
    name,
    args,
    builder,
    startedToolCalls,
    emitRunEvent,
    handlers,
    conversationId,
    assistantMessageId,
  } = input
  builder.startToolCall(id, name, args)
  if (startedToolCalls.has(id)) return
  startedToolCalls.add(id)
  emitRunEvent('tool.requested', {
    toolCallId: id,
    toolName: name,
  })
  callStreamHandler(handlers.onToolCallStart, {
    conversationId,
    messageId: assistantMessageId,
    toolCallId: id,
    name,
    arguments: args,
  })
}

function recordToolInputCompleted(input: ToolInputCompletedContext): void {
  const {
    call,
    builder,
    startedToolCalls,
    toolTargets,
    emitRunEvent,
    handlers,
    conversationId,
    assistantMessageId,
  } = input
  const target = summarizeToolTarget(call.name, call.args)
  if (target) toolTargets.set(call.id, target)
  builder.startToolCall(call.id, call.name, call.argsJson)
  emitRunEvent('tool.input.completed', {
    toolCallId: call.id,
    toolName: call.name,
    input: previewEventValue(call.args),
    ...(target && { target }),
  })
  if (startedToolCalls.has(call.id)) return
  startedToolCalls.add(call.id)
  emitRunEvent('tool.requested', {
    toolCallId: call.id,
    toolName: call.name,
  })
  callStreamHandler(handlers.onToolCallStart, {
    conversationId,
    messageId: assistantMessageId,
    toolCallId: call.id,
    name: call.name,
    arguments: call.argsJson,
  })
}

function recordToolResult(input: ToolResultContext): void {
  const {
    toolCallId,
    toolName,
    result,
    resultRef,
    isError,
    builder,
    toolTargets,
    emitRunEvent,
    handlers,
    conversationId,
    assistantMessageId,
  } = input
  builder.finishToolCall(toolCallId, result, isError, resultRef)
  emitRunEvent('tool.result.returned', {
    toolCallId,
    toolName,
    result: previewEventValue(result),
    ...(resultRef && { resultRef: cloneAgentValue(resultRef) }),
    isError,
    ...(toolTargets.get(toolCallId) && { target: toolTargets.get(toolCallId) }),
  })
  callStreamHandler(handlers.onToolCallResult, {
    conversationId,
    messageId: assistantMessageId,
    toolCallId,
    name: toolName,
    result,
    isError,
  })
}

async function prepareToolResultForModel(input: {
  store: ToolResultStore | null
  content: string
  conversationId: string
  messageId: string
  toolCallId: string
  toolName: string
  maxInlineChars: number
  previewChars: number
}): Promise<PreparedToolResult> {
  if (!input.store || input.content.length <= input.maxInlineChars) {
    return { content: input.content }
  }

  const resultRef = await input.store.persist({
    conversationId: input.conversationId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    content: input.content,
    previewChars: input.previewChars,
  })
  return {
    content: formatPersistedToolResultForModel(input.toolName, resultRef),
    resultRef,
  }
}

function formatPersistedToolResultForModel(
  toolName: string,
  resultRef: PersistedToolResultRef,
): string {
  const previewLine =
    resultRef.preview.length < resultRef.sizeChars
      ? `Preview (${resultRef.preview.length} of ${resultRef.sizeChars} chars):`
      : `Preview (${resultRef.preview.length} chars):`
  return [
    `<tool-result name="${escapeToolResultAttribute(toolName)}" persisted="true">`,
    `Full output stored at: ${resultRef.path}`,
    `Relative path: ${resultRef.relativePath}`,
    `Original size: ${resultRef.sizeChars} chars`,
    previewLine,
    resultRef.preview,
    '</tool-result>',
  ].join('\n')
}

function escapeToolResultAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function createUsageAccumulator(): UsageInfo {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
}

function addUsage(total: UsageInfo, usage: ModelStreamUsage): void {
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  total.promptTokens += inputTokens
  total.completionTokens += outputTokens
  total.totalTokens += usage.totalTokens ?? inputTokens + outputTokens
  total.modelCallCount = (total.modelCallCount ?? 0) + 1
  total.maxInputTokens = Math.max(total.maxInputTokens ?? 0, inputTokens)
  total.lastInputTokens = inputTokens
  total.lastOutputTokens = outputTokens
  setLastOptionalUsage(total, 'lastCacheReadTokens', usage.cacheReadTokens)
  setLastOptionalUsage(total, 'lastCacheWriteTokens', usage.cacheWriteTokens)
  setLastOptionalUsage(total, 'lastCacheMissTokens', usage.cacheMissTokens)
  addOptionalUsage(total, 'cacheReadTokens', usage.cacheReadTokens)
  addOptionalUsage(total, 'cacheWriteTokens', usage.cacheWriteTokens)
  addOptionalUsage(total, 'cacheMissTokens', usage.cacheMissTokens)
  addOptionalUsage(total, 'reasoningTokens', usage.reasoningTokens)
}

function usageInfo(usage: UsageInfo): UsageInfo {
  return { ...usage }
}

function usageInfoFromModelUsage(usage: ModelStreamUsage): UsageInfo {
  const promptTokens = usage.inputTokens ?? 0
  const completionTokens = usage.outputTokens ?? 0
  const info: UsageInfo = {
    promptTokens,
    completionTokens,
    totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
    modelCallCount: 1,
    maxInputTokens: promptTokens,
    lastInputTokens: promptTokens,
    lastOutputTokens: completionTokens,
  }
  setLastOptionalUsage(info, 'lastCacheReadTokens', usage.cacheReadTokens)
  setLastOptionalUsage(info, 'lastCacheWriteTokens', usage.cacheWriteTokens)
  setLastOptionalUsage(info, 'lastCacheMissTokens', usage.cacheMissTokens)
  addOptionalUsage(info, 'cacheReadTokens', usage.cacheReadTokens)
  addOptionalUsage(info, 'cacheWriteTokens', usage.cacheWriteTokens)
  addOptionalUsage(info, 'cacheMissTokens', usage.cacheMissTokens)
  addOptionalUsage(info, 'reasoningTokens', usage.reasoningTokens)
  return info
}

function setLastOptionalUsage(
  total: UsageInfo,
  key: 'lastCacheReadTokens' | 'lastCacheWriteTokens' | 'lastCacheMissTokens',
  value: number | null | undefined,
): void {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    total[key] = Math.round(value)
    return
  }
  delete total[key]
}

function addOptionalUsage(
  total: UsageInfo,
  key: 'cacheReadTokens' | 'cacheWriteTokens' | 'cacheMissTokens' | 'reasoningTokens',
  value: number | null | undefined,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return
  total[key] = (total[key] ?? 0) + Math.round(value)
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output == null) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function previewEventValue(value: unknown): { preview: string; size: number } {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
  return {
    preview: text.length > EVENT_PREVIEW_CHARS ? `${text.slice(0, EVENT_PREVIEW_CHARS)}...` : text,
    size: text.length,
  }
}

function inspectableModelDescriptor(descriptor: ModelDescriptor): Record<string, unknown> {
  const { headers, baseUrl, ...safe } = cloneAgentValue(descriptor)
  let safeBaseUrl = baseUrl
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl)
      parsed.username = ''
      parsed.password = ''
      parsed.search = ''
      parsed.hash = ''
      safeBaseUrl = parsed.toString()
    } catch {
      safeBaseUrl = '[invalid-or-redacted-url]'
    }
  }
  return {
    ...safe,
    ...(safeBaseUrl ? { baseUrl: safeBaseUrl } : {}),
    ...(headers ? { headerNames: Object.keys(headers).sort() } : {}),
  }
}

function cloneAgentValue<T>(value: T): T {
  return structuredClone(value)
}

function cloneAgentMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return cloneAgentValue([...messages])
}

function cloneAgentSettings(settings: Settings): Settings {
  return cloneAgentValue(settings)
}

function cloneAgentWorkspaceRoots(
  roots: ToolContext['workspaceRoots'],
): ToolContext['workspaceRoots'] {
  return roots === undefined ? undefined : cloneAgentValue(roots)
}

function cloneAgentToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return cloneAgentValue(args)
}

function callStreamHandler<TEvent>(handler: (event: TEvent) => void, event: TEvent): void {
  handler(cloneAgentValue(event))
}

async function callAsyncStreamHandler<TEvent>(
  handler: (event: TEvent) => MaybePromise<void>,
  event: TEvent,
): Promise<void> {
  await handler(cloneAgentValue(event))
}

function buildToolSchemas(toolRegistry?: ToolRegistry): ModelStreamToolDefinition[] {
  return getToolDefinitions(toolRegistry).map((td) => ({
    name: td.function.name,
    description: td.function.description,
    parameters: td.function.parameters,
  }))
}
