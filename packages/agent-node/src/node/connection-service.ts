import {
  type ConnectionModel,
  type ConnectionModelDiscoveryResult,
  type ConnectionProfile,
  type ConnectionTestErrorClass,
  type ConnectionTestResult,
  MODEL_CATALOG,
  type ModelApi,
  type ModelDescriptor,
  type Settings,
} from '@aila/agent'
import type { CredentialResolver } from './credential-resolver'
import type { ModelRegistry } from './model-registry'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_MODELS = 1_000
const MAX_MODEL_ID_LENGTH = 256
const ERROR_PREVIEW_LENGTH = 240
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024

export interface ConnectionServiceOptions {
  modelRegistry: ModelRegistry
  credentialResolver: CredentialResolver
  loadSettings: () => Settings
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export interface ConnectionEffectInput {
  profile: ConnectionProfile
  /** A form-only secret. It is consumed by the effect and never returned. */
  credential?: string
}

export interface ConnectionTestInput extends ConnectionEffectInput {
  modelId?: string
}

export interface ConnectionService {
  discoverModels(input: ConnectionEffectInput): Promise<ConnectionModelDiscoveryResult>
  testConnection(input: ConnectionTestInput): Promise<ConnectionTestResult>
}

export function createConnectionService(options: ConnectionServiceOptions): ConnectionService {
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function resolveEffect(
    input: ConnectionEffectInput,
    requireModel = true,
  ): Promise<{
    descriptor: ModelDescriptor
    credential: string
    settings: Settings
  }> {
    const profile = normalizeConnectionProfile(input.profile)
    const settings = settingsWithConnection(options.loadSettings(), profile)
    const descriptor = connectionDescriptor(profile, options.modelRegistry, requireModel)
    const credential = input.credential?.trim()
      ? input.credential.trim()
      : (await options.credentialResolver.resolve({ descriptor, settings })).value
    return { descriptor, credential, settings }
  }

  return {
    async discoverModels(input) {
      const startedAt = Date.now()
      const { descriptor, credential } = await resolveEffect(input, false)
      const definition = options.modelRegistry.getProviderDefinition(
        descriptor.provider,
        descriptor.providerType,
      )
      if (definition.modelDiscovery?.kind === 'static') {
        return fallbackModels(input.profile, Date.now())
      }
      const models = await fetchModels({
        descriptor,
        credential,
        fetchImpl,
        timeoutMs,
      })
      if (models.length === 0) {
        const fallback = fallbackModels(input.profile, startedAt)
        if (fallback.models.length > 0) return fallback
      }
      return { models, source: 'fetched', fetchedAt: Date.now() }
    },

    async testConnection(input) {
      const startedAt = Date.now()
      try {
        const resolved = await resolveEffect({
          profile: {
            ...input.profile,
            ...(input.modelId?.trim() ? { defaultModel: input.modelId.trim() } : {}),
          },
          ...(input.credential !== undefined ? { credential: input.credential } : {}),
        })
        const response = await probeConnection({
          descriptor: resolved.descriptor,
          credential: resolved.credential,
          fetchImpl,
          timeoutMs,
        })
        if (!response.ok) {
          const errorMessage = await responseError(response, timeoutMs)
          return {
            ok: false,
            latencyMs: Date.now() - startedAt,
            modelTested: resolved.descriptor.modelId,
            statusCode: response.status,
            errorClass: classifyStatus(response.status),
            errorMessage,
          }
        }
        await response.body?.cancel().catch(() => {})
        return {
          ok: true,
          latencyMs: Date.now() - startedAt,
          modelTested: resolved.descriptor.modelId,
        }
      } catch (error) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          errorClass: classifyError(error),
          errorMessage: safeErrorMessage(error),
        }
      }
    },
  }
}

interface ProviderRequestInput {
  descriptor: ModelDescriptor
  credential: string
  fetchImpl: typeof globalThis.fetch
  timeoutMs: number
}

async function fetchModels(input: ProviderRequestInput): Promise<ConnectionModel[]> {
  const definitionAdapter = input.descriptor.providerType ?? input.descriptor.provider
  const baseUrl = requireBaseUrl(input.descriptor)
  if (definitionAdapter === 'openai-codex') {
    const response = await request(input, `${stripTrailing(baseUrl)}/models?client_version=1.0.0`, {
      headers: { ...bearerHeaders(input.credential), ...openAiCodexHeaders(input.credential) },
    })
    const payload = await readJson(response, input.timeoutMs)
    const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models : []
    return normalizeModels(
      models.flatMap((model) => {
        if (!isRecord(model) || typeof model.slug !== 'string') return []
        const visibility =
          typeof model.visibility === 'string' ? model.visibility.toLowerCase() : ''
        if (visibility === 'hide' || visibility === 'hidden') return []
        return [
          {
            id: model.slug,
            api: 'openai-responses' as const,
            ...(positiveNumber(model.context_window)
              ? { contextLength: positiveNumber(model.context_window) }
              : {}),
          },
        ]
      }),
    )
  }

  if (definitionAdapter === 'github-copilot') {
    const response = await request(input, `${stripTrailing(baseUrl)}/models`, {
      headers: {
        ...bearerHeaders(input.credential),
        ...githubCopilotHeaders(),
      },
    })
    const payload = await readJson(response, input.timeoutMs)
    const models = isRecord(payload) && Array.isArray(payload.data) ? payload.data : []
    return normalizeModels(models.flatMap(toGitHubCopilotModel))
  }

  if (input.descriptor.api === 'anthropic-messages') {
    const response = await request(input, `${anthropicV1BaseUrl(baseUrl)}/models`, {
      headers:
        definitionAdapter === 'claude-subscription'
          ? {
              ...bearerHeaders(input.credential),
              ...claudeSubscriptionHeaders(),
              'anthropic-version': '2023-06-01',
            }
          : { 'x-api-key': input.credential, 'anthropic-version': '2023-06-01' },
    })
    const payload = await readJson(response, input.timeoutMs)
    const models = isRecord(payload) && Array.isArray(payload.data) ? payload.data : []
    return normalizeModels(models.flatMap((model) => toGenericModel(model, input.descriptor.api)))
  }

  if (input.descriptor.api === 'google-generative-ai') {
    const url = `${googleV1BetaBaseUrl(baseUrl)}/models?key=${encodeURIComponent(input.credential)}`
    const response = await request(input, url)
    const payload = await readJson(response, input.timeoutMs)
    const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models : []
    return normalizeModels(
      models.flatMap((model) => {
        if (!isRecord(model) || typeof model.name !== 'string') return []
        const id = model.name.split('/').pop()
        return id ? [{ id, displayName: stringValue(model.displayName) }] : []
      }),
    )
  }

  const response = await request(input, `${stripTrailing(baseUrl)}/models`, {
    headers: input.credential ? bearerHeaders(input.credential) : undefined,
  })
  const payload = await readJson(response, input.timeoutMs)
  const models = isRecord(payload) && Array.isArray(payload.data) ? payload.data : []
  return normalizeModels(models.flatMap((model) => toGenericModel(model, input.descriptor.api)))
}

async function probeConnection(input: ProviderRequestInput): Promise<Response> {
  const providerType = input.descriptor.providerType ?? input.descriptor.provider
  const baseUrl = requireBaseUrl(input.descriptor)
  if (providerType === 'claude-subscription') {
    return request(input, `${anthropicV1BaseUrl(baseUrl)}/models`, {
      headers: {
        ...bearerHeaders(input.credential),
        ...claudeSubscriptionHeaders(),
        'anthropic-version': '2023-06-01',
      },
      acceptFailure: true,
    })
  }
  if (providerType === 'github-copilot') {
    return request(input, `${stripTrailing(baseUrl)}/models`, {
      headers: { ...bearerHeaders(input.credential), ...githubCopilotHeaders() },
      acceptFailure: true,
    })
  }
  if (providerType === 'openai-codex') {
    return request(input, `${stripTrailing(baseUrl)}/models?client_version=1.0.0`, {
      headers: { ...bearerHeaders(input.credential), ...openAiCodexHeaders(input.credential) },
      acceptFailure: true,
    })
  }
  if (input.descriptor.api === 'anthropic-messages') {
    return request(input, `${anthropicV1BaseUrl(baseUrl)}/messages`, {
      method: 'POST',
      headers:
        providerType === 'claude-subscription'
          ? {
              ...bearerHeaders(input.credential),
              ...claudeSubscriptionHeaders(),
              'anthropic-version': '2023-06-01',
            }
          : { 'x-api-key': input.credential, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: input.descriptor.modelId,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
      acceptFailure: true,
    })
  }
  if (input.descriptor.api === 'google-generative-ai') {
    return request(
      input,
      `${googleV1BetaBaseUrl(baseUrl)}/models/${encodeURIComponent(input.descriptor.modelId)}:generateContent?key=${encodeURIComponent(input.credential)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 16 },
        }),
        acceptFailure: true,
      },
    )
  }
  const responses = input.descriptor.api === 'openai-responses'
  return request(
    input,
    `${stripTrailing(baseUrl)}/${responses ? 'responses' : 'chat/completions'}`,
    {
      method: 'POST',
      headers: {
        ...bearerHeaders(input.credential),
        ...(providerType === 'openai-codex' ? openAiCodexHeaders(input.credential) : {}),
      },
      body: JSON.stringify(
        responses
          ? {
              model: input.descriptor.modelId,
              store: false,
              max_output_tokens: 16,
              input: [{ role: 'user', content: 'Hi' }],
            }
          : {
              model: input.descriptor.modelId,
              max_tokens: 16,
              messages: [{ role: 'user', content: 'Hi' }],
            },
      ),
      acceptFailure: true,
    },
  )
}

async function request(
  input: ProviderRequestInput,
  url: string,
  init: RequestInit & { acceptFailure?: boolean } = {},
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    const response = await input.fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(init.method === 'POST' || init.body ? { 'content-type': 'application/json' } : {}),
        ...(input.descriptor.headers ?? {}),
        ...(init.headers ?? {}),
      },
    })
    if (!response.ok && !init.acceptFailure) {
      const message = await responseError(response, input.timeoutMs)
      throw new ConnectionHttpError(response.status, message)
    }
    return response
  } catch (error) {
    if (controller.signal.aborted) throw new ConnectionTimeoutError(input.timeoutMs)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function readJson(response: Response, timeoutMs: number): Promise<unknown> {
  try {
    const text = await readResponseText(response, MAX_JSON_RESPONSE_BYTES, timeoutMs)
    const payload = JSON.parse(text) as unknown
    if (!payload || typeof payload !== 'object') throw new Error('Expected a JSON object')
    return payload
  } catch (error) {
    if (error instanceof ConnectionTimeoutError) throw error
    if (error instanceof ConnectionInvalidResponseError) throw error
    throw new ConnectionInvalidResponseError(safeErrorMessage(error))
  }
}

async function responseError(response: Response, timeoutMs: number): Promise<string> {
  let detail = ''
  try {
    detail = replaceControlCharacters(
      await readResponseText(response, MAX_ERROR_RESPONSE_BYTES, timeoutMs),
    ).trim()
  } catch {
    // Status remains useful when the provider closes the response body.
  }
  return detail
    ? `Provider returned ${response.status}: ${detail.slice(0, ERROR_PREVIEW_LENGTH)}`
    : `Provider returned ${response.status}`
}

async function readResponseText(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  const chunks: string[] = []
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      void reader.cancel().catch(() => {})
      reject(new ConnectionTimeoutError(timeoutMs))
    }, timeoutMs)
  })
  const consume = async (): Promise<string> => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new ConnectionInvalidResponseError(
          `Response body exceeded ${Math.round(maxBytes / 1024)} KiB`,
        )
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  }
  try {
    return await Promise.race([consume(), deadline])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function toGenericModel(value: unknown, api: ModelApi): ConnectionModel[] {
  if (!isRecord(value) || typeof value.id !== 'string') return []
  const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined
  return [
    {
      id: value.id,
      api,
      ...(stringValue(value.display_name) || stringValue(value.name)
        ? { displayName: stringValue(value.display_name) ?? stringValue(value.name) }
        : {}),
      ...(positiveNumber(value.context_length) || positiveNumber(value.context_window)
        ? {
            contextLength:
              positiveNumber(value.context_length) ?? positiveNumber(value.context_window),
          }
        : {}),
      ...(positiveNumber(value.max_tokens) ? { maxTokens: positiveNumber(value.max_tokens) } : {}),
      ...(capabilities
        ? {
            capabilities: {
              ...(typeof capabilities.reasoning === 'boolean'
                ? { reasoning: capabilities.reasoning }
                : {}),
            },
          }
        : {}),
    },
  ]
}

function toGitHubCopilotModel(value: unknown): ConnectionModel[] {
  if (!isRecord(value) || typeof value.id !== 'string') return []
  if (value.model_picker_enabled === false) return []
  const policy = isRecord(value.policy) ? value.policy : undefined
  if (policy?.state === 'disabled') return []
  const endpoints = Array.isArray(value.supported_endpoints)
    ? value.supported_endpoints.filter((entry): entry is string => typeof entry === 'string')
    : []
  const api: ModelApi = endpoints.includes('/v1/messages')
    ? 'anthropic-messages'
    : endpoints.includes('/responses')
      ? 'openai-responses'
      : 'openai-chat-completions'
  const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined
  const supports =
    capabilities && isRecord(capabilities.supports) ? capabilities.supports : undefined
  const limits = capabilities && isRecord(capabilities.limits) ? capabilities.limits : undefined
  return [
    {
      id: value.id,
      api,
      ...(stringValue(value.name) ? { displayName: stringValue(value.name) } : {}),
      ...(positiveNumber(limits?.max_context_window_tokens) ||
      positiveNumber(limits?.max_prompt_tokens)
        ? {
            contextLength:
              positiveNumber(limits?.max_context_window_tokens) ??
              positiveNumber(limits?.max_prompt_tokens),
          }
        : {}),
      ...(positiveNumber(limits?.max_output_tokens)
        ? { maxTokens: positiveNumber(limits?.max_output_tokens) }
        : {}),
      capabilities: {
        tools: supports?.tool_calls === true,
        vision: supports?.vision === true,
        reasoning:
          supports?.adaptive_thinking === true || Array.isArray(supports?.reasoning_effort),
      },
    },
  ]
}

function normalizeModels(models: ConnectionModel[]): ConnectionModel[] {
  const result = new Map<string, ConnectionModel>()
  for (const model of models) {
    const id = model.id?.trim()
    if (!id || id.length > MAX_MODEL_ID_LENGTH || hasControlCharacter(id) || result.has(id)) {
      continue
    }
    result.set(id, { ...model, id })
    if (result.size >= MAX_MODELS) break
  }
  return Array.from(result.values())
}

function fallbackModels(
  profile: ConnectionProfile,
  fetchedAt: number,
): ConnectionModelDiscoveryResult {
  const explicit = profile.models ?? []
  const catalog = MODEL_CATALOG.filter(
    (model) => model.providerId === profile.id || model.providerId === profile.providerType,
  ).map((model) => ({
    id: model.modelId,
    displayName: model.displayName,
    api: model.api,
    contextLength: model.contextLength,
    maxTokens: model.maxTokens,
    capabilities: model.capabilities,
  }))
  return {
    models: normalizeModels(explicit.length > 0 ? explicit : catalog),
    source: 'fallback',
    fetchedAt,
  }
}

function connectionModelId(profile: ConnectionProfile): string {
  const id =
    profile.defaultModel?.trim() ||
    profile.enabledModelIds?.find((candidate) => candidate.trim())?.trim() ||
    profile.models?.find((model) => model.id.trim())?.id.trim() ||
    MODEL_CATALOG.find(
      (model) => model.providerId === profile.id || model.providerId === profile.providerType,
    )?.modelId
  if (!id) throw new Error('Choose a model before testing this connection')
  return id
}

function connectionDescriptor(
  profile: ConnectionProfile,
  modelRegistry: ModelRegistry,
  requireModel: boolean,
): ModelDescriptor {
  const modelId = requireModel ? connectionModelId(profile) : optionalConnectionModelId(profile)
  const model = profile.models?.find((candidate) => candidate.id === modelId)
  const definition = modelRegistry.getProviderDefinition(profile.id, profile.providerType)
  return {
    connectionId: profile.id,
    providerType: profile.providerType,
    provider: profile.id,
    modelId,
    api: model?.api ?? definition.defaultApi,
    ...(model?.displayName ? { displayName: model.displayName } : {}),
    ...(profile.baseUrl || definition.defaultBaseUrl
      ? { baseUrl: profile.baseUrl ?? definition.defaultBaseUrl }
      : {}),
    ...(profile.headers ? { headers: profile.headers } : {}),
    ...(model?.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
    ...(model?.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model?.capabilities ? { capabilities: model.capabilities } : {}),
  }
}

function optionalConnectionModelId(profile: ConnectionProfile): string {
  try {
    return connectionModelId(profile)
  } catch {
    return ''
  }
}

function settingsWithConnection(settings: Settings, profile: ConnectionProfile): Settings {
  return {
    ...settings,
    connections: [
      ...(settings.connections ?? []).filter((connection) => connection.id !== profile.id),
      profile,
    ],
  }
}

function normalizeConnectionProfile(profile: ConnectionProfile): ConnectionProfile {
  const id = profile.id.trim()
  const providerType = profile.providerType.trim()
  if (!id) throw new Error('Connection id is required')
  if (!providerType) throw new Error('Provider type is required')
  if (profile.baseUrl) {
    const url = new URL(profile.baseUrl.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Connection URL must use http or https')
    }
  }
  return {
    ...profile,
    id,
    providerType,
    ...(profile.label?.trim() ? { label: profile.label.trim() } : {}),
    ...(profile.baseUrl?.trim() ? { baseUrl: profile.baseUrl.trim().replace(/\/+$/, '') } : {}),
  }
}

function requireBaseUrl(descriptor: ModelDescriptor): string {
  if (descriptor.baseUrl?.trim()) return descriptor.baseUrl.trim()
  throw new Error('Connection URL is required')
}

function anthropicV1BaseUrl(baseUrl: string): string {
  return `${stripTrailing(baseUrl).replace(/\/v1$/i, '')}/v1`
}

function googleV1BetaBaseUrl(baseUrl: string): string {
  return `${stripTrailing(baseUrl).replace(/\/v1beta$/i, '')}/v1beta`
}

function stripTrailing(value: string): string {
  return value.replace(/\/+$/, '')
}

function bearerHeaders(credential: string): Record<string, string> {
  return credential ? { authorization: `Bearer ${credential}` } : {}
}

function claudeSubscriptionHeaders(): Record<string, string> {
  return {
    'User-Agent': 'claude-cli/2.1.153 (external, cli)',
    'anthropic-beta':
      'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
  }
}

function githubCopilotHeaders(): Record<string, string> {
  return {
    'User-Agent': 'GitHubCopilotChat/0.35.0',
    'Editor-Version': 'vscode/1.107.0',
    'Editor-Plugin-Version': 'copilot-chat/0.35.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'Openai-Intent': 'conversation-edits',
    'X-GitHub-Api-Version': '2026-06-01',
  }
}

function openAiCodexHeaders(accessToken: string): Record<string, string> {
  const accountId = extractJwtString(accessToken, 'chatgpt_account_id')
  return {
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs/0.0.0 (Aila)',
  }
}

function extractJwtString(token: string, key: string): string | undefined {
  const encoded = token.split('.')[1]
  if (!encoded) return undefined
  try {
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4)
    const payload = JSON.parse(
      Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as Record<string, unknown>
    const direct = payload[key]
    if (typeof direct === 'string') return direct
    const nested = payload['https://api.openai.com/auth']
    if (isRecord(nested) && typeof nested[key] === 'string') return nested[key]
  } catch {
    // Compatible deployments may issue opaque access tokens.
  }
  return undefined
}

function classifyStatus(status: number): ConnectionTestErrorClass {
  if (status === 401 || status === 403) return 'auth'
  if (status === 408 || status === 429 || status >= 500) return 'provider_unavailable'
  return 'unknown'
}

function classifyError(error: unknown): ConnectionTestErrorClass {
  if (error instanceof ConnectionTimeoutError) return 'timeout'
  if (error instanceof ConnectionHttpError) return classifyStatus(error.status)
  if (error instanceof ConnectionInvalidResponseError || error instanceof SyntaxError) {
    return 'invalid_response'
  }
  if (error instanceof TypeError) return 'network'
  return 'unknown'
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ConnectionHttpError) return error.message
  if (error instanceof ConnectionTimeoutError) return error.message
  if (error instanceof ConnectionInvalidResponseError) return error.message
  if (error instanceof Error) return error.message.slice(0, ERROR_PREVIEW_LENGTH)
  return String(error).slice(0, ERROR_PREVIEW_LENGTH)
}

class ConnectionHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ConnectionHttpError'
  }
}

class ConnectionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Connection timed out after ${Math.round(timeoutMs / 1_000)}s`)
    this.name = 'ConnectionTimeoutError'
  }
}

class ConnectionInvalidResponseError extends Error {
  constructor(message: string) {
    super(`Provider returned an invalid response: ${message}`)
    this.name = 'ConnectionInvalidResponseError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

function replaceControlCharacters(value: string): string {
  let result = ''
  let inControlSequence = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const control = code <= 31 || code === 127
    if (control) {
      if (!inControlSequence) result += ' '
    } else {
      result += value[index]
    }
    inControlSequence = control
  }
  return result
}
