import type {
  ChatMessage,
  ModelDescriptor,
  RuntimeContextCompactArtifactInput,
  RuntimeContextCompactArtifactResult,
  RuntimeContextTokenCountInput,
  RuntimeContextTokenCountResult,
  Settings,
} from '@aila/agent'
import {
  AILA_CONTEXT_ARTIFACT_SCHEMA_VERSION,
  ContextTokenEstimator,
  type ConversationCompactArtifact,
  normalizeConversationCompactArtifact,
  type PersistedMessage,
} from '@aila/agent'
import { MissingApiKeyError, type NodeAuthInput } from './auth'
import { type CredentialResolver, createCredentialResolver } from './credential-resolver'
import { createDefaultModelStreamClient } from './default-model-stream'
import {
  type CreateModelRegistryInput,
  createModelRegistry,
  type ModelRegistry,
} from './model-registry'
import type { ModelStreamClient } from './model-stream'
import { createProtocolRegistry, type ProtocolAdapter, type ProtocolRegistry } from './protocols'

type Fetch = typeof fetch

const ANTHROPIC_MESSAGES_COUNT_TOKENS_ENDPOINT =
  'https://api.anthropic.com/v1/messages/count_tokens'
const ANTHROPIC_VERSION = '2023-06-01'
const GOOGLE_GENERATIVE_LANGUAGE_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta'
const MAX_COMPACT_SOURCE_CHARS = 24_000
const MAX_COMPACT_SOURCE_MESSAGE_CHARS = 3_000

export interface NodeContextServiceOptions extends NodeAuthInput {
  modelRegistry?: ModelRegistry
  modelRegistryOptions?: CreateModelRegistryInput
  protocolRegistry?: ProtocolRegistry
  protocolAdapters?: ProtocolAdapter[]
  modelStreamClient?: ModelStreamClient
  useNativeProtocols?: boolean
  credentialResolver?: CredentialResolver
  settings?: Settings
  loadSettings?: () => Settings
  fetch?: Fetch
}

export function createNodeContextTokenCounter(
  options: NodeContextServiceOptions = {},
): (input: RuntimeContextTokenCountInput) => Promise<RuntimeContextTokenCountResult> {
  const fetchImpl = options.fetch ?? fetch
  const modelRegistry =
    options.modelRegistry ??
    createModelRegistry(
      options.modelRegistryOptions ?? {
        providers: options.providers,
        connections: options.settings?.connections,
      },
    )
  const credentialResolver =
    options.credentialResolver ?? createCredentialResolver({ ...options, modelRegistry })

  return async (input): Promise<RuntimeContextTokenCountResult> => {
    const settings = options.settings ?? options.loadSettings?.()
    for (const connection of settings?.connections ?? []) {
      modelRegistry.registerConnection(connection)
    }
    const descriptor = modelRegistry.resolve(input.selection)
    try {
      const { value: apiKey } = await credentialResolver.resolve({
        descriptor,
        settings: settings ?? { apiKeys: {}, defaultModel: null },
      })
      const providerType = descriptor.providerType ?? descriptor.provider
      if (
        descriptor.api === 'anthropic-messages' &&
        providerType !== 'claude-subscription' &&
        providerType !== 'github-copilot'
      ) {
        const inputTokens = await countAnthropicTokens(
          descriptor,
          apiKey,
          input.messages,
          fetchImpl,
        )
        return {
          inputTokens,
          method: 'anthropic_count_tokens',
          providerId: descriptor.provider,
          model: descriptor.modelId,
        }
      }
      if (descriptor.api === 'google-generative-ai') {
        const inputTokens = await countGoogleTokens(descriptor, apiKey, input.messages, fetchImpl)
        return {
          inputTokens,
          method: 'google_count_tokens',
          providerId: descriptor.provider,
          model: descriptor.modelId,
        }
      }
    } catch (error) {
      if (!(error instanceof MissingApiKeyError)) throw error
    }

    const estimator = new ContextTokenEstimator({
      modelInfo: {
        model: descriptor.displayName ?? descriptor.modelId,
        contextLength: descriptor.contextLength ?? null,
      },
      providerId: descriptor.provider,
    })
    return {
      inputTokens: estimator.estimateMessages(input.messages).estimatedTokens,
      method: 'provider_char_ratio_fallback',
      providerId: descriptor.provider,
      model: descriptor.modelId,
    }
  }
}

export function createNodeSemanticCompactGenerator(
  options: NodeContextServiceOptions = {},
): (
  input: RuntimeContextCompactArtifactInput,
) => Promise<RuntimeContextCompactArtifactResult | null> {
  const modelRegistry =
    options.modelRegistry ??
    createModelRegistry(
      options.modelRegistryOptions ?? {
        providers: options.providers,
        connections: options.settings?.connections,
      },
    )
  const protocolRegistry =
    options.protocolRegistry ?? createProtocolRegistry(options.protocolAdapters)
  const credentialResolver =
    options.credentialResolver ?? createCredentialResolver({ ...options, modelRegistry })
  const modelStreamClient =
    options.modelStreamClient ??
    createDefaultModelStreamClient({
      protocolRegistry,
      modelRegistry,
      fetch: options.fetch,
      useNativeProtocols: options.useNativeProtocols,
    })

  return async (input): Promise<RuntimeContextCompactArtifactResult | null> => {
    const settings = options.settings ?? options.loadSettings?.()
    for (const connection of settings?.connections ?? []) {
      modelRegistry.registerConnection(connection)
    }
    const descriptor = modelRegistry.resolve(input.selection)
    let apiKey: string
    try {
      apiKey = (
        await credentialResolver.resolve({
          descriptor,
          settings: settings ?? { apiKeys: {}, defaultModel: null },
        })
      ).value
    } catch (error) {
      if (error instanceof MissingApiKeyError) return null
      throw error
    }

    const response = await runCompactModelPass({
      descriptor,
      apiKey,
      modelStreamClient,
      messages: buildCompactMessages(input),
    })
    const parsed = parseCompactResponse(response)
    if (!parsed) return null
    return parsed
  }
}

async function countAnthropicTokens(
  descriptor: ModelDescriptor,
  apiKey: string,
  messages: ChatMessage[],
  fetchImpl: Fetch,
): Promise<number> {
  const conversation = toAnthropicConversation(messages)
  const response = await fetchImpl(resolveAnthropicEndpoint(descriptor), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      ...(descriptor.headers ?? {}),
    },
    body: JSON.stringify({
      model: descriptor.modelId,
      ...(conversation.system ? { system: conversation.system } : {}),
      messages: conversation.messages,
    }),
  })
  if (!response.ok) throw new Error(await readErrorResponse(response, 'Anthropic token counter'))
  const data = (await response.json()) as { input_tokens?: number }
  if (typeof data.input_tokens !== 'number') {
    throw new Error('Anthropic token counter response is missing input_tokens')
  }
  return data.input_tokens
}

async function countGoogleTokens(
  descriptor: ModelDescriptor,
  apiKey: string,
  messages: ChatMessage[],
  fetchImpl: Fetch,
): Promise<number> {
  const conversation = toGoogleConversation(messages)
  const response = await fetchImpl(resolveGoogleCountEndpoint(descriptor), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      ...(descriptor.headers ?? {}),
    },
    body: JSON.stringify({
      contents: conversation.contents,
      ...(conversation.systemInstruction
        ? { systemInstruction: conversation.systemInstruction }
        : {}),
    }),
  })
  if (!response.ok) throw new Error(await readErrorResponse(response, 'Google token counter'))
  const data = (await response.json()) as { totalTokens?: number }
  if (typeof data.totalTokens !== 'number') {
    throw new Error('Google token counter response is missing totalTokens')
  }
  return data.totalTokens
}

async function runCompactModelPass(input: {
  descriptor: ModelDescriptor
  apiKey: string
  modelStreamClient: ModelStreamClient
  messages: ChatMessage[]
}): Promise<string> {
  const controller = new AbortController()
  let text = ''
  for await (const event of input.modelStreamClient.stream({
    descriptor: input.descriptor,
    apiKey: input.apiKey,
    messages: input.messages,
    tools: [],
    signal: controller.signal,
    step: 0,
  })) {
    if (event.type === 'text-delta') text += event.text
    if (event.type === 'error') throw event.error
  }
  return text
}

function buildCompactMessages(input: RuntimeContextCompactArtifactInput): ChatMessage[] {
  const source = renderPersistedMessagesForCompact(input.sourceMessages)
  return [
    {
      role: 'system',
      content:
        'You create compact context artifacts for a coding agent. Respond with JSON only. Do not call tools.',
    },
    {
      role: 'user',
      content: [
        'Create a compact artifact that preserves implementation state for future turns.',
        'Return JSON with keys: summary, userRequests, decisions, files, toolActivity, toolResults, nextSteps.',
        'Keep arrays concise. Preserve file paths, tool result references, decisions, and pending work.',
        '',
        'Existing heuristic artifact:',
        JSON.stringify(input.recommendedCheckpoint.artifact),
        '',
        'Source messages:',
        source,
      ].join('\n'),
    },
  ]
}

function parseCompactResponse(value: string): RuntimeContextCompactArtifactResult | null {
  const json = extractJsonObject(value)
  if (!json) return null
  let parsed: Partial<ConversationCompactArtifact> & { summary?: string }
  try {
    parsed = JSON.parse(json) as Partial<ConversationCompactArtifact> & { summary?: string }
  } catch {
    return null
  }
  const artifact = normalizeConversationCompactArtifact({
    schemaVersion: AILA_CONTEXT_ARTIFACT_SCHEMA_VERSION,
    ...parsed,
    summary: parsed.summary,
  })
  if (!artifact) return null
  return { artifact, summary: artifact.summary }
}

function extractJsonObject(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return extractJsonObject(fenced[1])
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return trimmed.slice(start, end + 1)
}

function renderPersistedMessagesForCompact(messages: PersistedMessage[]): string {
  let used = 0
  const lines: string[] = []
  for (const message of messages) {
    const rendered = renderPersistedMessageForCompact(message)
    const remaining = MAX_COMPACT_SOURCE_CHARS - used
    if (remaining <= 0) break
    const clipped =
      rendered.length > remaining
        ? `${rendered.slice(0, remaining)}\n[compact source truncated]`
        : rendered
    lines.push(clipped)
    used += clipped.length
  }
  return lines.join('\n\n')
}

function renderPersistedMessageForCompact(message: PersistedMessage): string {
  const parts = message.blocks.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return block.content
    if (block.type === 'file') return `[file:${block.name}]\n${block.content}`
    if (block.type === 'image') return `[image:${block.url}]`
    if (block.type === 'tool_call') {
      const result = block.resultRef
        ? `resultRef=${JSON.stringify(block.resultRef)}`
        : block.result
          ? `result=${block.result}`
          : 'no result'
      return `[tool:${block.name} id=${block.id} args=${block.arguments} ${result}]`
    }
    return ''
  })
  const body = parts.join('\n')
  const clipped =
    body.length > MAX_COMPACT_SOURCE_MESSAGE_CHARS
      ? `${body.slice(0, MAX_COMPACT_SOURCE_MESSAGE_CHARS)}\n[message truncated]`
      : body
  return `<message id="${message.id}" role="${message.role}">\n${clipped}\n</message>`
}

function toAnthropicConversation(messages: ChatMessage[]): {
  system: string | null
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
} {
  const system = messages
    .filter(
      (message): message is Extract<ChatMessage, { role: 'system' }> => message.role === 'system',
    )
    .map((message) => message.content)
    .join('\n\n')
  const conversation = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: chatMessageText(message),
    }))
    .filter((message) => message.content.length > 0)
  return {
    system: system || null,
    messages: conversation.length ? conversation : [{ role: 'user', content: 'count' }],
  }
}

function toGoogleConversation(messages: ChatMessage[]): {
  systemInstruction: { parts: Array<{ text: string }> } | null
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>
} {
  const system = messages
    .filter(
      (message): message is Extract<ChatMessage, { role: 'system' }> => message.role === 'system',
    )
    .map((message) => message.content)
    .join('\n\n')
  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: chatMessageText(message) }],
    }))
    .filter((content) => content.parts[0]?.text)
  return {
    systemInstruction: system ? { parts: [{ text: system }] } : null,
    contents: contents.length ? contents : [{ role: 'user', parts: [{ text: 'count' }] }],
  }
}

function chatMessageText(message: ChatMessage): string {
  if (message.role === 'system') return message.content
  if (message.role === 'tool') return `[tool_result:${message.tool_call_id}]\n${message.content}`
  if (message.role === 'assistant') {
    const toolCalls =
      message.tool_calls
        ?.map((call) => `[tool_call:${call.id}:${call.function.name}] ${call.function.arguments}`)
        .join('\n') ?? ''
    return [message.content, toolCalls].filter(Boolean).join('\n')
  }
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .map((part) => (part.type === 'text' ? part.text : `[image:${part.url}]`))
        .join('\n')
}

function resolveAnthropicEndpoint(descriptor: ModelDescriptor): string {
  const base = descriptor.baseUrl?.replace(/\/$/, '')
  return base ? `${base}/v1/messages/count_tokens` : ANTHROPIC_MESSAGES_COUNT_TOKENS_ENDPOINT
}

function resolveGoogleCountEndpoint(descriptor: ModelDescriptor): string {
  const base = descriptor.baseUrl?.replace(/\/$/, '') ?? GOOGLE_GENERATIVE_LANGUAGE_ENDPOINT
  return `${base}/models/${encodeURIComponent(descriptor.modelId)}:countTokens`
}

async function readErrorResponse(response: Response, label: string): Promise<string> {
  const text = await response.text().catch(() => '')
  return `${label} failed (${response.status}): ${text || response.statusText}`
}
