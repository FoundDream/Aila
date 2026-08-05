import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  DurableRunExecutor,
  ImageSideChannelBlock,
  ModelCallToolCall,
  ModelDescriptor,
  ModelInfo,
  ModelSelection,
  PersistedToolResultRef,
  RunEvent,
  RunEventType,
  RunHandlers,
  RunIdentity,
  RunPayloadKind,
  Settings,
  ToolActivityTarget,
  ToolAuthorization,
  ToolCall,
  ToolContext,
  ToolRegistry,
  UsageInfo,
} from '@aila/agent'
import {
  authorizeTool,
  executeAuthorizedTool,
  getToolDefinitions,
  summarizeToolTarget,
} from '@aila/agent/host'
import {
  createRunCursor,
  defaultAgentRuntime,
  type RunTransition,
  reduceRunTransition,
} from '@aila/agent/internal'
import { AssistantMessageBuilder } from './assistant-message-builder'
import type { NodeAuthInput } from './auth'
import { type CredentialResolver, createCredentialResolver } from './credential-resolver'
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

function isProviderContextOverflow(error: string | undefined): boolean {
  if (!error) return false
  return /context.{0,20}(length|window|limit)|too many tokens|maximum.{0,12}tokens|token.{0,12}limit/i.test(
    error,
  )
}

export interface DurableRunExecutorOptions extends NodeAuthInput {
  modelRegistry?: ModelRegistry
  modelRegistryOptions?: CreateModelRegistryInput
  protocolRegistry?: ProtocolRegistry
  protocolAdapters?: ProtocolAdapter[]
  modelStreamClient?: ModelStreamClient
  useNativeProtocols?: boolean
  credentialResolver?: CredentialResolver
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
    createModelRegistry(
      options.modelRegistryOptions ?? {
        providers: options.providers,
        connections: options.settings?.connections,
      },
    )
  const protocolRegistry =
    options.protocolRegistry ?? createProtocolRegistry(options.protocolAdapters)
  const credentialResolver =
    options.credentialResolver ?? createCredentialResolver({ ...options, modelRegistry })
  const modelStreamClient =
    options.modelStreamClient ??
    createDefaultModelStreamClient({
      protocolRegistry,
      modelRegistry,
      imageDir: options.imageDir,
      useNativeProtocols: options.useNativeProtocols,
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
      runSnapshot,
      sessionLeafId: requestSessionLeafId,
      resumeState,
      messages: requestMessages,
      contextPlan: requestContextPlan,
      prepareModelStep,
      getSteeringMessages,
      getFollowUpMessages,
      selection: requestSelection,
      signal,
      onRunEvent,
      onSavePoint,
      appendSessionEntry,
      putBlob,
      workspaceRoots: requestWorkspaceRoots,
      shellCwd,
      path,
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

    const messages = cloneAgentMessages(resumeState?.messages ?? requestMessages)
    const sessionLeafId =
      runSnapshot?.sessionLeafId ?? requestSessionLeafId ?? `session:${conversationId}`
    const selection = cloneAgentValue(requestSelection)
    let contextPlan = cloneAgentValue(resumeState?.contextPlan ?? requestContextPlan)
    const workspaceRoots = cloneAgentWorkspaceRoots(requestWorkspaceRoots)
    const builder = new AssistantMessageBuilder(resumeState?.assistantMessage?.blocks)
    let lastUsage: UsageInfo | null = runSnapshot?.usage ? cloneAgentValue(runSnapshot.usage) : null
    const toolTargets = new Map<string, ToolActivityTarget>()
    const run: RunIdentity = cloneAgentValue(
      runSnapshot?.identity ??
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
    const reachSavePoint = async (
      reason: Parameters<NonNullable<typeof onSavePoint>>[0],
    ): Promise<void> => {
      await onSavePoint?.(reason)
    }
    let runBoundaryPersisted = false
    const persistPreLoopFailure = async (message: string): Promise<void> => {
      if (runBoundaryPersisted) return
      runBoundaryPersisted = true
      const timestamp = Date.now()
      const loop = cloneAgentValue(runSnapshot?.loop ?? createRunCursor(run, loopMode))
      if (!runSnapshot) {
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
    }

    const settings = cloneAgentSettings(
      requestSettings ??
        options.settings ??
        options.loadSettings?.() ?? { apiKeys: {}, defaultModel: null },
    )
    for (const connection of settings.connections ?? []) {
      modelRegistry.registerConnection(connection)
    }
    const descriptor = modelRegistry.resolve(selection)
    if (!runSnapshot) {
      emitRunEvent('turn.started', {
        providerId: selection.providerId,
        modelId: selection.modelId,
        provider: descriptor.provider,
        api: descriptor.api,
        inputMessageCount: messages.length,
        // Stamped so run snapshots can be rebuilt from the journal alone.
        maxToolSteps,
        sessionLeafId,
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

    try {
      const totalUsage = runSnapshot?.usage
        ? cloneAgentValue(runSnapshot.usage)
        : createUsageAccumulator()
      const bridged = runSnapshot
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

      const toolContext: ToolContext = {
        settings,
        conversationId,
        messageId: assistantMessageId,
        turnId: run.turnId,
        runId: run.runId,
        workspaceRoots,
        shellCwd,
        path,
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
        Object.entries(resumeState?.modelStepOutputs ?? {}).map(([index, text]) => [
          Number(index),
          text,
        ]),
      )
      const assistantMessageByModelStep = new Map<
        number,
        Extract<ChatMessage, { role: 'assistant' }>
      >()
      const responseMessagesByModelStep = new Map<number, ChatMessage[]>()
      const persistRunPayload = async (input: {
        kind: RunPayloadKind
        label: string
        stepId: string
        data: unknown
        modelMessage?: ChatMessage
        modelMessages?: ChatMessage[]
      }): Promise<void> => {
        if (!appendSessionEntry) return
        const timestamp = Date.now()
        const payloadRef = await putBlob?.({
          contentType: 'application/json',
          data: cloneAgentValue(input.data),
        })
        await appendSessionEntry({
          type: 'run.payload',
          timestamp,
          turnId: run.turnId,
          runId: run.runId,
          stepId: input.stepId,
          ...(payloadRef ? { payloadRef: cloneAgentValue(payloadRef) } : {}),
          data: {
            kind: input.kind,
            label: input.label,
            ...(input.modelMessage ? { modelMessage: cloneAgentValue(input.modelMessage) } : {}),
            ...(input.modelMessages
              ? { modelMessages: cloneAgentMessages(input.modelMessages) }
              : {}),
            assistantMessage: builder.build(assistantMessageId, 'streaming', selection),
          },
        })
      }
      const initialSnapshot = runSnapshot?.loop ? cloneAgentValue(runSnapshot.loop) : undefined
      if (initialSnapshot) initialSnapshot.state.mode = loopMode
      const toolCallsByModelStep = new Map<number, ParsedModelToolCall[]>()
      const toolResultsByModelStep = new Map<
        number,
        Array<{
          toolCallId: string
          toolName: string
          result: string
          isError: boolean
        }>
      >()
      if (runSnapshot) {
        const snapshotCalls = runSnapshot.loop.toolBatchCalls ?? runSnapshot.loop.pendingToolCalls
        if (snapshotCalls.length > 0) {
          toolCallsByModelStep.set(
            Math.max(0, runSnapshot.loop.modelStepIndex - 1),
            cloneAgentValue(snapshotCalls),
          )
        }
      }

      const loopResult = await defaultAgentRuntime.run<ChatMessage[]>({
        identity: run,
        signal,
        maxToolSteps,
        ...(initialSnapshot ? { initialSnapshot } : {}),
        ...(options.createStepId
          ? {
              createStepId: () => options.createStepId?.() ?? randomUUID(),
            }
          : {}),
        ...(getSteeringMessages || getFollowUpMessages
          ? {
              inputQueue: {
                dequeueSteering: async () => {
                  const queued = await getSteeringMessages?.()
                  return queued && queued.length > 0 ? cloneAgentMessages(queued) : undefined
                },
                dequeueFollowUp: async () => {
                  const queued = await getFollowUpMessages?.()
                  return queued && queued.length > 0 ? cloneAgentMessages(queued) : undefined
                },
                apply: (queued: ChatMessage[]) => {
                  modelMessages.push(...cloneAgentMessages(queued))
                },
              },
            }
          : {}),
        policy: { mode: loopMode },
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
        prepareModelStep: async ({ modelStepIndex, toolsEnabled, reason }) => {
          const prepared = await prepareModelStep?.({
            conversationId,
            run: cloneAgentValue(run),
            modelStepIndex,
            reason,
            toolsEnabled,
            messages: cloneAgentMessages(modelMessages),
            ...(contextPlan ? { contextPlan: cloneAgentValue(contextPlan) } : {}),
          })
          if (prepared?.messages) {
            modelMessages.splice(0, modelMessages.length, ...cloneAgentMessages(prepared.messages))
          }
          if (prepared?.contextPlan) contextPlan = cloneAgentValue(prepared.contextPlan)
        },
        executeCompactStep: async ({ step, reason, signal: compactSignal }) => {
          activeStepId = step.stepId
          const beforeChars = JSON.stringify(modelMessages).length
          const toolMessageIndexes = modelMessages.flatMap((message, index) =>
            message.role === 'tool' ? [index] : [],
          )
          const compactable = toolMessageIndexes.slice(
            0,
            Math.max(0, toolMessageIndexes.length - 2),
          )
          for (const index of compactable) {
            const message = modelMessages[index]
            if (message?.role !== 'tool') continue
            modelMessages[index] = {
              role: 'tool',
              tool_call_id: message.tool_call_id,
              content:
                '[Tool result compacted after provider context overflow; rerun the tool if needed.]',
            }
          }
          const afterChars = JSON.stringify(modelMessages).length
          await persistRunPayload({
            kind: 'compaction',
            label: 'Context compaction',
            stepId: step.stepId,
            data: {
              reason,
              beforeChars,
              afterChars,
              compactedToolResultCount: compactable.length,
            },
          })
          await reachSavePoint('compaction')
          return compactSignal.aborted
            ? { outcome: 'cancelled', error: 'abort_signal' }
            : { outcome: 'completed' }
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
          await persistRunPayload({
            kind: 'model_request',
            label: 'Model request',
            stepId: step.stepId,
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
          const credential = await credentialResolver.resolve({ descriptor, settings })
          const result = await modelCallExecutor.execute(
            {
              descriptor,
              apiKey: credential.value,
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
                case 'response-messages':
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
          const fallbackResponseModelMessage: Extract<ChatMessage, { role: 'assistant' }> = {
            role: 'assistant',
            content: result.text,
            ...(result.toolCalls.length > 0
              ? { tool_calls: result.toolCalls.map(toChatToolCall) }
              : {}),
          }
          const responseModelMessages =
            result.responseMessages && result.responseMessages.length > 0
              ? cloneAgentMessages(result.responseMessages)
              : [
                  fallbackResponseModelMessage,
                  ...result.resolvedToolResults.map(
                    (resolved): ChatMessage => ({
                      role: 'tool',
                      tool_call_id: resolved.toolCallId,
                      content: resolved.error ?? stringifyToolOutput(resolved.output),
                    }),
                  ),
                ]
          const responseModelMessage =
            responseModelMessages.find(
              (message): message is Extract<ChatMessage, { role: 'assistant' }> =>
                message.role === 'assistant',
            ) ?? fallbackResponseModelMessage
          assistantMessageByModelStep.set(modelStepIndex, cloneAgentValue(responseModelMessage))
          responseMessagesByModelStep.set(modelStepIndex, cloneAgentMessages(responseModelMessages))
          await persistRunPayload({
            kind: 'model_response',
            label: `Model response · ${result.outcome}`,
            stepId: step.stepId,
            modelMessage: responseModelMessage,
            modelMessages: responseModelMessages,
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
          await reachSavePoint('model_response')
          const pendingToolCalls =
            result.outcome === 'completed'
              ? result.toolCalls.filter(
                  (toolCall) =>
                    !result.resolvedToolResults.some(
                      (resolved) => resolved.toolCallId === toolCall.id,
                    ),
                )
              : []
          if (pendingToolCalls.length === 0) {
            modelMessages.push(...cloneAgentMessages(responseModelMessages))
          }
          toolCallsByModelStep.set(modelStepIndex, cloneAgentValue(pendingToolCalls))
          return {
            outcome: result.outcome,
            toolCalls: pendingToolCalls,
            ...(result.error ? { error: result.error } : {}),
            ...(result.outcome === 'failed' && isProviderContextOverflow(result.error)
              ? {
                  nextAction: {
                    type: 'compact' as const,
                    reason: 'provider_overflow' as const,
                  },
                }
              : {}),
          }
        },
        prepareToolStep: async ({ toolCall, waitFor }) => {
          const definitionPresent = tools.some((definition) => definition.name === toolCall.name)
          if (!definitionPresent) {
            return { outcome: 'rejected', error: `Unknown tool "${toolCall.name}"` }
          }
          let authorization: ToolAuthorization
          try {
            authorization = await authorizeTool(
              toolCall.name,
              cloneAgentToolArgs(toolCall.args),
              { ...toolContext, toolCallId: toolCall.id },
              toolRegistry,
            )
          } catch (error) {
            return {
              outcome: 'rejected',
              error: error instanceof Error ? error.message : String(error),
            }
          }
          if (authorization.decision.action === 'deny') {
            return {
              outcome: 'rejected',
              error:
                authorization.decision.reason ?? `tool "${toolCall.name}" was denied by policy`,
            }
          }
          if (authorization.decision.action === 'ask') {
            if (!onToolApproval) {
              return {
                outcome: 'rejected',
                error: `tool "${toolCall.name}" requires approval but no approval host is available`,
              }
            }
            const approved = await waitFor(
              {
                reason: 'approval',
                requestId: `approval:${run.runId}:${toolCall.id}`,
                detail: `Approval required for ${toolCall.name}`,
              },
              async () => {
                await reachSavePoint('approval')
                return onToolApproval(cloneAgentValue(authorization.request))
              },
            )
            if (!approved) {
              return {
                outcome: 'rejected',
                error: `tool "${toolCall.name}" was rejected by user`,
              }
            }
          }
          return { outcome: 'ready' }
        },
        executeToolStep: async ({
          step,
          toolCall,
          toolCallIndex,
          toolCallCount,
          modelStepIndex,
          preparation,
          signal: toolSignal,
        }) => {
          activeStepId = step.stepId
          const batchCalls = toolCallsByModelStep.get(modelStepIndex) ?? [toolCall]
          if (toolCallIndex === 0) {
            const assistantMessage =
              assistantMessageByModelStep.get(modelStepIndex) ??
              ({
                role: 'assistant',
                content: assistantTextByModelStep.get(modelStepIndex) ?? '',
                tool_calls: batchCalls.map(toChatToolCall),
              } satisfies Extract<ChatMessage, { role: 'assistant' }>)
            const alreadyPersisted = modelMessages.some(
              (message) =>
                message.role === 'assistant' &&
                message.tool_calls?.some((call) =>
                  batchCalls.some((batch) => batch.id === call.id),
                ),
            )
            if (!alreadyPersisted) modelMessages.push(cloneAgentValue(assistantMessage))
            for (const responseMessage of responseMessagesByModelStep.get(modelStepIndex) ?? []) {
              if (responseMessage.role !== 'tool') continue
              const existing = modelMessages.some(
                (message) =>
                  message.role === 'tool' && message.tool_call_id === responseMessage.tool_call_id,
              )
              if (!existing) modelMessages.push(cloneAgentValue(responseMessage))
            }
          }
          let toolResults = toolResultsByModelStep.get(modelStepIndex)
          if (!toolResults) {
            toolResults = batchCalls.flatMap((call) => {
              const existing = modelMessages.find(
                (message) => message.role === 'tool' && message.tool_call_id === call.id,
              )
              return existing?.role === 'tool'
                ? [
                    {
                      toolCallId: call.id,
                      toolName: call.name,
                      result: existing.content,
                      isError: false,
                    },
                  ]
                : []
            })
            toolResultsByModelStep.set(modelStepIndex, toolResults)
          }

          const toolStartedAt = Date.now()
          const target = summarizeToolTarget(toolCall.name, toolCall.args)
          if (target) toolTargets.set(toolCall.id, target)
          const definitionPresent = tools.some((definition) => definition.name === toolCall.name)
          await persistRunPayload({
            kind: 'tool_request',
            label: `Tool request · ${toolCall.name}`,
            stepId: step.stepId,
            data: {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args: cloneAgentValue(toolCall.args),
              definitionPresent,
              authorization: preparation.outcome,
              ...(preparation.error ? { authorizationError: preparation.error } : {}),
              ...(target ? { target } : {}),
            },
          })

          if (preparation.outcome === 'rejected') {
            const message = preparation.error ?? `tool "${toolCall.name}" was rejected`
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
            await persistRunPayload({
              kind: 'tool_result',
              label: `Tool result · ${toolCall.name} · failed`,
              stepId: step.stepId,
              modelMessage: { role: 'tool', tool_call_id: toolCall.id, content: message },
              data: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                outcome: 'failed',
                error: message,
                startedAt: toolStartedAt,
                completedAt: Date.now(),
              },
            })
          } else {
            emitRunEvent('tool.execution.started', {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              input: previewEventValue(toolCall.args),
              ...(target && { target }),
            })
            let output: unknown
            try {
              output = await executeAuthorizedTool(
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
              await persistRunPayload({
                kind: 'tool_result',
                label: `Tool result · ${toolCall.name} · failed`,
                stepId: step.stepId,
                modelMessage: { role: 'tool', tool_call_id: toolCall.id, content: message },
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
            }

            if (output !== undefined) {
              const outputText = stringifyToolOutput(output)
              emitRunEvent('tool.execution.completed', {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: previewEventValue(output),
                ...(toolTargets.get(toolCall.id) ? { target: toolTargets.get(toolCall.id) } : {}),
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
              await persistRunPayload({
                kind: 'tool_result',
                label: `Tool result · ${toolCall.name} · completed`,
                stepId: step.stepId,
                modelMessage: {
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: toolResult.content,
                },
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
          }

          if (toolCallIndex === toolCallCount - 1) {
            await persistRunPayload({
              kind: 'tool_batch',
              label: 'Tool batch summary',
              stepId: step.stepId,
              data: {
                toolCallIds: batchCalls.map((call) => call.id),
                completedCount: toolResults.length,
                errorCount: toolResults.filter((result) => result.isError).length,
                aborted: toolSignal.aborted,
              },
            })
          }
          await reachSavePoint('tool_result')
          return toolSignal.aborted
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
        await callAsyncStreamHandler(handlers.onError, {
          conversationId,
          messageId: assistantMessageId,
          error: message,
          message: builder.build(assistantMessageId, 'error', selection, message),
        })
        await reachSavePoint('terminal')
        emitRunEvent(
          cancelled ? 'turn.cancelled' : 'turn.failed',
          cancelled ? { phase: 'completed', reason: 'abort_signal' } : { error: message },
        )
        return
      }
      if (loopResult.state.status === 'paused') return

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
      await reachSavePoint('terminal')
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
      await reachSavePoint('terminal')
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
        ...(transition.step.toolCallId ? { toolCallId: transition.step.toolCallId } : {}),
        ...(transition.nextAction ? { nextAction: transition.nextAction } : {}),
      }
    case 'step.failed':
      return {
        ...identity,
        kind: transition.step.kind,
        index: transition.step.index,
        attempt: transition.step.attempt,
        ...(transition.step.toolCallId ? { toolCallId: transition.step.toolCallId } : {}),
        error: transition.error,
        ...(transition.nextAction ? { nextAction: transition.nextAction } : {}),
      }
    case 'step.cancelled':
      return {
        ...identity,
        kind: transition.step.kind,
        index: transition.step.index,
        attempt: transition.step.attempt,
        ...(transition.step.toolCallId ? { toolCallId: transition.step.toolCallId } : {}),
        reason: transition.reason,
        ...(transition.nextAction ? { nextAction: transition.nextAction } : {}),
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
