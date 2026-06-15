import {
  type AgentEvent,
  type AgentEventType,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  type ChatMessage,
  type ImageSideChannelBlock,
  type ModelInfo,
  type ModelSelection,
  type PersistedBlock,
  type PersistedImageBlock,
  type PersistedMessage,
  type PersistedToolCallBlock,
  type RuntimeStreamChat,
  type ToolActivityTarget,
  type ToolContext,
  type ToolRegistry,
  type UsageInfo,
} from '../core'
import { executeTool, getToolDefinitions, summarizeToolTarget } from '../internal'
import type { Settings } from '../settings-types'
import { MissingApiKeyError, type NodeAuthInput, requireApiKey } from './auth'
import { createDefaultModelStreamClient } from './default-model-stream'
import {
  type CreateModelRegistryInput,
  createModelRegistry,
  type ModelRegistry,
} from './model-registry'
import type { ModelStreamClient, ModelStreamToolDefinition } from './model-stream'
import { createProtocolRegistry, type ProtocolAdapter, type ProtocolRegistry } from './protocols'

type MaybePromise<T> = T | Promise<T>

const EVENT_PREVIEW_CHARS = 1000

export interface ProviderStreamChatOptions extends NodeAuthInput {
  modelRegistry?: ModelRegistry
  modelRegistryOptions?: CreateModelRegistryInput
  protocolRegistry?: ProtocolRegistry
  protocolAdapters?: ProtocolAdapter[]
  modelStreamClient?: ModelStreamClient
  settings?: Settings
  loadSettings?: () => Settings
  imageDir?: string
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

  return async (req, handlers): Promise<void> => {
    const {
      conversationId,
      assistantMessageId,
      messages: requestMessages,
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
      const result = modelStreamClient.stream({
        descriptor,
        apiKey,
        messages,
        tools: buildTools(
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
        ),
        signal,
      })

      for await (const part of result) {
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
            builder.startToolCall(part.id, part.toolName, '')
            emitAgentEvent('tool.requested', {
              toolCallId: part.id,
              toolName: part.toolName,
            })
            callStreamHandler(handlers.onToolCallStart, {
              conversationId,
              messageId: assistantMessageId,
              toolCallId: part.id,
              name: part.toolName,
              arguments: '',
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
            const input = part.input ?? {}
            const args = JSON.stringify(input)
            const target =
              input && typeof input === 'object' && !Array.isArray(input)
                ? summarizeToolTarget(part.toolName, input as Record<string, unknown>)
                : null
            if (target) toolTargets.set(part.toolCallId, target)
            builder.startToolCall(part.toolCallId, part.toolName, args)
            emitAgentEvent('tool.input.completed', {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: previewEventValue(part.input ?? {}),
              ...(target && { target }),
            })
            callStreamHandler(handlers.onToolCallStart, {
              conversationId,
              messageId: assistantMessageId,
              toolCallId: part.toolCallId,
              name: part.toolName,
              arguments: args,
            })
            break
          }
          case 'tool-result': {
            const out = part.output
            const toolResult =
              typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out)
            builder.finishToolCall(part.toolCallId, toolResult, false)
            emitAgentEvent('tool.result.returned', {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              result: previewEventValue(toolResult),
              isError: false,
              ...(toolTargets.get(part.toolCallId) && { target: toolTargets.get(part.toolCallId) }),
            })
            callStreamHandler(handlers.onToolCallResult, {
              conversationId,
              messageId: assistantMessageId,
              toolCallId: part.toolCallId,
              name: part.toolName,
              result: toolResult,
              isError: false,
            })
            break
          }
          case 'tool-error': {
            const message = part.error instanceof Error ? part.error.message : String(part.error)
            builder.finishToolCall(part.toolCallId, message, true)
            emitAgentEvent('tool.result.returned', {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              result: previewEventValue(message),
              isError: true,
              ...(toolTargets.get(part.toolCallId) && { target: toolTargets.get(part.toolCallId) }),
            })
            callStreamHandler(handlers.onToolCallResult, {
              conversationId,
              messageId: assistantMessageId,
              toolCallId: part.toolCallId,
              name: part.toolName,
              result: message,
              isError: true,
            })
            break
          }
          case 'finish-step':
          case 'finish': {
            const u = part.type === 'finish' ? part.totalUsage : part.usage
            if (u) {
              lastUsage = {
                promptTokens: u.inputTokens ?? 0,
                completionTokens: u.outputTokens ?? 0,
                totalTokens: u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
              }
            }
            break
          }
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

  finishToolCall(id: string, result: string, isError: boolean): void {
    const idx = this.toolBlockIndex.get(id)
    if (idx === undefined) return
    const block = this.blocks[idx] as PersistedToolCallBlock
    block.status = isError ? 'error' : 'done'
    block.result = result
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
