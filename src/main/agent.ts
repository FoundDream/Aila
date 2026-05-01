/**
 * Agent loop backed by OpenRouter (OpenAI-compatible chat completions).
 *
 * Each turn streams text + reasoning deltas to the renderer. If the model
 * returns tool_calls, we execute them locally, append role:"tool" messages,
 * and run another turn. Loop ends when the model returns no tool_calls or
 * we hit MAX_ITERATIONS.
 */

import { executeTool, TOOL_DEFINITIONS, type ToolDefinition } from './tools'

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

export interface StreamHandlers {
  onTextDelta: (delta: string) => void
  onReasoningDelta: (delta: string) => void
  onToolCallStart: (event: ToolCallEvent) => void
  onToolCallResult: (event: ToolResultEvent) => void
  onDone: (full: { text: string; reasoning: string }) => void
  onError: (message: string) => void
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MAX_ITERATIONS = 10

interface OpenRouterToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface OpenRouterDelta {
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
  tool_calls?: OpenRouterToolCallDelta[]
}

interface OpenRouterStreamChunk {
  choices?: Array<{
    delta?: OpenRouterDelta
    finish_reason?: string | null
  }>
}

interface TurnResult {
  text: string
  reasoning: string
  toolCalls: ToolCall[]
  finishReason: string | null
}

async function runTurn(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  apiKey: string,
  model: string,
  appName: string,
  signal: AbortSignal,
  onTextDelta: (delta: string) => void,
  onReasoningDelta: (delta: string) => void,
): Promise<TurnResult> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': appName,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages,
      tools,
    }),
  })

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenRouter ${response.status}: ${text || response.statusText}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  let text = ''
  let reasoning = ''
  let finishReason: string | null = null
  // Tool calls stream as deltas keyed by `index`. We accumulate id/name/arguments per index.
  const toolCallsByIndex = new Map<number, ToolCall>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) break
      const rawLine = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)

      if (!rawLine.startsWith('data:')) continue
      const data = rawLine.slice(5).trim()
      if (!data || data === '[DONE]') continue

      let chunk: OpenRouterStreamChunk
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }

      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (!delta) continue

      const r = delta.reasoning ?? delta.reasoning_content
      if (r) {
        reasoning += r
        onReasoningDelta(r)
      }
      if (delta.content) {
        text += delta.content
        onTextDelta(delta.content)
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          const existing = toolCallsByIndex.get(idx) ?? {
            id: '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          }
          if (tc.id) existing.id = tc.id
          if (tc.function?.name) existing.function.name = tc.function.name
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
          toolCallsByIndex.set(idx, existing)
        }
      }
    }
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => tc)
    .filter((tc) => tc.function.name)

  return { text, reasoning, toolCalls, finishReason }
}

export async function streamChat(
  initialMessages: ChatMessage[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY
  const model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3.1'
  const appName = process.env.OPENROUTER_APP_NAME || 'Aila'

  if (!apiKey) {
    handlers.onError('OPENROUTER_API_KEY is not set. Add it to .env and restart the app.')
    return
  }

  const messages: ChatMessage[] = [...initialMessages]
  let aggregateText = ''
  let aggregateReasoning = ''

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const turn = await runTurn(
        messages,
        TOOL_DEFINITIONS,
        apiKey,
        model,
        appName,
        signal,
        handlers.onTextDelta,
        handlers.onReasoningDelta,
      )

      aggregateText += turn.text
      aggregateReasoning += turn.reasoning

      if (turn.toolCalls.length === 0) {
        handlers.onDone({ text: aggregateText, reasoning: aggregateReasoning })
        return
      }

      messages.push({
        role: 'assistant',
        content: turn.text,
        tool_calls: turn.toolCalls,
      })

      for (const call of turn.toolCalls) {
        handlers.onToolCallStart({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })

        let result: string
        let isError = false
        try {
          let parsedArgs: Record<string, unknown> = {}
          if (call.function.arguments) {
            parsedArgs = JSON.parse(call.function.arguments)
          }
          result = await executeTool(call.function.name, parsedArgs)
        } catch (error) {
          isError = true
          result = error instanceof Error ? error.message : String(error)
        }

        handlers.onToolCallResult({ id: call.id, result, isError })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        })
      }
    }

    handlers.onError(`Reached MAX_ITERATIONS (${MAX_ITERATIONS}) without a final answer.`)
  } catch (error) {
    if (signal.aborted) {
      handlers.onDone({ text: aggregateText, reasoning: aggregateReasoning })
      return
    }
    handlers.onError(error instanceof Error ? error.message : String(error))
  }
}
