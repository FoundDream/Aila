import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatMessage, ToolCall, UserContentPart } from '../agent-protocol'
import type {
  ModelStreamClient,
  ModelStreamEvent,
  ModelStreamRequest,
  ModelStreamToolDefinition,
  ModelStreamUsage,
} from './model-stream'
import { parseSseJson } from './sse'

const AILA_IMAGE_URL_PREFIX = 'aila-image://i/'
const OPENAI_CHAT_COMPLETIONS_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
const OPENROUTER_CHAT_COMPLETIONS_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

type Fetch = typeof fetch

interface OpenAiCacheControl {
  type: 'ephemeral'
  ttl?: '1h'
}

interface OpenAiContentTextPart {
  type: 'text'
  text: string
  cache_control?: OpenAiCacheControl
}

interface OpenAiContentImagePart {
  type: 'image_url'
  image_url: {
    url: string
  }
}

type OpenAiContentPart = OpenAiContentTextPart | OpenAiContentImagePart

type OpenAiChatMessage =
  | { role: 'system'; content: string | OpenAiContentPart[] }
  | { role: 'user'; content: string | OpenAiContentPart[] }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAiToolCall[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAiChatChunk {
  choices?: Array<{
    delta?: Record<string, unknown>
    finish_reason?: string | null
  }>
  usage?: OpenAiUsage | null
  error?: { message?: string }
}

interface OpenAiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  prompt_tokens_details?: OpenAiTokenDetails | null
  completion_tokens_details?: OpenAiTokenDetails | null
  input_tokens_details?: OpenAiTokenDetails | null
  output_tokens_details?: OpenAiTokenDetails | null
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface OpenAiTokenDetails {
  cached_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  cache_creation_tokens?: number
  reasoning_tokens?: number
}

interface PendingToolCall {
  index: number
  id: string
  name: string
  arguments: string
  started: boolean
  pendingArgumentDelta: string
}

export interface OpenAiChatModelStreamClientOptions {
  imageDir?: string
  fetch?: Fetch
}

export function createOpenAiChatModelStreamClient(
  options: OpenAiChatModelStreamClientOptions = {},
): ModelStreamClient {
  const fetchImpl = options.fetch ?? fetch

  return {
    async *stream(input: ModelStreamRequest): AsyncIterable<ModelStreamEvent> {
      if (input.descriptor.api !== 'openai-chat-completions') {
        throw new Error(`Native OpenAI chat client cannot handle api "${input.descriptor.api}"`)
      }

      const messages = await toOpenAiMessages(input.messages, options.imageDir, input)
      const assistant = createAssistantAccumulator()
      let stepUsage: ModelStreamUsage | undefined

      for await (const chunk of await streamOpenAiChat(input, messages, fetchImpl)) {
        if (chunk.error) throw new Error(chunk.error.message ?? 'OpenAI-compatible stream error')
        if (chunk.usage) stepUsage = normalizeOpenAiUsage(chunk.usage)

        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {}
          const text = stringDelta(delta.content)
          if (text) {
            assistant.content += text
            yield { type: 'text-delta', text }
          }

          const reasoning = reasoningDelta(delta)
          if (reasoning) yield { type: 'reasoning-delta', text: reasoning }

          for (const event of appendToolCallDeltas(assistant.toolCalls, delta)) {
            yield event
          }
        }
      }

      yield { type: 'finish-step', usage: stepUsage }

      for (const toolCall of completedToolCalls(assistant.toolCalls)) {
        yield {
          type: 'tool-call',
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        }
      }
    },
  }
}

function createAssistantAccumulator(): {
  content: string
  toolCalls: Map<number, PendingToolCall>
} {
  return {
    content: '',
    toolCalls: new Map(),
  }
}

async function streamOpenAiChat(
  input: ModelStreamRequest,
  messages: OpenAiChatMessage[],
  fetchImpl: Fetch,
): Promise<AsyncIterable<OpenAiChatChunk>> {
  const openRouterSession = openRouterSessionId(input)
  const openRouterCacheControl = openRouterAutoCacheControl(input)
  const response = await fetchImpl(resolveChatCompletionsEndpoint(input), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      ...openRouterHeaders(input),
      ...(input.descriptor.headers ?? {}),
    },
    body: JSON.stringify({
      model: input.descriptor.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(openRouterSession ? { session_id: openRouterSession } : {}),
      ...(openRouterCacheControl ? { cache_control: openRouterCacheControl } : {}),
      ...(input.tools.length > 0
        ? { tools: input.tools.map(toOpenAiToolDefinition), tool_choice: 'auto' }
        : {}),
    }),
    signal: input.signal,
  })

  if (!response.ok) throw new Error(await readErrorResponse(response))
  if (!response.body) throw new Error('OpenAI-compatible response body is empty')

  return parseSseJson(response.body)
}

function appendToolCallDeltas(
  toolCalls: Map<number, PendingToolCall>,
  delta: Record<string, unknown>,
): ModelStreamEvent[] {
  const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
  const events: ModelStreamEvent[] = []

  for (const raw of rawToolCalls) {
    if (!isRecord(raw)) continue
    const index = typeof raw.index === 'number' ? raw.index : toolCalls.size
    const fn = isRecord(raw.function) ? raw.function : {}
    const current =
      toolCalls.get(index) ??
      ({
        index,
        id: '',
        name: '',
        arguments: '',
        started: false,
        pendingArgumentDelta: '',
      } satisfies PendingToolCall)

    const id = stringDelta(raw.id)
    const name = stringDelta(fn.name)
    const argumentDelta = stringDelta(fn.arguments)
    if (id) current.id = id
    if (name) current.name += name

    if (!current.started && current.id && current.name) {
      current.started = true
      events.push({ type: 'tool-input-start', id: current.id, toolName: current.name })
      if (current.pendingArgumentDelta) {
        events.push({
          type: 'tool-input-delta',
          id: current.id,
          delta: current.pendingArgumentDelta,
        })
        current.pendingArgumentDelta = ''
      }
    }

    if (argumentDelta) {
      current.arguments += argumentDelta
      if (current.started) {
        events.push({ type: 'tool-input-delta', id: current.id, delta: argumentDelta })
      } else {
        current.pendingArgumentDelta += argumentDelta
      }
    }

    toolCalls.set(index, current)
  }

  return events
}

function completedToolCalls(toolCalls: Map<number, PendingToolCall>): OpenAiToolCall[] {
  return Array.from(toolCalls.values())
    .sort((a, b) => a.index - b.index)
    .filter((toolCall) => toolCall.id && toolCall.name)
    .map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }))
}

function toOpenAiToolDefinition(tool: ModelStreamToolDefinition) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

async function toOpenAiMessages(
  messages: ChatMessage[],
  imageDir?: string,
  input?: ModelStreamRequest,
): Promise<OpenAiChatMessage[]> {
  const out: OpenAiChatMessage[] = []
  const explicitCacheControl = input ? openRouterExplicitCacheControl(input) : null
  const explicitSystemIndex = explicitCacheControl ? lastSystemMessageIndex(messages) : -1

  for (const [index, msg] of messages.entries()) {
    if (msg.role === 'system') {
      out.push({
        role: 'system',
        content:
          index === explicitSystemIndex && explicitCacheControl
            ? [{ type: 'text', text: msg.content, cache_control: explicitCacheControl }]
            : msg.content,
      })
      continue
    }
    if (msg.role === 'user') {
      out.push({
        role: 'user',
        content:
          typeof msg.content === 'string'
            ? msg.content
            : await resolveOpenAiUserContent(msg.content, imageDir),
      })
      continue
    }
    if (msg.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: msg.content || null,
        ...(msg.tool_calls && msg.tool_calls.length > 0
          ? { tool_calls: msg.tool_calls.map(toOpenAiToolCall) }
          : {}),
      })
      continue
    }
    if (msg.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: msg.tool_call_id, content: msg.content })
    }
  }

  return out
}

function lastSystemMessageIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'system') return index
  }
  return -1
}

function toOpenAiToolCall(toolCall: ToolCall): OpenAiToolCall {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  }
}

async function resolveOpenAiUserContent(
  parts: UserContentPart[],
  imageDir?: string,
): Promise<OpenAiContentPart[]> {
  const out: OpenAiContentPart[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text })
      continue
    }
    const name = imageNameFromUrl(part.url)
    try {
      if (!name || !imageDir) throw new Error('unrecognized image url')
      const bytes = await readFile(join(imageDir, name))
      out.push({
        type: 'image_url',
        image_url: {
          url: `data:${part.mime};base64,${Buffer.from(bytes).toString('base64')}`,
        },
      })
    } catch {
      out.push({ type: 'text', text: '[attached image is no longer available]' })
    }
  }
  return out
}

function resolveChatCompletionsEndpoint(input: ModelStreamRequest): string {
  if (input.descriptor.baseUrl) {
    return `${input.descriptor.baseUrl.replace(/\/+$/, '')}/chat/completions`
  }
  return input.descriptor.provider === 'openrouter'
    ? OPENROUTER_CHAT_COMPLETIONS_ENDPOINT
    : OPENAI_CHAT_COMPLETIONS_ENDPOINT
}

function openRouterHeaders(input: ModelStreamRequest): Record<string, string> {
  if (input.descriptor.provider !== 'openrouter') return {}
  const sessionId = openRouterSessionId(input)
  return {
    'HTTP-Referer': 'https://aila.local',
    'X-Title': (input.descriptor.compat?.openrouterAppName as string | undefined) ?? 'Aila',
    ...(sessionId ? { 'x-session-id': sessionId } : {}),
  }
}

function openRouterSessionId(input: ModelStreamRequest): string | null {
  if (input.descriptor.provider !== 'openrouter') return null
  if (input.cache?.mode === 'off' || input.cache?.openRouterStickySession === false) return null
  const conversationId = input.conversationId?.trim()
  return conversationId ? conversationId.slice(0, 256) : null
}

function openRouterAutoCacheControl(input: ModelStreamRequest): OpenAiCacheControl | null {
  if (input.cache?.mode !== 'auto') return null
  if (!isOpenRouterAnthropicModel(input)) return null
  return promptCacheControl(input)
}

function openRouterExplicitCacheControl(input: ModelStreamRequest): OpenAiCacheControl | null {
  if (input.cache?.mode !== 'explicit') return null
  if (!isOpenRouterAnthropicModel(input)) return null
  return promptCacheControl(input)
}

function promptCacheControl(input: ModelStreamRequest): OpenAiCacheControl {
  return {
    type: 'ephemeral',
    ...(input.cache?.ttl === '1h' ? { ttl: '1h' } : {}),
  }
}

function isOpenRouterAnthropicModel(input: ModelStreamRequest): boolean {
  if (input.descriptor.provider !== 'openrouter') return false
  const modelId = input.descriptor.modelId.toLowerCase()
  return modelId.includes('anthropic/') || modelId.includes('claude')
}

async function readErrorResponse(response: Response): Promise<string> {
  const fallback = `OpenAI-compatible request failed with HTTP ${response.status}`
  try {
    const body = (await response.text()).trim()
    if (!body) return fallback
    try {
      const parsed = JSON.parse(body) as unknown
      if (isRecord(parsed)) {
        const error = parsed.error
        if (isRecord(error) && typeof error.message === 'string') return error.message
      }
    } catch {
      // Preserve the original body below.
    }
    return body.length > 500 ? `${body.slice(0, 500)}...` : body
  } catch {
    return fallback
  }
}

function normalizeOpenAiUsage(usage: OpenAiUsage): ModelStreamUsage {
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0
  const promptDetails = usage.prompt_tokens_details ?? usage.input_tokens_details ?? undefined
  const outputDetails = usage.completion_tokens_details ?? usage.output_tokens_details ?? undefined
  const cacheReadTokens = firstFiniteToken(
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
    promptDetails?.cached_tokens,
    promptDetails?.cache_read_tokens,
  )
  const cacheWriteTokens = firstFiniteToken(
    usage.cache_creation_input_tokens,
    promptDetails?.cache_write_tokens,
    promptDetails?.cache_creation_tokens,
  )
  const cacheMissTokens = firstFiniteToken(
    usage.prompt_cache_miss_tokens,
    cacheReadTokens !== undefined || cacheWriteTokens !== undefined
      ? Math.max(inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0), 0)
      : undefined,
  )
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(cacheMissTokens !== undefined ? { cacheMissTokens } : {}),
    ...(firstFiniteToken(outputDetails?.reasoning_tokens) !== undefined
      ? { reasoningTokens: firstFiniteToken(outputDetails?.reasoning_tokens) }
      : {}),
    rawProviderUsage: usage,
  }
}

function firstFiniteToken(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
  }
  return undefined
}

function parseToolArguments(args: string): Record<string, unknown> {
  try {
    const parsed = args ? (JSON.parse(args) as unknown) : {}
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function reasoningDelta(delta: Record<string, unknown>): string {
  return (
    stringDelta(delta.reasoning) ||
    stringDelta(delta.reasoning_content) ||
    stringDelta(delta.reasoning_text)
  )
}

function stringDelta(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function imageNameFromUrl(url: string): string | null {
  if (!url.startsWith(AILA_IMAGE_URL_PREFIX)) return null
  const name = url.slice(AILA_IMAGE_URL_PREFIX.length)
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  return name
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
