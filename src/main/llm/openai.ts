/**
 * OpenAI Chat Completions client — supports OpenAI and any OpenAI-compatible
 * endpoint (DeepSeek, Together, Groq, Fireworks, local llama.cpp servers, etc).
 *
 * Reference: https://platform.openai.com/docs/api-reference/chat
 *
 * Intentionally omitted from v1:
 * - Responses API (/v1/responses) — Chat Completions is more widely supported
 * - structured outputs (json_schema response_format)
 * - logprobs
 * - parallel_tool_calls override (defaults to true)
 * - tool_choice override (defaults to 'auto')
 */

import type {
  AssistantContentPart,
  ChatRequest,
  CompleteResult,
  LLMAuth,
  LLMClient,
  LLMUsage,
  Message,
  StopReason,
  StreamEvent,
  UserContentPart,
} from '../agent-core/types'

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

interface OpenAITextPart {
  type: 'text'
  text: string
}

interface OpenAIImagePart {
  type: 'image_url'
  image_url: { url: string }
}

type OpenAIUserContentPart = OpenAITextPart | OpenAIImagePart

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAISystemMessage {
  role: 'system'
  content: string
}

interface OpenAIUserMessage {
  role: 'user'
  content: string | OpenAIUserContentPart[]
}

interface OpenAIAssistantMessage {
  role: 'assistant'
  content?: string | null
  tool_calls?: OpenAIToolCall[]
}

interface OpenAIToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

type OpenAIMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage

interface OpenAIToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
  }
}

interface OpenAIChoice {
  index: number
  message: {
    role: 'assistant'
    content?: string | null
    tool_calls?: OpenAIToolCall[]
    reasoning_content?: string | null
  }
  finish_reason: string | null
}

interface OpenAIResponse {
  id: string
  object: 'chat.completion'
  choices: OpenAIChoice[]
  usage?: OpenAIUsage
}

interface OpenAIStreamChoice {
  index: number
  delta: {
    role?: 'assistant'
    content?: string | null
    reasoning_content?: string | null
    tool_calls?: Array<{
      index: number
      id?: string
      type?: 'function'
      function?: {
        name?: string
        arguments?: string
      }
    }>
  }
  finish_reason: string | null
}

interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  choices: OpenAIStreamChoice[]
  usage?: OpenAIUsage
}

// ---------------------------------------------------------------------------
// Message conversion: canonical Message[] → OpenAI messages[]
// ---------------------------------------------------------------------------

function convertUserContent(content: string | UserContentPart[]): string | OpenAIUserContentPart[] {
  if (typeof content === 'string') return content
  const parts: OpenAIUserContentPart[] = []
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text })
    } else {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${part.mimeType};base64,${part.data}`,
        },
      })
    }
  }
  // If there's a single text part, OpenAI accepts plain string; we still send
  // array for consistency with multimodal flows.
  return parts
}

export function convertMessages(systemPrompt: string, messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []

  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: convertUserContent(msg.content) })
      continue
    }

    if (msg.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: OpenAIToolCall[] = []
      for (const part of msg.content) {
        if (part.type === 'text') {
          textParts.push(part.text)
        } else if (part.type === 'toolCall') {
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.arguments ?? {}),
            },
          })
        }
        // thinking blocks are dropped — OpenAI Chat Completions does not
        // accept them in conversation history.
      }

      const assistantMsg: OpenAIAssistantMessage = { role: 'assistant' }
      if (textParts.length > 0) {
        assistantMsg.content = textParts.join('')
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      // OpenAI requires either content or tool_calls to be present.
      if (!assistantMsg.content && !assistantMsg.tool_calls) {
        assistantMsg.content = ''
      }
      out.push(assistantMsg)
      continue
    }

    // msg.role === 'toolResult'
    out.push({
      role: 'tool',
      tool_call_id: msg.toolCallId,
      content: msg.content.map((c) => c.text).join('\n'),
    })
  }

  return out
}

export function convertResponseMessage(message: OpenAIChoice['message']): AssistantContentPart[] {
  const parts: AssistantContentPart[] = []

  if (message.reasoning_content) {
    parts.push({ type: 'thinking', text: message.reasoning_content })
  }

  if (message.content) {
    parts.push({ type: 'text', text: message.content })
  }

  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      let args: Record<string, unknown> = {}
      try {
        args = call.function.arguments
          ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
          : {}
      } catch {
        // leave empty
      }
      parts.push({
        type: 'toolCall',
        id: call.id,
        name: call.function.name,
        arguments: args,
      })
    }
  }

  return parts
}

export function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
    case 'content_filter':
      return 'stop'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    default:
      return 'stop'
  }
}

export function mapUsage(raw: OpenAIUsage | undefined): LLMUsage {
  return {
    input: raw?.prompt_tokens ?? 0,
    output: raw?.completion_tokens ?? 0,
    ...(raw?.prompt_tokens_details?.cached_tokens !== undefined
      ? { cacheRead: raw.prompt_tokens_details.cached_tokens }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

interface OpenAIRequestBody {
  model: string
  messages: OpenAIMessage[]
  stream: boolean
  stream_options?: { include_usage: boolean }
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  tools?: OpenAIToolSchema[]
  reasoning_effort?: 'low' | 'medium' | 'high'
}

function isReasoningModel(modelId: string): boolean {
  // o1, o3, o4, gpt-5 reasoning variants require max_completion_tokens and
  // forbid temperature. Heuristic match on the id prefix.
  return /^(o\d|gpt-5)/i.test(modelId)
}

export function buildRequestBody(req: ChatRequest, stream: boolean): OpenAIRequestBody {
  const reasoning = isReasoningModel(req.model.id)
  const body: OpenAIRequestBody = {
    model: req.model.id,
    messages: convertMessages(req.systemPrompt, req.messages),
    stream,
  }

  if (stream) {
    body.stream_options = { include_usage: true }
  }

  const maxTokens = req.maxOutputTokens ?? req.model.maxOutputTokens
  if (reasoning) {
    body.max_completion_tokens = maxTokens
  } else {
    body.max_tokens = maxTokens
    if (req.temperature !== undefined) {
      body.temperature = req.temperature
    }
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }

  if (
    reasoning &&
    req.thinkingBudget !== undefined &&
    req.thinkingBudget > 0 &&
    req.model.supportsThinking
  ) {
    body.reasoning_effort =
      req.thinkingBudget >= 10000 ? 'high' : req.thinkingBudget >= 2000 ? 'medium' : 'low'
  }

  return body
}

function buildHeaders(auth: LLMAuth): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(auth.apiKey.trim() ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
    ...(auth.headers ?? {}),
  }
}

function buildUrl(auth: LLMAuth): string {
  const base = auth.baseUrl.replace(/\/+$/, '')
  return `${base}/chat/completions`
}

async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return
  const text = await response.text().catch(() => '')
  let message = `OpenAI API ${response.status} ${response.statusText}`
  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      if (parsed.error?.message) {
        message = `${message}: ${parsed.error.message}`
      } else {
        message = `${message}: ${text}`
      }
    } catch {
      message = `${message}: ${text}`
    }
  }
  throw new Error(message)
}

// ---------------------------------------------------------------------------
// SSE reader — OpenAI chunks are terminated by "data: [DONE]\n\n".
// ---------------------------------------------------------------------------

async function* readOpenAISSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<OpenAIStreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError')
      }

      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        const dataLines: string[] = []
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart())
          }
        }

        if (dataLines.length === 0) {
          boundary = buffer.indexOf('\n\n')
          continue
        }

        const dataStr = dataLines.join('\n')
        if (dataStr === '[DONE]') {
          return
        }

        try {
          const chunk = JSON.parse(dataStr) as OpenAIStreamChunk
          yield chunk
        } catch {
          // malformed chunk — skip
        }

        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAIClient
// ---------------------------------------------------------------------------

export class OpenAIClient implements LLMClient {
  async *stream(
    request: ChatRequest,
    auth: LLMAuth,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const body = buildRequestBody(request, true)

    let response: Response
    try {
      response = await fetch(buildUrl(auth), {
        method: 'POST',
        headers: buildHeaders(auth),
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        yield { type: 'finish', reason: 'aborted' }
        return
      }
      throw err
    }

    await throwIfNotOk(response)

    if (!response.body) {
      throw new Error('OpenAI API returned empty response body')
    }

    interface ToolCallState {
      id: string
      name: string
      jsonBuffer: string
      emittedStart: boolean
    }

    const toolCalls = new Map<number, ToolCallState>()
    let usage: LLMUsage = { input: 0, output: 0 }
    let stopReason: StopReason = 'stop'

    try {
      for await (const chunk of readOpenAISSE(response.body, signal)) {
        if (chunk.usage) {
          usage = { ...usage, ...mapUsage(chunk.usage) }
        }

        const choice = chunk.choices?.[0]
        if (!choice) continue

        const delta = choice.delta ?? {}

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text-delta', delta: delta.content }
        }

        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield { type: 'thinking-delta', delta: delta.reasoning_content }
        }

        if (delta.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            let state = toolCalls.get(tcDelta.index)
            if (!state) {
              state = {
                id: tcDelta.id ?? '',
                name: tcDelta.function?.name ?? '',
                jsonBuffer: '',
                emittedStart: false,
              }
              toolCalls.set(tcDelta.index, state)
            } else {
              if (tcDelta.id) state.id = tcDelta.id
              if (tcDelta.function?.name) state.name = tcDelta.function.name
            }

            if (!state.emittedStart && state.id && state.name) {
              state.emittedStart = true
              yield { type: 'tool-call-start', id: state.id, name: state.name }
            }

            const argFragment = tcDelta.function?.arguments
            if (typeof argFragment === 'string' && argFragment.length > 0) {
              state.jsonBuffer += argFragment
              if (state.emittedStart) {
                yield {
                  type: 'tool-call-delta',
                  id: state.id,
                  argsJsonDelta: argFragment,
                }
              }
            }
          }
        }

        if (choice.finish_reason) {
          stopReason = mapStopReason(choice.finish_reason)

          // Flush tool calls that accumulated during this choice.
          for (const state of toolCalls.values()) {
            if (!state.emittedStart && state.id && state.name) {
              yield { type: 'tool-call-start', id: state.id, name: state.name }
              state.emittedStart = true
            }
            if (state.emittedStart) {
              let args: Record<string, unknown> = {}
              const trimmed = state.jsonBuffer.trim()
              if (trimmed) {
                try {
                  args = JSON.parse(trimmed) as Record<string, unknown>
                } catch {
                  // leave empty
                }
              }
              yield {
                type: 'tool-call-end',
                id: state.id,
                name: state.name,
                arguments: args,
              }
            }
          }
          toolCalls.clear()
        }
      }

      yield { type: 'usage', usage }
      yield { type: 'finish', reason: stopReason }
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        yield { type: 'finish', reason: 'aborted' }
        return
      }
      throw err
    }
  }

  async complete(
    request: ChatRequest,
    auth: LLMAuth,
    signal?: AbortSignal,
  ): Promise<CompleteResult> {
    const body = buildRequestBody(request, false)

    const response = await fetch(buildUrl(auth), {
      method: 'POST',
      headers: buildHeaders(auth),
      body: JSON.stringify(body),
      signal,
    })

    await throwIfNotOk(response)

    const raw = (await response.json()) as OpenAIResponse
    const choice = raw.choices[0]
    if (!choice) {
      throw new Error('OpenAI API returned no choices')
    }

    return {
      content: convertResponseMessage(choice.message),
      stopReason: mapStopReason(choice.finish_reason),
      usage: mapUsage(raw.usage),
    }
  }
}
