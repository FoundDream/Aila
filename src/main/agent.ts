/**
 * Agent loop backed by Vercel AI SDK. Provider/model is chosen per call from
 * settings.json + the renderer's picker selection. SDK handles SSE parsing,
 * tool_call delta accumulation, and the multi-step tool loop.
 *
 * Each stream is keyed by (conversationId, assistantMessageId). The agent owns
 * accumulation of the canonical PersistedMessage so the main process can
 * persist it on completion regardless of renderer state.
 */

import { jsonSchema, type ModelMessage, smoothStream, stepCountIs, streamText, tool } from 'ai'
import { findModel, type ProviderId } from '../shared/models'
import type { AgentProfileId } from './agent-profile'
import {
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  type PersistedBlock,
  type PersistedImageBlock,
  type PersistedMessage,
  type PersistedToolCallBlock,
} from './conversations'
import { MissingApiKeyError, resolveModel } from './providers'
import { loadSettings } from './settings'
import {
  executeTool,
  getToolDefinitionsForProfile,
  type ImageSideChannelBlock,
  type ToolContext,
  type ToolRegistry,
} from './tools'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ToolCallEvent {
  conversationId: string
  messageId: string
  toolCallId: string
  name: string
  arguments: string
}

export interface ToolCallArgsDeltaEvent {
  conversationId: string
  messageId: string
  toolCallId: string
  delta: string
}

export interface ToolResultEvent {
  conversationId: string
  messageId: string
  toolCallId: string
  result: string
  isError: boolean
}

export interface DeltaEvent {
  conversationId: string
  messageId: string
  delta: string
}

export interface ImageBlockEvent {
  conversationId: string
  messageId: string
  block: PersistedImageBlock
}

export interface UsageInfo {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface DoneEvent {
  conversationId: string
  messageId: string
  message: PersistedMessage
  usage?: UsageInfo
}

export interface ErrorEvent {
  conversationId: string
  messageId: string
  error: string
  message: PersistedMessage
}

export type AgentEventType =
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'turn.interrupted'
  | 'tool.requested'
  | 'tool.input.delta'
  | 'tool.input.completed'
  | 'tool.execution.started'
  | 'tool.execution.completed'
  | 'tool.execution.failed'
  | 'tool.result.returned'
  | 'tool.approval.requested'
  | 'tool.approval.resolved'

export interface AgentEvent {
  timestamp: number
  conversationId: string
  messageId: string
  type: AgentEventType
  data?: Record<string, unknown>
}

export type AgentEventSink = (event: AgentEvent) => void

type MaybePromise<T> = T | Promise<T>

export interface StreamHandlers {
  onTextDelta: (event: DeltaEvent) => void
  onReasoningDelta: (event: DeltaEvent) => void
  onToolCallStart: (event: ToolCallEvent) => void
  onToolCallArgsDelta: (event: ToolCallArgsDeltaEvent) => void
  onToolCallResult: (event: ToolResultEvent) => void
  onImageBlock: (event: ImageBlockEvent) => void
  onDone: (event: DoneEvent) => MaybePromise<void>
  onError: (event: ErrorEvent) => MaybePromise<void>
}

const MAX_STEPS = 10
const EVENT_PREVIEW_CHARS = 1000

export interface ModelInfo {
  model: string
  contextLength: number | null
}

export function getModelInfo(providerId: ProviderId, modelId: string): ModelInfo {
  const meta = findModel(providerId, modelId)
  return {
    model: meta?.displayName ?? modelId,
    contextLength: meta?.contextLength ? meta.contextLength : null,
  }
}

function previewEventValue(value: unknown): { preview: string; size: number } {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
  return {
    preview: text.length > EVENT_PREVIEW_CHARS ? `${text.slice(0, EVENT_PREVIEW_CHARS)}...` : text,
    size: text.length,
  }
}

// Tool registry is rebuilt per-stream so each `execute` closes over the
// per-call ToolContext (settings, abort signal, image side-channel).
function buildTools(
  ctx: Parameters<typeof executeTool>[2],
  emitAgentEvent: (type: AgentEventType, data?: Record<string, unknown>) => void,
  toolRegistry?: ToolRegistry,
) {
  return Object.fromEntries(
    getToolDefinitionsForProfile(ctx.profileId, toolRegistry).map((td) => [
      td.function.name,
      tool({
        description: td.function.description,
        inputSchema: jsonSchema(td.function.parameters as Parameters<typeof jsonSchema>[0]),
        execute: async (args, options) => {
          const toolCallId = options.toolCallId
          emitAgentEvent('tool.execution.started', {
            toolCallId,
            toolName: td.function.name,
            input: previewEventValue(args),
          })
          try {
            const result = await executeTool(
              td.function.name,
              args as Record<string, unknown>,
              { ...ctx, toolCallId },
              toolRegistry,
            )
            emitAgentEvent('tool.execution.completed', {
              toolCallId,
              toolName: td.function.name,
              result: previewEventValue(result),
            })
            return result
          } catch (error) {
            emitAgentEvent('tool.execution.failed', {
              toolCallId,
              toolName: td.function.name,
              error: error instanceof Error ? error.message : String(error),
            })
            throw error
          }
        },
      }),
    ]),
  )
}

// Convert OpenAI-format ChatMessage[] to AI SDK ModelMessage[]. Tool messages
// need toolName; we look it up from the previous assistant's tool_calls list
// since persisted state only carries tool_call_id + content.
function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const toolNameById = new Map<string, string>()
  const out: ModelMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'user') {
      out.push({ role: msg.role, content: msg.content })
      continue
    }

    if (msg.role === 'assistant') {
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        out.push({ role: 'assistant', content: msg.content })
        continue
      }
      const parts: Array<
        | { type: 'text'; text: string }
        | {
            type: 'tool-call'
            toolCallId: string
            toolName: string
            input: unknown
          }
      > = []
      if (msg.content) parts.push({ type: 'text', text: msg.content })
      for (const tc of msg.tool_calls) {
        toolNameById.set(tc.id, tc.function.name)
        let input: unknown = {}
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          input = {}
        }
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input,
        })
      }
      out.push({ role: 'assistant', content: parts })
      continue
    }

    if (msg.role === 'tool') {
      const toolName = toolNameById.get(msg.tool_call_id) ?? 'unknown'
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: msg.tool_call_id,
            toolName,
            output: { type: 'text', value: msg.content },
          },
        ],
      })
    }
  }

  return out
}

// Builds up the canonical PersistedMessage as the stream progresses. Mirrors
// the renderer's appendDeltaToBlocks/upsertToolCall logic so main is the source
// of truth for what gets persisted.
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
    this.blocks.push(block)
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
      blocks: this.blocks,
      status,
      ...(error !== undefined && { error }),
      model: selection,
    }
  }
}

export interface ModelSelection {
  providerId: ProviderId
  modelId: string
}

export interface StreamRequest {
  conversationId: string
  assistantMessageId: string
  messages: ChatMessage[]
  selection: ModelSelection
  signal: AbortSignal
  onAgentEvent?: AgentEventSink
  profileId: AgentProfileId
  workspaceRoots?: ToolContext['workspaceRoots']
  onToolApproval?: ToolContext['onToolApproval']
  toolRegistry?: ToolRegistry
}

export async function streamChat(req: StreamRequest, handlers: StreamHandlers): Promise<void> {
  const {
    conversationId,
    assistantMessageId,
    messages,
    selection,
    signal,
    onAgentEvent,
    profileId,
    workspaceRoots,
    onToolApproval,
    toolRegistry,
  } = req

  const builder = new AssistantBuilder()
  let lastUsage: UsageInfo | null = null

  const emitAgentEvent = (type: AgentEventType, data?: Record<string, unknown>): void => {
    onAgentEvent?.({
      timestamp: Date.now(),
      conversationId,
      messageId: assistantMessageId,
      type,
      ...(data && { data }),
    })
  }

  // Snapshot settings once per stream so the image tool sees the same key/model
  // selection that resolveModel did.
  const settings = loadSettings()
  emitAgentEvent('turn.started', {
    providerId: selection.providerId,
    modelId: selection.modelId,
    inputMessageCount: messages.length,
  })

  const onImageFromTool = (block: ImageSideChannelBlock): void => {
    builder.appendImage(block)
    handlers.onImageBlock({
      conversationId,
      messageId: assistantMessageId,
      block,
    })
  }

  let model: ReturnType<typeof resolveModel>
  try {
    model = resolveModel(selection.providerId, selection.modelId, settings)
  } catch (err) {
    const message =
      err instanceof MissingApiKeyError
        ? `No API key for ${err.providerId}. Open Settings (sidebar gear) and add one.`
        : err instanceof Error
          ? err.message
          : String(err)
    await handlers.onError({
      conversationId,
      messageId: assistantMessageId,
      error: message,
      message: builder.build(assistantMessageId, 'error', selection, message),
    })
    emitAgentEvent('turn.failed', { error: message })
    return
  }

  try {
    const result = streamText({
      model,
      messages: toModelMessages(messages),
      tools: buildTools(
        {
          settings,
          profileId,
          conversationId,
          messageId: assistantMessageId,
          workspaceRoots,
          signal,
          onToolApproval,
          onImage: onImageFromTool,
        },
        emitAgentEvent,
        toolRegistry,
      ),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal,
      experimental_transform: smoothStream({
        delayInMs: 15,
        chunking: /[぀-ゟ゠-ヿ一-鿿가-힯]|\S+\s+/,
      }),
    })

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          builder.appendText('text', part.text)
          handlers.onTextDelta({
            conversationId,
            messageId: assistantMessageId,
            delta: part.text,
          })
          break
        case 'reasoning-delta':
          builder.appendText('reasoning', part.text)
          handlers.onReasoningDelta({
            conversationId,
            messageId: assistantMessageId,
            delta: part.text,
          })
          break
        case 'tool-input-start': {
          // Fired when the model starts streaming a tool call. Args are still
          // empty here; we surface the running block immediately so a long
          // arguments payload doesn't look like the UI is frozen.
          builder.startToolCall(part.id, part.toolName, '')
          emitAgentEvent('tool.requested', {
            toolCallId: part.id,
            toolName: part.toolName,
          })
          handlers.onToolCallStart({
            conversationId,
            messageId: assistantMessageId,
            toolCallId: part.id,
            name: part.toolName,
            arguments: '',
          })
          break
        }
        case 'tool-input-delta': {
          builder.appendToolCallArgs(part.id, part.delta)
          emitAgentEvent('tool.input.delta', {
            toolCallId: part.id,
            deltaSize: part.delta.length,
          })
          handlers.onToolCallArgsDelta({
            conversationId,
            messageId: assistantMessageId,
            toolCallId: part.id,
            delta: part.delta,
          })
          break
        }
        case 'tool-call': {
          // Args are complete here. Overwrite the running block with the
          // canonical JSON in case delta accumulation drifted (it shouldn't,
          // but the SDK guarantees this is the source of truth).
          const args = JSON.stringify(part.input ?? {})
          builder.startToolCall(part.toolCallId, part.toolName, args)
          emitAgentEvent('tool.input.completed', {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: previewEventValue(part.input ?? {}),
          })
          handlers.onToolCallStart({
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
          const result = typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out)
          builder.finishToolCall(part.toolCallId, result, false)
          emitAgentEvent('tool.result.returned', {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: previewEventValue(result),
            isError: false,
          })
          handlers.onToolCallResult({
            conversationId,
            messageId: assistantMessageId,
            toolCallId: part.toolCallId,
            result,
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
          })
          handlers.onToolCallResult({
            conversationId,
            messageId: assistantMessageId,
            toolCallId: part.toolCallId,
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
        case 'abort': {
          await handlers.onError({
            conversationId,
            messageId: assistantMessageId,
            error: 'Aborted',
            message: builder.build(assistantMessageId, 'error', selection, 'Aborted'),
          })
          emitAgentEvent('turn.cancelled', { phase: 'completed', reason: 'abort_signal' })
          return
        }
        case 'error': {
          const message = part.error instanceof Error ? part.error.message : String(part.error)
          await handlers.onError({
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
    await handlers.onDone({
      conversationId,
      messageId: assistantMessageId,
      message: builder.build(assistantMessageId, 'done', selection),
      usage: lastUsage ?? undefined,
    })
  } catch (error) {
    const isAbort = signal.aborted
    const message = isAbort ? 'Aborted' : error instanceof Error ? error.message : String(error)
    await handlers.onError({
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
