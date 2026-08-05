import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatMessage, UserContentPart } from '@aila/agent'
import { isStepCount, jsonSchema, type ModelMessage, streamText, type ToolSet } from 'ai'
import { createAiSdkLanguageModel } from './ai-sdk-model-factory'
import type { ModelRegistry } from './model-registry'
import type {
  ModelStreamClient,
  ModelStreamEvent,
  ModelStreamRequest,
  ModelStreamUsage,
} from './model-stream'

const AILA_IMAGE_URL_PREFIX = 'aila-image://i/'
type AiSdkProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

export interface AiSdkModelStreamClientOptions {
  modelRegistry: ModelRegistry
  imageDir?: string
  fetch?: typeof globalThis.fetch
}

/** AI SDK transport adapter. The SDK is deliberately limited to one provider step. */
export function createAiSdkModelStreamClient(
  options: AiSdkModelStreamClientOptions,
): ModelStreamClient {
  return {
    async *stream(input: ModelStreamRequest): AsyncIterable<ModelStreamEvent> {
      const definition = options.modelRegistry.getProviderDefinition(
        input.descriptor.provider,
        input.descriptor.providerType,
      )
      const model = createAiSdkLanguageModel({
        descriptor: input.descriptor,
        definition,
        credential: input.apiKey,
        fetch: options.fetch,
      })
      const prompt = await toAiSdkPrompt(
        input.messages,
        options.imageDir,
        input.requireImages ?? false,
      )
      const tools = toAiSdkTools(input)
      const headers = requestHeaders(input)
      const providerOpts = providerOptions(input)
      const result = streamText({
        model,
        instructions: prompt.instructions,
        messages: prompt.messages,
        tools,
        activeTools: Object.keys(tools),
        ...(Object.keys(tools).length === 0 ? { toolChoice: 'none' as const } : {}),
        ...(input.descriptor.maxTokens !== undefined
          ? { maxOutputTokens: input.descriptor.maxTokens }
          : {}),
        ...(headers ? { headers } : {}),
        ...(providerOpts ? { providerOptions: providerOpts } : {}),
        maxRetries: 0,
        stopWhen: isStepCount(1),
        abortSignal: input.signal,
        onError: () => {},
      })

      for await (const part of result.stream) {
        const event = translateStreamPart(part)
        if (event) yield event
      }
      const responseMessages = (await result.responseMessages).flatMap(toAilaResponseMessages)
      if (responseMessages.length > 0) {
        yield { type: 'response-messages', messages: responseMessages }
      }
    },
  }
}

function toAiSdkTools(input: ModelStreamRequest): ToolSet {
  return Object.fromEntries(
    input.tools.map((tool) => [
      tool.name,
      {
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: jsonSchema(tool.parameters),
      },
    ]),
  )
}

async function toAiSdkPrompt(
  messages: readonly ChatMessage[],
  imageDir: string | undefined,
  requireImages: boolean,
): Promise<{ instructions?: string; messages: ModelMessage[] }> {
  const instructions: string[] = []
  const result: ModelMessage[] = []
  const toolNames = new Map<string, string>()

  for (const message of messages) {
    if (message.role === 'system') {
      instructions.push(message.content)
      continue
    }
    if (message.role === 'user') {
      result.push({
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : await resolveUserContent(message.content, imageDir, requireImages),
      })
      continue
    }
    if (message.role === 'assistant') {
      const toolCalls = message.tool_calls ?? []
      for (const toolCall of toolCalls) toolNames.set(toolCall.id, toolCall.function.name)
      const reasoning = message.reasoning ?? []
      if (toolCalls.length === 0 && reasoning.length === 0) {
        result.push({
          role: 'assistant',
          content: message.content,
          ...(message.providerOptions
            ? { providerOptions: message.providerOptions as AiSdkProviderOptions }
            : {}),
        })
      } else {
        result.push({
          role: 'assistant',
          content: [
            ...reasoning.map((part) => ({
              type: 'reasoning' as const,
              text: part.text,
              ...(part.providerOptions
                ? { providerOptions: part.providerOptions as AiSdkProviderOptions }
                : {}),
            })),
            ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
            ...toolCalls.map((toolCall) => ({
              type: 'tool-call' as const,
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
              input: parseToolInput(toolCall.function.arguments),
              ...(toolCall.providerOptions
                ? { providerOptions: toolCall.providerOptions as AiSdkProviderOptions }
                : {}),
            })),
          ],
          ...(message.providerOptions
            ? { providerOptions: message.providerOptions as AiSdkProviderOptions }
            : {}),
        })
      }
      continue
    }
    result.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: message.tool_call_id,
          toolName: toolNames.get(message.tool_call_id) ?? 'unknown',
          output: { type: 'text', value: message.content },
          ...(message.toolResultProviderOptions
            ? { providerOptions: message.toolResultProviderOptions as AiSdkProviderOptions }
            : {}),
        },
      ],
      ...(message.providerOptions
        ? { providerOptions: message.providerOptions as AiSdkProviderOptions }
        : {}),
    })
  }

  return {
    ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}),
    messages: result,
  }
}

function toAilaResponseMessages(message: unknown): ChatMessage[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return []
  const messageProviderOptions = toProviderOptions(message.providerOptions)
  if (message.role === 'assistant') {
    const text: string[] = []
    const reasoning: NonNullable<Extract<ChatMessage, { role: 'assistant' }>['reasoning']> = []
    const toolCalls: NonNullable<Extract<ChatMessage, { role: 'assistant' }>['tool_calls']> = []
    for (const part of message.content) {
      if (!isRecord(part)) continue
      if (part.type === 'text' && typeof part.text === 'string') text.push(part.text)
      if (part.type === 'reasoning' && typeof part.text === 'string') {
        const partOptions = toProviderOptions(part.providerOptions)
        reasoning.push({
          text: part.text,
          ...(partOptions ? { providerOptions: partOptions } : {}),
        })
      }
      if (
        part.type === 'tool-call' &&
        typeof part.toolCallId === 'string' &&
        typeof part.toolName === 'string'
      ) {
        const partOptions = toProviderOptions(part.providerOptions)
        toolCalls.push({
          id: part.toolCallId,
          type: 'function',
          function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
          ...(partOptions ? { providerOptions: partOptions } : {}),
        })
      }
    }
    return [
      {
        role: 'assistant',
        content: text.join(''),
        ...(reasoning.length > 0 ? { reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(messageProviderOptions ? { providerOptions: messageProviderOptions } : {}),
      },
    ]
  }
  if (message.role !== 'tool') return []
  return message.content.flatMap((part): ChatMessage[] => {
    if (!isRecord(part) || part.type !== 'tool-result' || typeof part.toolCallId !== 'string') {
      return []
    }
    const partOptions = toProviderOptions(part.providerOptions)
    return [
      {
        role: 'tool',
        tool_call_id: part.toolCallId,
        content: toolOutputText(part.output),
        ...(messageProviderOptions ? { providerOptions: messageProviderOptions } : {}),
        ...(partOptions ? { toolResultProviderOptions: partOptions } : {}),
      },
    ]
  })
}

function toProviderOptions(
  value: unknown,
): Extract<ChatMessage, { role: 'assistant' }>['providerOptions'] | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, Record<string, unknown>> = {}
  for (const [provider, options] of Object.entries(value)) {
    if (isRecord(options)) result[provider] = structuredClone(options)
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function toolOutputText(output: unknown): string {
  if (isRecord(output)) {
    if (typeof output.value === 'string') return output.value
    if (output.type === 'json' || output.type === 'error-json') return JSON.stringify(output.value)
    if (output.type === 'execution-denied' && typeof output.reason === 'string')
      return output.reason
  }
  return typeof output === 'string' ? output : JSON.stringify(output ?? null)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function resolveUserContent(
  parts: readonly UserContentPart[],
  imageDir: string | undefined,
  requireImages: boolean,
): Promise<Extract<ModelMessage, { role: 'user' }>['content']> {
  const result: Exclude<Extract<ModelMessage, { role: 'user' }>['content'], string> = []
  for (const part of parts) {
    if (part.type === 'text') {
      result.push({ type: 'text', text: part.text })
      continue
    }
    try {
      const name = imageNameFromUrl(part.url)
      if (!name || !imageDir) throw new Error('unrecognized image url')
      result.push({
        type: 'file',
        data: await readFile(join(imageDir, name)),
        mediaType: part.mime,
      })
    } catch (error) {
      if (requireImages) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Unable to load attached image ${part.url}: ${detail}`)
      }
      result.push({ type: 'text', text: '[attached image is no longer available]' })
    }
  }
  return result
}

function translateStreamPart(
  part: Awaited<ReturnType<typeof streamText>>['stream'] extends AsyncIterable<infer T> ? T : never,
): ModelStreamEvent | null {
  switch (part.type) {
    case 'text-delta':
      return { type: 'text-delta', text: part.text }
    case 'reasoning-delta':
      return { type: 'reasoning-delta', text: part.text }
    case 'tool-input-start':
      return { type: 'tool-input-start', id: part.id, toolName: part.toolName }
    case 'tool-input-delta':
      return { type: 'tool-input-delta', id: part.id, delta: part.delta }
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: part.output,
      }
    case 'tool-error':
      return {
        type: 'tool-error',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        error: part.error,
      }
    case 'finish-step':
      return { type: 'finish-step', usage: normalizeUsage(part.usage) }
    case 'finish':
      return { type: 'finish', totalUsage: normalizeUsage(part.totalUsage) }
    case 'abort':
      return { type: 'abort' }
    case 'error':
      return { type: 'error', error: part.error }
    default:
      return null
  }
}

function normalizeUsage(usage: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  outputTokenDetails?: { reasoningTokens?: number }
  raw?: unknown
}): ModelStreamUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
    cacheMissTokens: usage.inputTokenDetails?.noCacheTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    rawProviderUsage: usage.raw,
  }
}

function requestHeaders(input: ModelStreamRequest): Record<string, string> | undefined {
  const providerType = input.descriptor.providerType ?? input.descriptor.provider
  if (providerType !== 'openrouter') return undefined
  const conversationId = input.conversationId?.trim()
  return {
    'HTTP-Referer': 'https://aila.local',
    'X-Title': (input.descriptor.compat?.openrouterAppName as string | undefined) ?? 'Aila',
    ...(conversationId && input.cache?.openRouterStickySession !== false
      ? { 'x-session-id': conversationId.slice(0, 256) }
      : {}),
  }
}

function providerOptions(input: ModelStreamRequest): AiSdkProviderOptions | undefined {
  const options: AiSdkProviderOptions = {}
  const providerType = input.descriptor.providerType ?? input.descriptor.provider
  if (providerType === 'openai-codex' || input.descriptor.api === 'openai-responses') {
    options.openai = { store: false }
  }
  if (input.cache?.mode !== 'off' && input.descriptor.api === 'anthropic-messages') {
    options.anthropic = {
      cacheControl: {
        type: 'ephemeral',
        ...(input.cache?.ttl === '1h' ? { ttl: '1h' } : {}),
      },
    }
  }
  return Object.keys(options).length > 0 ? options : undefined
}

function parseToolInput(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function imageNameFromUrl(url: string): string | null {
  if (!url.startsWith(AILA_IMAGE_URL_PREFIX)) return null
  const name = url.slice(AILA_IMAGE_URL_PREFIX.length)
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  return name
}
