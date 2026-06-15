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

const MAX_STEPS = 10
const AILA_IMAGE_URL_PREFIX = 'aila-image://i/'
const GOOGLE_GENERATIVE_LANGUAGE_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta'

type Fetch = typeof fetch

type GooglePart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

interface GoogleContent {
  role: 'user' | 'model'
  parts: GooglePart[]
}

interface GoogleStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: GooglePart[]
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  error?: { message?: string }
}

interface AccumulatedUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

interface PendingGoogleToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface GoogleModelStreamClientOptions {
  imageDir?: string
  fetch?: Fetch
}

export function createGoogleModelStreamClient(
  options: GoogleModelStreamClientOptions = {},
): ModelStreamClient {
  const fetchImpl = options.fetch ?? fetch

  return {
    async *stream(input: ModelStreamRequest): AsyncIterable<ModelStreamEvent> {
      if (input.descriptor.api !== 'google-generative-ai') {
        throw new Error(`Native Google client cannot handle api "${input.descriptor.api}"`)
      }

      const conversation = await toGoogleConversation(input.messages, options.imageDir)
      const totalUsage: AccumulatedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

      for (let step = 0; step < MAX_STEPS; step += 1) {
        const modelParts: GooglePart[] = []
        const toolCalls: PendingGoogleToolCall[] = []
        let stepUsage: ModelStreamUsage | undefined

        for await (const chunk of await streamGoogle(input, conversation, fetchImpl)) {
          if (chunk.error) throw new Error(chunk.error.message ?? 'Google stream error')
          if (chunk.usageMetadata) stepUsage = normalizeGoogleUsage(chunk.usageMetadata)

          for (const candidate of chunk.candidates ?? []) {
            for (const part of candidate.content?.parts ?? []) {
              if ('text' in part && part.text) {
                modelParts.push({ text: part.text })
                yield { type: 'text-delta', text: part.text }
                continue
              }
              if ('functionCall' in part) {
                const toolCall: PendingGoogleToolCall = {
                  id: `google-tool-${step}-${toolCalls.length}`,
                  name: part.functionCall.name,
                  args: part.functionCall.args ?? {},
                }
                toolCalls.push(toolCall)
                modelParts.push({
                  functionCall: {
                    name: toolCall.name,
                    args: toolCall.args,
                  },
                })
                const args = JSON.stringify(toolCall.args)
                yield { type: 'tool-input-start', id: toolCall.id, toolName: toolCall.name }
                if (args && args !== '{}') {
                  yield { type: 'tool-input-delta', id: toolCall.id, delta: args }
                }
              }
            }
          }
        }

        if (stepUsage) addUsage(totalUsage, stepUsage)
        yield { type: 'finish-step', usage: stepUsage }

        if (toolCalls.length === 0) {
          yield { type: 'finish', totalUsage }
          return
        }

        conversation.contents.push({ role: 'model', parts: modelParts })
        const responseParts: GooglePart[] = []

        for (const toolCall of toolCalls) {
          const tool = input.tools.find((td) => td.name === toolCall.name)
          yield {
            type: 'tool-call',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.args,
          }

          if (!tool) {
            const message = `Unknown tool "${toolCall.name}"`
            yield {
              type: 'tool-error',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              error: new Error(message),
            }
            responseParts.push(toGoogleFunctionResponse(toolCall.name, message, true))
            continue
          }

          try {
            const output = await tool.execute(toolCall.args, { toolCallId: toolCall.id })
            yield {
              type: 'tool-result',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              output,
            }
            responseParts.push(toGoogleFunctionResponse(toolCall.name, stringifyToolOutput(output)))
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            yield { type: 'tool-error', toolCallId: toolCall.id, toolName: toolCall.name, error }
            responseParts.push(toGoogleFunctionResponse(toolCall.name, message, true))
          }
        }

        conversation.contents.push({ role: 'user', parts: responseParts })
      }

      throw new Error(`Maximum model tool steps exceeded (${MAX_STEPS})`)
    },
  }
}

async function streamGoogle(
  input: ModelStreamRequest,
  conversation: GoogleConversation,
  fetchImpl: Fetch,
): Promise<AsyncIterable<GoogleStreamChunk>> {
  const response = await fetchImpl(resolveGoogleEndpoint(input), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': input.apiKey,
      ...(input.descriptor.headers ?? {}),
    },
    body: JSON.stringify({
      contents: conversation.contents,
      ...(conversation.systemInstruction
        ? { systemInstruction: conversation.systemInstruction }
        : {}),
      ...(input.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: input.tools.map(toGoogleFunctionDeclaration),
              },
            ],
          }
        : {}),
    }),
    signal: input.signal,
  })

  if (!response.ok) throw new Error(await readErrorResponse(response, 'Google'))
  if (!response.body) throw new Error('Google response body is empty')
  return parseSseJson(response.body)
}

interface GoogleConversation {
  systemInstruction: { parts: Array<{ text: string }> } | null
  contents: GoogleContent[]
}

async function toGoogleConversation(
  messages: ChatMessage[],
  imageDir?: string,
): Promise<GoogleConversation> {
  const system: string[] = []
  const contents: GoogleContent[] = []
  const toolNameById = new Map<string, string>()

  for (const msg of messages) {
    if (msg.role === 'system') {
      system.push(msg.content)
      continue
    }
    if (msg.role === 'user') {
      contents.push({
        role: 'user',
        parts:
          typeof msg.content === 'string'
            ? [{ text: msg.content }]
            : await resolveGoogleUserContent(msg.content, imageDir),
      })
      continue
    }
    if (msg.role === 'assistant') {
      const parts: GooglePart[] = []
      if (msg.content) parts.push({ text: msg.content })
      for (const toolCall of msg.tool_calls ?? []) {
        toolNameById.set(toolCall.id, toolCall.function.name)
        parts.push(toGoogleFunctionCall(toolCall))
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }
    if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          toGoogleFunctionResponse(toolNameById.get(msg.tool_call_id) ?? 'unknown', msg.content),
        ],
      })
    }
  }

  return {
    systemInstruction: system.length > 0 ? { parts: [{ text: system.join('\n\n') }] } : null,
    contents,
  }
}

async function resolveGoogleUserContent(
  parts: UserContentPart[],
  imageDir?: string,
): Promise<GooglePart[]> {
  const out: GooglePart[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      out.push({ text: part.text })
      continue
    }
    const name = imageNameFromUrl(part.url)
    try {
      if (!name || !imageDir) throw new Error('unrecognized image url')
      const bytes = await readFile(join(imageDir, name))
      out.push({
        inlineData: {
          mimeType: part.mime,
          data: Buffer.from(bytes).toString('base64'),
        },
      })
    } catch {
      out.push({ text: '[attached image is no longer available]' })
    }
  }
  return out
}

function toGoogleFunctionDeclaration(tool: ModelStreamToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

function toGoogleFunctionCall(toolCall: ToolCall): GooglePart {
  return {
    functionCall: {
      name: toolCall.function.name,
      args: parseToolArguments(toolCall.function.arguments),
    },
  }
}

function toGoogleFunctionResponse(name: string, output: string, isError = false): GooglePart {
  return {
    functionResponse: {
      name,
      response: isError ? { error: output } : { content: output },
    },
  }
}

function resolveGoogleEndpoint(input: ModelStreamRequest): string {
  const baseUrl = input.descriptor.baseUrl
    ? input.descriptor.baseUrl.replace(/\/+$/, '')
    : GOOGLE_GENERATIVE_LANGUAGE_ENDPOINT
  return `${baseUrl}/models/${encodeURIComponent(input.descriptor.modelId)}:streamGenerateContent?alt=sse`
}

function normalizeGoogleUsage(
  usage: NonNullable<GoogleStreamChunk['usageMetadata']>,
): ModelStreamUsage {
  const inputTokens = usage.promptTokenCount ?? 0
  const outputTokens = usage.candidatesTokenCount ?? 0
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokenCount ?? inputTokens + outputTokens,
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

function addUsage(total: AccumulatedUsage, usage: ModelStreamUsage): void {
  total.inputTokens += usage.inputTokens ?? 0
  total.outputTokens += usage.outputTokens ?? 0
  total.totalTokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

function parseToolArguments(args: string): Record<string, unknown> {
  try {
    const parsed = args ? (JSON.parse(args) as unknown) : {}
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stringifyToolOutput(output: unknown): string {
  return typeof output === 'string' ? output : output == null ? '' : JSON.stringify(output)
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
