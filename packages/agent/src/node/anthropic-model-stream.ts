import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatMessage, UserContentPart } from '../agent-protocol'
import type {
  ModelStreamClient,
  ModelStreamEvent,
  ModelStreamRequest,
  ModelStreamToolDefinition,
  ModelStreamUsage,
} from './model-stream'
import { parseSseJson } from './sse'

const AILA_IMAGE_URL_PREFIX = 'aila-image://i/'
const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

type Fetch = typeof fetch

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicStreamEvent {
  type?: string
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  usage?: AnthropicUsage
  message?: { usage?: AnthropicUsage }
  error?: { message?: string }
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
}

interface PendingAnthropicToolCall {
  index: number
  id: string
  name: string
  inputJson: string
  started: boolean
}

export interface AnthropicModelStreamClientOptions {
  imageDir?: string
  fetch?: Fetch
}

export function createAnthropicModelStreamClient(
  options: AnthropicModelStreamClientOptions = {},
): ModelStreamClient {
  const fetchImpl = options.fetch ?? fetch

  return {
    async *stream(input: ModelStreamRequest): AsyncIterable<ModelStreamEvent> {
      if (input.descriptor.api !== 'anthropic-messages') {
        throw new Error(`Native Anthropic client cannot handle api "${input.descriptor.api}"`)
      }

      const conversation = await toAnthropicConversation(input.messages, options.imageDir)
      const toolCalls = new Map<number, PendingAnthropicToolCall>()
      let stepUsage: ModelStreamUsage | undefined

      for await (const event of await streamAnthropic(input, conversation, fetchImpl)) {
        if (event.type === 'error')
          throw new Error(event.error?.message ?? 'Anthropic stream error')
        if (event.type === 'message_start' && event.message?.usage) {
          stepUsage = mergeAnthropicUsage(stepUsage, event.message.usage)
        }
        if (event.type === 'message_delta' && event.usage) {
          stepUsage = mergeAnthropicUsage(stepUsage, event.usage)
        }

        if (event.type === 'content_block_start') {
          const block = event.content_block ?? {}
          if (block.type === 'tool_use') {
            const id = stringValue(block.id)
            const name = stringValue(block.name)
            const pending: PendingAnthropicToolCall = {
              index: event.index ?? toolCalls.size,
              id,
              name,
              inputJson: '',
              started: Boolean(id && name),
            }
            toolCalls.set(pending.index, pending)
            if (pending.started) {
              yield { type: 'tool-input-start', id: pending.id, toolName: pending.name }
            }
          }
          continue
        }

        if (event.type !== 'content_block_delta') continue
        const delta = event.delta ?? {}
        if (delta.type === 'text_delta') {
          const text = stringValue(delta.text)
          if (text) yield { type: 'text-delta', text }
          continue
        }
        if (delta.type === 'thinking_delta') {
          const text = stringValue(delta.thinking)
          if (text) yield { type: 'reasoning-delta', text }
          continue
        }
        if (delta.type === 'input_json_delta') {
          const index = event.index ?? toolCalls.size
          const pending =
            toolCalls.get(index) ??
            ({
              index,
              id: `anthropic-tool-${input.step ?? 0}-${index}`,
              name: '',
              inputJson: '',
              started: false,
            } satisfies PendingAnthropicToolCall)
          const partialJson = stringValue(delta.partial_json)
          pending.inputJson += partialJson
          if (pending.id && pending.name && !pending.started) {
            pending.started = true
            yield { type: 'tool-input-start', id: pending.id, toolName: pending.name }
          }
          if (partialJson && pending.started) {
            yield { type: 'tool-input-delta', id: pending.id, delta: partialJson }
          }
          toolCalls.set(index, pending)
        }
      }

      yield { type: 'finish-step', usage: stepUsage }

      for (const toolCall of Array.from(toolCalls.values())
        .sort((a, b) => a.index - b.index)
        .filter((candidate) => candidate.id && candidate.name)) {
        yield {
          type: 'tool-call',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: parseToolArguments(toolCall.inputJson),
        }
      }
    },
  }
}

async function streamAnthropic(
  input: ModelStreamRequest,
  conversation: AnthropicConversation,
  fetchImpl: Fetch,
): Promise<AsyncIterable<AnthropicStreamEvent>> {
  const response = await fetchImpl(resolveAnthropicEndpoint(input), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': input.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      ...(input.descriptor.headers ?? {}),
    },
    body: JSON.stringify({
      model: input.descriptor.modelId,
      max_tokens: input.descriptor.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      ...(conversation.system ? { system: conversation.system } : {}),
      messages: conversation.messages,
      ...(input.tools.length > 0 ? { tools: input.tools.map(toAnthropicTool) } : {}),
    }),
    signal: input.signal,
  })

  if (!response.ok) throw new Error(await readErrorResponse(response, 'Anthropic'))
  if (!response.body) throw new Error('Anthropic response body is empty')
  return parseSseJson(response.body)
}

interface AnthropicConversation {
  system: string | null
  messages: AnthropicMessage[]
}

async function toAnthropicConversation(
  messages: ChatMessage[],
  imageDir?: string,
): Promise<AnthropicConversation> {
  const system: string[] = []
  const out: AnthropicMessage[] = []
  const toolNameById = new Map<string, string>()

  for (const msg of messages) {
    if (msg.role === 'system') {
      system.push(msg.content)
      continue
    }
    if (msg.role === 'user') {
      out.push({
        role: 'user',
        content:
          typeof msg.content === 'string'
            ? msg.content
            : await resolveAnthropicUserContent(msg.content, imageDir),
      })
      continue
    }
    if (msg.role === 'assistant') {
      const content: AnthropicContentBlock[] = []
      if (msg.content) content.push({ type: 'text', text: msg.content })
      for (const toolCall of msg.tool_calls ?? []) {
        toolNameById.set(toolCall.id, toolCall.function.name)
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        })
      }
      out.push({ role: 'assistant', content: content.length > 0 ? content : msg.content })
      continue
    }
    if (msg.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          },
        ],
      })
      if (!toolNameById.has(msg.tool_call_id)) toolNameById.set(msg.tool_call_id, 'unknown')
    }
  }

  return {
    system: system.length > 0 ? system.join('\n\n') : null,
    messages: out,
  }
}

async function resolveAnthropicUserContent(
  parts: UserContentPart[],
  imageDir?: string,
): Promise<AnthropicContentBlock[]> {
  const out: AnthropicContentBlock[] = []
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
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mime,
          data: Buffer.from(bytes).toString('base64'),
        },
      })
    } catch {
      out.push({ type: 'text', text: '[attached image is no longer available]' })
    }
  }
  return out
}

function toAnthropicTool(tool: ModelStreamToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }
}

function resolveAnthropicEndpoint(input: ModelStreamRequest): string {
  if (input.descriptor.baseUrl) return `${input.descriptor.baseUrl.replace(/\/+$/, '')}/messages`
  return ANTHROPIC_MESSAGES_ENDPOINT
}

function mergeAnthropicUsage(
  previous: ModelStreamUsage | undefined,
  usage: AnthropicUsage,
): ModelStreamUsage {
  const inputTokens = usage.input_tokens ?? previous?.inputTokens ?? 0
  const outputTokens = usage.output_tokens ?? previous?.outputTokens ?? 0
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  }
}

async function readErrorResponse(response: Response, provider: string): Promise<string> {
  const fallback = `${provider} request failed with HTTP ${response.status}`
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

function parseToolArguments(args: string): Record<string, unknown> {
  try {
    const parsed = args ? (JSON.parse(args) as unknown) : {}
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stringValue(value: unknown): string {
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
