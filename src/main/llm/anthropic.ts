/**
 * Anthropic Messages API client — self-built, zero dependencies on
 * @anthropic-ai/sdk. Uses native fetch + a hand-written SSE parser.
 *
 * Reference: https://docs.anthropic.com/en/api/messages
 *
 * Intentionally omitted from v1 (add later if needed):
 * - cache_control markers (Anthropic caches automatically at >=1024 tokens,
 *   we expose usage counters but don't annotate blocks)
 * - multiple system-prompt blocks (we pass a single string)
 * - stop_sequences
 * - metadata.user_id
 * - tool_choice override (we rely on model's default auto behavior)
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

const DEFAULT_API_VERSION = '2023-06-01'

// ---------------------------------------------------------------------------
// Anthropic wire types — only the fields we read or write. Everything else
// from the API is passed through as `unknown` or ignored.
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
  type: 'text'
  text: string
}

interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface AnthropicImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: Array<{ type: 'text'; text: string }>
  is_error?: boolean
}

type AnthropicUserBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock
type AnthropicAssistantBlock = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolUseBlock

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicUserBlock[] | AnthropicAssistantBlock[]
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicAssistantBlock[]
  model: string
  stop_reason: string | null
  stop_sequence: string | null
  usage: AnthropicUsage
}

// ---------------------------------------------------------------------------
// Message format conversion: canonical Message[] → Anthropic messages[]
// ---------------------------------------------------------------------------

export function convertUserPart(part: UserContentPart): AnthropicUserBlock {
  if (part.type === 'text') {
    return { type: 'text', text: part.text }
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: part.mimeType,
      data: part.data,
    },
  }
}

export function convertAssistantPart(part: AssistantContentPart): AnthropicAssistantBlock {
  if (part.type === 'text') {
    return { type: 'text', text: part.text }
  }
  if (part.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: part.text,
      ...(part.signature ? { signature: part.signature } : {}),
    }
  }
  return {
    type: 'tool_use',
    id: part.id,
    name: part.name,
    input: part.arguments,
  }
}

/**
 * Merge consecutive user/toolResult messages into a single Anthropic user
 * message. Anthropic requires strict user/assistant alternation, and parallel
 * tool_result blocks all live inside one user message.
 */
export function convertMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  let userBuffer: AnthropicUserBlock[] = []

  const flushUser = () => {
    if (userBuffer.length > 0) {
      out.push({ role: 'user', content: userBuffer })
      userBuffer = []
    }
  }

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      flushUser()
      out.push({
        role: 'assistant',
        content: msg.content.map(convertAssistantPart),
      })
      continue
    }

    if (msg.role === 'user') {
      const parts =
        typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content } satisfies AnthropicTextBlock]
          : msg.content.map(convertUserPart)
      userBuffer.push(...parts)
      continue
    }

    // msg.role === 'toolResult'
    userBuffer.push({
      type: 'tool_result',
      tool_use_id: msg.toolCallId,
      content: msg.content.map((c) => ({ type: 'text', text: c.text })),
      ...(msg.isError ? { is_error: true } : {}),
    })
  }

  flushUser()
  return out
}

export function convertResponseBlocks(blocks: AnthropicAssistantBlock[]): AssistantContentPart[] {
  return blocks.map((block): AssistantContentPart => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text }
    }
    if (block.type === 'thinking') {
      return {
        type: 'thinking',
        text: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      }
    }
    return {
      type: 'toolCall',
      id: block.id,
      name: block.name,
      arguments: block.input ?? {},
    }
  })
}

export function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
    case 'refusal':
      return 'stop'
    case 'max_tokens':
      return 'max_tokens'
    case 'tool_use':
      return 'tool_use'
    default:
      return 'stop'
  }
}

export function mapUsage(raw: AnthropicUsage | undefined): LLMUsage {
  return {
    input: raw?.input_tokens ?? 0,
    output: raw?.output_tokens ?? 0,
    ...(raw?.cache_read_input_tokens !== undefined
      ? { cacheRead: raw.cache_read_input_tokens }
      : {}),
    ...(raw?.cache_creation_input_tokens !== undefined
      ? { cacheWrite: raw.cache_creation_input_tokens }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

interface AnthropicRequestBody {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  stream: boolean
  system?: string
  temperature?: number
  tools?: Array<{
    name: string
    description: string
    input_schema: Record<string, unknown>
  }>
  thinking?: {
    type: 'enabled'
    budget_tokens: number
  }
}

export function buildRequestBody(req: ChatRequest, stream: boolean): AnthropicRequestBody {
  const body: AnthropicRequestBody = {
    model: req.model.id,
    max_tokens: req.maxOutputTokens ?? req.model.maxOutputTokens,
    messages: convertMessages(req.messages),
    stream,
  }

  if (req.systemPrompt) {
    body.system = req.systemPrompt
  }

  if (req.temperature !== undefined) {
    body.temperature = req.temperature
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }

  if (req.thinkingBudget !== undefined && req.thinkingBudget > 0 && req.model.supportsThinking) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: req.thinkingBudget,
    }
  }

  return body
}

function buildHeaders(auth: LLMAuth): Record<string, string> {
  return {
    'x-api-key': auth.apiKey,
    'anthropic-version': DEFAULT_API_VERSION,
    'content-type': 'application/json',
    accept: 'application/json',
    ...(auth.headers ?? {}),
  }
}

function buildUrl(auth: LLMAuth): string {
  const base = auth.baseUrl.replace(/\/+$/, '')
  return `${base}/v1/messages`
}

async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return
  const text = await response.text().catch(() => '')
  let message = `Anthropic API ${response.status} ${response.statusText}`
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
// SSE parser — buffers chunks until it finds "\n\n" event boundaries and
// yields { event, data } pairs. Anthropic emits one JSON object per data field.
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string
  data: unknown
}

export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError')
      }

      const { value, done } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        let eventName = ''
        const dataLines: string[] = []
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart())
          }
        }

        if (dataLines.length > 0) {
          const dataStr = dataLines.join('\n')
          try {
            const data = JSON.parse(dataStr) as unknown
            yield { event: eventName, data }
          } catch {
            // Malformed event — skip silently; Anthropic doesn't send these
            // in practice but we should not crash the whole stream.
          }
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
// Stream event translation (Anthropic SSE → canonical StreamEvent)
// ---------------------------------------------------------------------------

interface AnthropicStreamEventBase {
  type: string
}

interface MessageStartEvent extends AnthropicStreamEventBase {
  type: 'message_start'
  message: { usage?: AnthropicUsage }
}

interface ContentBlockStartEvent extends AnthropicStreamEventBase {
  type: 'content_block_start'
  index: number
  content_block: AnthropicAssistantBlock
}

interface ContentBlockDeltaEvent extends AnthropicStreamEventBase {
  type: 'content_block_delta'
  index: number
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'signature_delta'; signature: string }
    | { type: 'input_json_delta'; partial_json: string }
}

interface ContentBlockStopEvent extends AnthropicStreamEventBase {
  type: 'content_block_stop'
  index: number
}

interface MessageDeltaEvent extends AnthropicStreamEventBase {
  type: 'message_delta'
  delta: { stop_reason?: string; stop_sequence?: string | null }
  usage?: AnthropicUsage
}

interface MessageStopEvent extends AnthropicStreamEventBase {
  type: 'message_stop'
}

interface ErrorEvent extends AnthropicStreamEventBase {
  type: 'error'
  error: { type: string; message: string }
}

type AnthropicStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | ErrorEvent
  | { type: 'ping' }

// ---------------------------------------------------------------------------
// AnthropicClient
// ---------------------------------------------------------------------------

export class AnthropicClient implements LLMClient {
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
      throw new Error('Anthropic API returned empty response body')
    }

    const toolCalls = new Map<number, { id: string; name: string; jsonBuffer: string }>()
    let usage: LLMUsage = { input: 0, output: 0 }
    let stopReason: StopReason = 'stop'

    try {
      for await (const { data } of readSSE(response.body, signal)) {
        const evt = data as AnthropicStreamEvent

        switch (evt.type) {
          case 'message_start': {
            usage = { ...usage, ...mapUsage(evt.message?.usage) }
            break
          }

          case 'content_block_start': {
            const block = evt.content_block
            if (block.type === 'tool_use') {
              toolCalls.set(evt.index, {
                id: block.id,
                name: block.name,
                jsonBuffer: '',
              })
              yield { type: 'tool-call-start', id: block.id, name: block.name }
            }
            break
          }

          case 'content_block_delta': {
            const delta = evt.delta
            if (delta.type === 'text_delta') {
              yield { type: 'text-delta', delta: delta.text }
            } else if (delta.type === 'thinking_delta') {
              yield { type: 'thinking-delta', delta: delta.thinking }
            } else if (delta.type === 'input_json_delta') {
              const toolCall = toolCalls.get(evt.index)
              if (toolCall) {
                toolCall.jsonBuffer += delta.partial_json
                yield {
                  type: 'tool-call-delta',
                  id: toolCall.id,
                  argsJsonDelta: delta.partial_json,
                }
              }
            }
            // signature_delta is tracked per-block but we don't stream it
            break
          }

          case 'content_block_stop': {
            const toolCall = toolCalls.get(evt.index)
            if (toolCall) {
              let args: Record<string, unknown> = {}
              const trimmed = toolCall.jsonBuffer.trim()
              if (trimmed) {
                try {
                  args = JSON.parse(trimmed) as Record<string, unknown>
                } catch {
                  // Leave empty; downstream tool executor will error cleanly.
                }
              }
              yield {
                type: 'tool-call-end',
                id: toolCall.id,
                name: toolCall.name,
                arguments: args,
              }
              toolCalls.delete(evt.index)
            }
            break
          }

          case 'message_delta': {
            if (evt.delta?.stop_reason) {
              stopReason = mapStopReason(evt.delta.stop_reason)
            }
            if (evt.usage) {
              // Anthropic sends cumulative output tokens here.
              const merged = mapUsage(evt.usage)
              usage = { ...usage, output: merged.output || usage.output }
            }
            break
          }

          case 'message_stop': {
            yield { type: 'usage', usage }
            yield { type: 'finish', reason: stopReason }
            return
          }

          case 'error': {
            const message = evt.error?.message ?? 'Unknown Anthropic stream error'
            yield { type: 'finish', reason: 'error', errorMessage: message }
            throw new Error(`Anthropic stream error: ${message}`)
          }

          case 'ping':
            break
        }
      }

      // Stream ended without an explicit message_stop — still emit finish.
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

    const raw = (await response.json()) as AnthropicResponse

    return {
      content: convertResponseBlocks(raw.content),
      stopReason: mapStopReason(raw.stop_reason),
      usage: mapUsage(raw.usage),
    }
  }
}
