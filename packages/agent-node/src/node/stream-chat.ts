import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@aila/agent'
import {
  type AgentEvent,
  type AgentEventType,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  type ChatMessage,
  type ImageSideChannelBlock,
  type ModelDescriptor,
  type ModelInfo,
  type ModelSelection,
  modelSupportsVision,
  type PersistedBlock,
  type PersistedImageBlock,
  type PersistedMessage,
  type PersistedToolCallBlock,
  type PersistedToolResultRef,
  type RuntimeStreamChat,
  type StreamHandlers,
  type ToolActivityTarget,
  type ToolCall,
  type ToolContext,
  type ToolRegistry,
  type UsageInfo,
  type UserContentPart,
} from '@aila/agent'
import { executeTool, getToolDefinitions, summarizeToolTarget } from '@aila/agent/host'
import { MissingApiKeyError, type NodeAuthInput, requireApiKey } from './auth'
import { createDefaultModelStreamClient } from './default-model-stream'
import { imageNameFromUrl } from './image-store'
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
 * Override per instance via ProviderStreamChatOptions.maxSteps.
 */
const DEFAULT_MAX_TOOL_STEPS = 50

const TOOL_BUDGET_EXHAUSTED_NOTICE =
  'You have reached the maximum number of tool-using steps for this turn. ' +
  'Do not request any more tools. Using the results you already have, give the ' +
  'user a clear final answer: what you did, the current state, and any remaining ' +
  'next steps they should take.'

const VISION_BRIDGE_SYSTEM_PROMPT =
  'You inspect image attachments for a downstream text-only model. ' +
  'Return concise, factual Markdown. Include visible text/OCR, important objects, layout, ' +
  'tables/charts/UI structure, and details that could matter for answering the user.'
const VISION_BRIDGE_PROMPT_VERSION = 1
const VISION_ANALYSIS_CACHE_SCHEMA_VERSION = 1

export interface ProviderStreamChatOptions extends NodeAuthInput {
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
}

export function createProviderStreamChat(
  options: ProviderStreamChatOptions = {},
): RuntimeStreamChat {
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
      messages: requestMessages,
      contextPlan,
      selection: requestSelection,
      signal,
      onAgentEvent,
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

    const messages = cloneAgentMessages(requestMessages)
    const selection = cloneAgentValue(requestSelection)
    const workspaceRoots = cloneAgentWorkspaceRoots(requestWorkspaceRoots)
    const builder = new AssistantBuilder()
    let lastUsage: UsageInfo | null = null
    const toolTargets = new Map<string, ToolActivityTarget>()

    const emitAgentEvent = (type: AgentEventType, data?: Record<string, unknown>): void => {
      const event: AgentEvent = {
        timestamp: Date.now(),
        conversationId,
        messageId: assistantMessageId,
        type,
        ...(data && { data: cloneAgentValue(data) }),
      }
      onAgentEvent?.(cloneAgentValue(event))
    }

    const settings = cloneAgentSettings(
      requestSettings ??
        options.settings ??
        options.loadSettings?.() ?? { apiKeys: {}, defaultModel: null },
    )
    const descriptor = modelRegistry.resolve(selection)
    emitAgentEvent('turn.started', {
      providerId: selection.providerId,
      modelId: selection.modelId,
      provider: descriptor.provider,
      api: descriptor.api,
      inputMessageCount: messages.length,
    })

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
      await callAsyncStreamHandler(handlers.onError, {
        conversationId,
        messageId: assistantMessageId,
        error: message,
        message: builder.build(assistantMessageId, 'error', selection, message),
      })
      emitAgentEvent('turn.failed', { error: message })
      return
    }

    try {
      const totalUsage = createUsageAccumulator()
      const bridged = await bridgeImagesForTextOnlyModel({
        messages,
        descriptor,
        selection,
        settings,
        modelRegistry,
        modelStreamClient,
        authInput: options,
        signal,
        emitAgentEvent,
        dataDir: options.dataDir,
        imageDir: options.imageDir,
      })
      for (const usage of bridged.usage) {
        addUsage(totalUsage, usage)
        lastUsage = usageInfo(totalUsage)
      }

      const tools = buildTools(
        {
          settings,
          conversationId,
          messageId: assistantMessageId,
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
        },
        emitAgentEvent,
        toolRegistry,
        toolTargets,
      )
      const modelMessages = cloneAgentMessages(bridged.messages)
      const startedToolCalls = new Set<string>()

      // Run up to maxToolSteps tool-enabled steps, plus one final tool-free step
      // (step === maxToolSteps) that lets the model wrap up gracefully if it has
      // exhausted the budget but still wants to keep going.
      let toolBudgetNoticeSent = false
      for (let step = 0; step <= maxToolSteps; step += 1) {
        const toolsWithdrawn = step >= maxToolSteps
        if (toolsWithdrawn && !toolBudgetNoticeSent) {
          toolBudgetNoticeSent = true
          modelMessages.push({ role: 'system', content: TOOL_BUDGET_EXHAUSTED_NOTICE })
        }
        const assistantText: string[] = []
        const stepToolCalls: ParsedModelToolCall[] = []
        const externallyResolvedToolCalls = new Set<string>()
        const result = modelStreamClient.stream({
          descriptor,
          apiKey,
          conversationId,
          messages: cloneAgentMessages(modelMessages),
          ...(contextPlan ? { contextPlan } : {}),
          ...(settings.promptCache ? { cache: settings.promptCache } : {}),
          tools: toolsWithdrawn ? [] : tools,
          signal,
          step,
        })

        for await (const part of result) {
          switch (part.type) {
            case 'text-delta':
              assistantText.push(part.text)
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
                emitAgentEvent,
                handlers,
                conversationId,
                assistantMessageId,
              })
              break
            case 'tool-input-delta':
              builder.appendToolCallArgs(part.id, part.delta)
              emitAgentEvent('tool.input.delta', {
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
            case 'tool-call': {
              const parsed = parseModelToolCall(part.toolCallId, part.toolName, part.input)
              stepToolCalls.push(parsed)
              recordToolInputCompleted({
                call: parsed,
                builder,
                startedToolCalls,
                toolTargets,
                emitAgentEvent,
                handlers,
                conversationId,
                assistantMessageId,
              })
              break
            }
            case 'tool-result': {
              externallyResolvedToolCalls.add(part.toolCallId)
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
                emitAgentEvent,
                handlers,
                conversationId,
                assistantMessageId,
              })
              break
            }
            case 'tool-error': {
              externallyResolvedToolCalls.add(part.toolCallId)
              const message = part.error instanceof Error ? part.error.message : String(part.error)
              recordToolResult({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                result: message,
                isError: true,
                builder,
                toolTargets,
                emitAgentEvent,
                handlers,
                conversationId,
                assistantMessageId,
              })
              break
            }
            case 'finish-step':
              if (part.usage) {
                addUsage(totalUsage, part.usage)
                lastUsage = usageInfo(totalUsage)
              }
              break
            case 'finish':
              if (part.totalUsage) {
                const providerTotal = usageInfoFromModelUsage(part.totalUsage)
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
              break
            case 'abort':
              await callAsyncStreamHandler(handlers.onError, {
                conversationId,
                messageId: assistantMessageId,
                error: 'Aborted',
                message: builder.build(assistantMessageId, 'error', selection, 'Aborted'),
              })
              emitAgentEvent('turn.cancelled', { phase: 'completed', reason: 'abort_signal' })
              return
            case 'error': {
              const message = part.error instanceof Error ? part.error.message : String(part.error)
              await callAsyncStreamHandler(handlers.onError, {
                conversationId,
                messageId: assistantMessageId,
                error: message,
                message: builder.build(assistantMessageId, 'error', selection, message),
              })
              emitAgentEvent('turn.failed', { error: message })
              return
            }
          }
        }

        const unresolvedToolCalls = stepToolCalls.filter(
          (toolCall) => !externallyResolvedToolCalls.has(toolCall.id),
        )
        if (unresolvedToolCalls.length === 0) break

        if (toolsWithdrawn) {
          // Budget already withdrawn, but the model still emitted tool calls. Close
          // them out as errors so the persisted message has no dangling "running"
          // calls, then finish the turn normally instead of throwing.
          for (const toolCall of unresolvedToolCalls) {
            recordToolResult({
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: TOOL_BUDGET_EXHAUSTED_NOTICE,
              isError: true,
              builder,
              toolTargets,
              emitAgentEvent,
              handlers,
              conversationId,
              assistantMessageId,
            })
          }
          break
        }

        modelMessages.push({
          role: 'assistant',
          content: assistantText.join(''),
          tool_calls: unresolvedToolCalls.map(toChatToolCall),
        })

        for (const toolCall of unresolvedToolCalls) {
          const tool = tools.find((td) => td.name === toolCall.name)
          if (!tool) {
            const message = `Unknown tool "${toolCall.name}"`
            recordToolResult({
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: message,
              isError: true,
              builder,
              toolTargets,
              emitAgentEvent,
              handlers,
              conversationId,
              assistantMessageId,
            })
            modelMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: message })
            continue
          }

          try {
            const output = await tool.execute(toolCall.args, { toolCallId: toolCall.id })
            const toolResult = await prepareToolResultForModel({
              store: toolResultStore,
              content: stringifyToolOutput(output),
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
              emitAgentEvent,
              handlers,
              conversationId,
              assistantMessageId,
            })
            modelMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResult.content,
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            recordToolResult({
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: message,
              isError: true,
              builder,
              toolTargets,
              emitAgentEvent,
              handlers,
              conversationId,
              assistantMessageId,
            })
            modelMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: message })
          }
        }
      }

      emitAgentEvent('turn.completed', {
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
      await callAsyncStreamHandler(handlers.onError, {
        conversationId,
        messageId: assistantMessageId,
        error: message,
        message: builder.build(assistantMessageId, 'error', selection, message),
      })
      emitAgentEvent(
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

interface VisionBridgeInput {
  messages: ChatMessage[]
  descriptor: ModelDescriptor
  selection: ModelSelection
  settings: Settings
  modelRegistry: ModelRegistry
  modelStreamClient: ModelStreamClient
  authInput: NodeAuthInput
  signal: AbortSignal
  emitAgentEvent: EmitAgentEvent
  dataDir?: string
  imageDir?: string
}

interface VisionBridgeResult {
  messages: ChatMessage[]
  usage: ModelStreamUsage[]
}

async function bridgeImagesForTextOnlyModel(input: VisionBridgeInput): Promise<VisionBridgeResult> {
  const imageMessageIndex = lastUserImageMessageIndex(input.messages)
  if (imageMessageIndex < 0 || modelSupportsVision(input.descriptor)) {
    return { messages: cloneAgentMessages(input.messages), usage: [] }
  }

  const mode = input.settings.visionFallbackMode ?? 'auto'
  if (mode === 'disabled' || mode === 'ask') {
    return replaceImagesWithText(
      input.messages,
      mode === 'ask'
        ? 'Vision fallback is set to ask before analyzing images.'
        : 'Vision fallback is disabled.',
    )
  }

  const visionSelection = input.settings.defaultVisionModel
  if (!visionSelection) {
    throw new Error(
      `Model ${input.selection.providerId}:${input.selection.modelId} cannot inspect image attachments. Configure a Default Vision Model or choose a vision-capable chat model.`,
    )
  }

  const visionDescriptor = input.modelRegistry.resolve(visionSelection)
  if (!modelSupportsVision(visionDescriptor)) {
    throw new Error(
      `Default Vision Model ${visionSelection.providerId}:${visionSelection.modelId} is not marked as vision-capable.`,
    )
  }
  const visionApiKey = requireApiKey(visionDescriptor, {
    ...input.authInput,
    settings: input.settings,
  })
  const imageCount = latestImageCount(input.messages[imageMessageIndex])

  input.emitAgentEvent('vision.bridge.started', {
    providerId: visionSelection.providerId,
    modelId: visionSelection.modelId,
    provider: visionDescriptor.provider,
    api: visionDescriptor.api,
    sourceProviderId: input.selection.providerId,
    sourceModelId: input.selection.modelId,
    imageCount,
  })

  const usage: ModelStreamUsage[] = []
  let cacheHitCount = 0
  let analyzedImageCount = 0
  const messages: ChatMessage[] = []
  try {
    for (const [index, message] of input.messages.entries()) {
      if (message.role !== 'user' || typeof message.content === 'string') {
        messages.push(cloneAgentValue(message))
        continue
      }
      if (index !== imageMessageIndex) {
        messages.push(replaceUserImagesWithText(message, 'Previous image is not re-analyzed.'))
        continue
      }
      messages.push({
        role: 'user',
        content: await analyzeUserImageParts({
          parts: message.content,
          visionDescriptor,
          visionApiKey,
          modelStreamClient: input.modelStreamClient,
          signal: input.signal,
          usage,
          dataDir: input.dataDir,
          imageDir: input.imageDir,
          onCacheHit: () => {
            cacheHitCount += 1
          },
          onAnalyzed: () => {
            analyzedImageCount += 1
          },
        }),
      })
    }
  } catch (err) {
    input.emitAgentEvent('vision.bridge.failed', {
      providerId: visionSelection.providerId,
      modelId: visionSelection.modelId,
      provider: visionDescriptor.provider,
      api: visionDescriptor.api,
      imageCount,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  input.emitAgentEvent('vision.bridge.completed', {
    providerId: visionSelection.providerId,
    modelId: visionSelection.modelId,
    provider: visionDescriptor.provider,
    api: visionDescriptor.api,
    imageCount,
    usageCount: usage.length,
    cacheHitCount,
    analyzedImageCount,
  })

  return { messages, usage }
}

async function analyzeUserImageParts(input: {
  parts: UserContentPart[]
  visionDescriptor: ModelDescriptor
  visionApiKey: string
  modelStreamClient: ModelStreamClient
  signal: AbortSignal
  usage: ModelStreamUsage[]
  dataDir?: string
  imageDir?: string
  onCacheHit?: () => void
  onAnalyzed?: () => void
}): Promise<string> {
  const textContext = input.parts
    .filter((part): part is Extract<UserContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
    .trim()
  const sections: string[] = []
  if (textContext) sections.push(textContext)

  let imageIndex = 0
  for (const part of input.parts) {
    if (part.type === 'text') continue
    imageIndex += 1
    const analysis = await analyzeImagePart({
      image: part,
      imageIndex,
      textContext,
      visionDescriptor: input.visionDescriptor,
      visionApiKey: input.visionApiKey,
      modelStreamClient: input.modelStreamClient,
      signal: input.signal,
      usage: input.usage,
      dataDir: input.dataDir,
      imageDir: input.imageDir,
    })
    if (analysis.cacheHit) input.onCacheHit?.()
    else input.onAnalyzed?.()
    sections.push(
      [
        `<image-analysis index="${imageIndex}" source="${escapeVisionAttribute(part.url)}" mime="${escapeVisionAttribute(part.mime)}">`,
        analysis.text,
        '</image-analysis>',
      ].join('\n'),
    )
  }

  return sections.join('\n\n')
}

async function analyzeImagePart(input: {
  image: Extract<UserContentPart, { type: 'image' }>
  imageIndex: number
  textContext: string
  visionDescriptor: ModelDescriptor
  visionApiKey: string
  modelStreamClient: ModelStreamClient
  signal: AbortSignal
  usage: ModelStreamUsage[]
  dataDir?: string
  imageDir?: string
}): Promise<{ text: string; cacheHit: boolean }> {
  const cache = await prepareVisionAnalysisCache({
    dataDir: input.dataDir,
    imageDir: input.imageDir,
    image: input.image,
    textContext: input.textContext,
    visionDescriptor: input.visionDescriptor,
  })
  if (cache?.cached) return { text: cache.cached.analysis, cacheHit: true }

  const prompt = [
    `Analyze image ${input.imageIndex} for a downstream text-only model.`,
    input.textContext ? `User/request context:\n${input.textContext}` : '',
    'Return only the image analysis. Do not answer the user directly.',
  ]
    .filter(Boolean)
    .join('\n\n')
  const chunks: string[] = []

  for await (const event of input.modelStreamClient.stream({
    descriptor: input.visionDescriptor,
    apiKey: input.visionApiKey,
    messages: [
      { role: 'system', content: VISION_BRIDGE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }, cloneAgentValue(input.image)],
      },
    ],
    tools: [],
    signal: input.signal,
    step: -1,
    requireImages: true,
  })) {
    if (event.type === 'text-delta') chunks.push(event.text)
    if (event.type === 'finish-step' && event.usage) input.usage.push(event.usage)
    if (event.type === 'finish' && event.totalUsage) input.usage.push(event.totalUsage)
    if (event.type === 'error') {
      const message = event.error instanceof Error ? event.error.message : String(event.error)
      throw new Error(`Vision model failed to inspect image ${input.imageIndex}: ${message}`)
    }
  }

  const analysis = chunks.join('').trim()
  const text = analysis || '[Vision model returned no image analysis.]'
  await cache?.write(text)
  return { text, cacheHit: false }
}

interface VisionAnalysisCacheFile {
  schemaVersion: typeof VISION_ANALYSIS_CACHE_SCHEMA_VERSION
  createdAt: number
  imageHash: string
  imageMime: string
  promptVersion: typeof VISION_BRIDGE_PROMPT_VERSION
  textContextHash: string
  visionProvider: string
  visionModelId: string
  analysis: string
}

async function prepareVisionAnalysisCache(input: {
  dataDir?: string
  imageDir?: string
  image: Extract<UserContentPart, { type: 'image' }>
  textContext: string
  visionDescriptor: ModelDescriptor
}): Promise<{
  cached?: VisionAnalysisCacheFile
  write: (analysis: string) => Promise<void>
} | null> {
  if (!input.dataDir || !input.imageDir) return null
  const imageHash = await hashImageFile(input.image, input.imageDir)
  const textContextHash = sha256(input.textContext)
  const key = sha256(
    JSON.stringify({
      imageHash,
      imageMime: input.image.mime,
      promptVersion: VISION_BRIDGE_PROMPT_VERSION,
      textContextHash,
      visionProvider: input.visionDescriptor.provider,
      visionModelId: input.visionDescriptor.modelId,
    }),
  )
  const cacheDir = join(input.dataDir, 'vision-analysis')
  const cachePath = join(cacheDir, `${key}.json`)
  const cached = await readVisionAnalysisCache(cachePath)
  return {
    ...(cached ? { cached } : {}),
    write: async (analysis: string) => {
      await mkdir(cacheDir, { recursive: true })
      const record: VisionAnalysisCacheFile = {
        schemaVersion: VISION_ANALYSIS_CACHE_SCHEMA_VERSION,
        createdAt: Date.now(),
        imageHash,
        imageMime: input.image.mime,
        promptVersion: VISION_BRIDGE_PROMPT_VERSION,
        textContextHash,
        visionProvider: input.visionDescriptor.provider,
        visionModelId: input.visionDescriptor.modelId,
        analysis,
      }
      await writeFile(cachePath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8')
    },
  }
}

async function hashImageFile(
  image: Extract<UserContentPart, { type: 'image' }>,
  imageDir: string,
): Promise<string> {
  const name = imageNameFromUrl(image.url)
  if (!name) throw new Error(`Unable to load attached image ${image.url}: unrecognized image url`)
  try {
    return sha256(await readFile(join(imageDir, name)))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Unable to load attached image ${image.url}: ${detail}`)
  }
}

async function readVisionAnalysisCache(path: string): Promise<VisionAnalysisCacheFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<VisionAnalysisCacheFile>
    if (
      parsed.schemaVersion !== VISION_ANALYSIS_CACHE_SCHEMA_VERSION ||
      typeof parsed.analysis !== 'string' ||
      !parsed.analysis.trim()
    ) {
      return null
    }
    return parsed as VisionAnalysisCacheFile
  } catch {
    return null
  }
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function replaceImagesWithText(messages: ChatMessage[], reason: string): VisionBridgeResult {
  return {
    messages: messages.map((message) => {
      if (message.role !== 'user' || typeof message.content === 'string') {
        return cloneAgentValue(message)
      }
      return replaceUserImagesWithText(message, reason)
    }),
    usage: [],
  }
}

function replaceUserImagesWithText(
  message: Extract<ChatMessage, { role: 'user' }>,
  reason: string,
): ChatMessage {
  if (typeof message.content === 'string') return cloneAgentValue(message)
  const sections = message.content.map((part) =>
    part.type === 'text'
      ? part.text
      : `[Attached image omitted: ${reason} The image was not inspected; do not describe or infer its visual contents. Source: ${part.url}; MIME: ${part.mime}.]`,
  )
  return { role: 'user', content: sections.filter(Boolean).join('\n\n') }
}

function lastUserImageMessageIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message?.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image')
    ) {
      return index
    }
  }
  return -1
}

function latestImageCount(message: ChatMessage | undefined): number {
  if (!message || message.role !== 'user' || typeof message.content === 'string') return 0
  return message.content.filter((part) => part.type === 'image').length
}

function escapeVisionAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

interface ParsedModelToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  argsJson: string
}

type EmitAgentEvent = (type: AgentEventType, data?: Record<string, unknown>) => void

interface ToolStreamEventContext {
  builder: AssistantBuilder
  toolTargets: Map<string, ToolActivityTarget>
  emitAgentEvent: EmitAgentEvent
  handlers: StreamHandlers
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
    emitAgentEvent,
    handlers,
    conversationId,
    assistantMessageId,
  } = input
  builder.startToolCall(id, name, args)
  if (startedToolCalls.has(id)) return
  startedToolCalls.add(id)
  emitAgentEvent('tool.requested', {
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
    emitAgentEvent,
    handlers,
    conversationId,
    assistantMessageId,
  } = input
  const target = summarizeToolTarget(call.name, call.args)
  if (target) toolTargets.set(call.id, target)
  builder.startToolCall(call.id, call.name, call.argsJson)
  emitAgentEvent('tool.input.completed', {
    toolCallId: call.id,
    toolName: call.name,
    input: previewEventValue(call.args),
    ...(target && { target }),
  })
  if (startedToolCalls.has(call.id)) return
  startedToolCalls.add(call.id)
  emitAgentEvent('tool.requested', {
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
    emitAgentEvent,
    handlers,
    conversationId,
    assistantMessageId,
  } = input
  builder.finishToolCall(toolCallId, result, isError, resultRef)
  emitAgentEvent('tool.result.returned', {
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

function buildTools(
  ctx: Parameters<typeof executeTool>[2],
  emitAgentEvent: (type: AgentEventType, data?: Record<string, unknown>) => void,
  toolRegistry?: ToolRegistry,
  toolTargets = new Map<string, ToolActivityTarget>(),
): ModelStreamToolDefinition[] {
  return getToolDefinitions(toolRegistry).map((td) => ({
    name: td.function.name,
    description: td.function.description,
    parameters: td.function.parameters,
    execute: async (args, options) => {
      const toolCallId = options.toolCallId
      const toolName = td.function.name
      const input = cloneAgentToolArgs(args)
      const target = summarizeToolTarget(toolName, input)
      if (target) toolTargets.set(toolCallId, target)
      emitAgentEvent('tool.execution.started', {
        toolCallId,
        toolName,
        input: previewEventValue(input),
        ...(target && { target }),
      })
      try {
        const result = await executeTool(toolName, input, { ...ctx, toolCallId }, toolRegistry)
        emitAgentEvent('tool.execution.completed', {
          toolCallId,
          toolName,
          result: previewEventValue(result),
          ...(toolTargets.get(toolCallId) && { target: toolTargets.get(toolCallId) }),
        })
        return result
      } catch (error) {
        emitAgentEvent('tool.execution.failed', {
          toolCallId,
          toolName,
          error: error instanceof Error ? error.message : String(error),
          ...(toolTargets.get(toolCallId) && { target: toolTargets.get(toolCallId) }),
        })
        throw error
      }
    },
  }))
}

class AssistantBuilder {
  blocks: PersistedBlock[] = []
  private toolBlockIndex = new Map<string, number>()

  appendText(kind: 'text' | 'reasoning', delta: string): void {
    if (!delta) return
    const last = this.blocks[this.blocks.length - 1]
    if (last && last.type === kind) {
      last.content += delta
      return
    }
    this.blocks.push({ type: kind, content: delta })
  }

  startToolCall(id: string, name: string, args: string): void {
    const existing = this.toolBlockIndex.get(id)
    if (existing !== undefined) {
      const block = this.blocks[existing] as PersistedToolCallBlock
      block.name = name
      block.arguments = args
      return
    }
    const block: PersistedToolCallBlock = {
      type: 'tool_call',
      id,
      name,
      arguments: args,
      status: 'running',
    }
    this.toolBlockIndex.set(id, this.blocks.length)
    this.blocks.push(block)
  }

  appendToolCallArgs(id: string, delta: string): void {
    if (!delta) return
    const idx = this.toolBlockIndex.get(id)
    if (idx === undefined) return
    const block = this.blocks[idx] as PersistedToolCallBlock
    block.arguments += delta
  }

  appendImage(block: PersistedImageBlock): void {
    this.blocks.push(cloneAgentValue(block))
  }

  finishToolCall(
    id: string,
    result: string,
    isError: boolean,
    resultRef?: PersistedToolResultRef,
  ): void {
    const idx = this.toolBlockIndex.get(id)
    if (idx === undefined) return
    const block = this.blocks[idx] as PersistedToolCallBlock
    block.status = isError ? 'error' : 'done'
    block.result = result
    if (resultRef) block.resultRef = cloneAgentValue(resultRef)
  }

  build(
    messageId: string,
    status: 'streaming' | 'done' | 'error',
    selection: ModelSelection,
    error?: string,
  ): PersistedMessage {
    return {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: messageId,
      role: 'assistant',
      blocks: cloneAgentValue(this.blocks),
      status,
      ...(error !== undefined && { error }),
      model: cloneAgentValue(selection),
    }
  }
}
