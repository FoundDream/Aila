/**
 * Agent loop backed by Vercel AI SDK. Provider/model is chosen per call from
 * settings.json + the renderer's picker selection. SDK handles SSE parsing,
 * tool_call delta accumulation, and the multi-step tool loop.
 */

import { findModel, type ProviderId } from '@shared/models'
import { jsonSchema, type ModelMessage, stepCountIs, streamText, tool } from 'ai'
import { MissingApiKeyError, resolveModel } from './providers'
import { loadSettings } from './settings'
import { executeTool, TOOL_DEFINITIONS } from './tools'

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
  id: string
  name: string
  arguments: string
}

export interface ToolResultEvent {
  id: string
  result: string
  isError: boolean
}

export interface UsageInfo {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface StreamHandlers {
  onTextDelta: (delta: string) => void
  onReasoningDelta: (delta: string) => void
  onToolCallStart: (event: ToolCallEvent) => void
  onToolCallResult: (event: ToolResultEvent) => void
  onDone: (full: { text: string; reasoning: string; usage?: UsageInfo }) => void
  onError: (message: string) => void
}

const MAX_STEPS = 10

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

// Build AI SDK tool set from TOOL_DEFINITIONS. Keep JSON Schema (no zod
// migration), wrap executeTool as the per-tool execute callback.
const aiTools = Object.fromEntries(
  TOOL_DEFINITIONS.map((td) => [
    td.function.name,
    tool({
      description: td.function.description,
      inputSchema: jsonSchema(td.function.parameters as Parameters<typeof jsonSchema>[0]),
      execute: async (args) => executeTool(td.function.name, args as Record<string, unknown>),
    }),
  ]),
)

// Convert renderer's OpenAI-format ChatMessage[] to AI SDK ModelMessage[].
// Tool messages need toolName; we look it up from the previous assistant's
// tool_calls list since the renderer only persists tool_call_id + content.
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

export interface ModelSelection {
  providerId: ProviderId
  modelId: string
}

export async function streamChat(
  initialMessages: ChatMessage[],
  selection: ModelSelection,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  let model: ReturnType<typeof resolveModel>
  try {
    model = resolveModel(selection.providerId, selection.modelId, loadSettings())
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      handlers.onError(
        `No API key for ${err.providerId}. Open Settings (sidebar gear) and add one.`,
      )
      return
    }
    handlers.onError(err instanceof Error ? err.message : String(err))
    return
  }

  let aggregateText = ''
  let aggregateReasoning = ''
  let lastUsage: UsageInfo | null = null

  try {
    const result = streamText({
      model,
      messages: toModelMessages(initialMessages),
      tools: aiTools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal,
    })

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          aggregateText += part.text
          handlers.onTextDelta(part.text)
          break
        case 'reasoning-delta':
          aggregateReasoning += part.text
          handlers.onReasoningDelta(part.text)
          break
        case 'tool-call':
          handlers.onToolCallStart({
            id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input ?? {}),
          })
          break
        case 'tool-result': {
          const out = part.output
          const result = typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out)
          handlers.onToolCallResult({
            id: part.toolCallId,
            result,
            isError: false,
          })
          break
        }
        case 'tool-error': {
          const message = part.error instanceof Error ? part.error.message : String(part.error)
          handlers.onToolCallResult({
            id: part.toolCallId,
            result: message,
            isError: true,
          })
          break
        }
        case 'finish-step': {
          const u = part.usage
          if (u) {
            lastUsage = {
              promptTokens: u.inputTokens ?? 0,
              completionTokens: u.outputTokens ?? 0,
              totalTokens: u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            }
          }
          break
        }
        case 'finish': {
          const u = part.totalUsage
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
          handlers.onDone({
            text: aggregateText,
            reasoning: aggregateReasoning,
            usage: lastUsage ?? undefined,
          })
          return
        case 'error': {
          const message = part.error instanceof Error ? part.error.message : String(part.error)
          handlers.onError(message)
          return
        }
      }
    }

    handlers.onDone({
      text: aggregateText,
      reasoning: aggregateReasoning,
      usage: lastUsage ?? undefined,
    })
  } catch (error) {
    if (signal.aborted) {
      handlers.onDone({
        text: aggregateText,
        reasoning: aggregateReasoning,
        usage: lastUsage ?? undefined,
      })
      return
    }
    handlers.onError(error instanceof Error ? error.message : String(error))
  }
}
