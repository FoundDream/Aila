import type { ModelApi, ModelCapabilities, ProviderId } from './models'

export type ProviderAuthKind = 'api_key' | 'optional_api_key' | 'oauth_token' | 'none'

export type ProviderModelDiscovery = { kind: 'protocol'; path?: string } | { kind: 'static' }

export type ProviderRuntimeAdapter =
  | { kind: 'anthropic'; auth?: 'api-key' | 'bearer' }
  | { kind: 'openai'; api?: 'chat' | 'responses' }
  | { kind: 'google' }
  | { kind: 'openai-compatible'; name?: string; includeUsage?: boolean }
  | { kind: 'claude-subscription' }
  | { kind: 'openai-codex' }
  | { kind: 'github-copilot' }

export interface ProviderDefinition {
  id: string
  label: string
  description?: string
  authKind: ProviderAuthKind
  defaultApi: ModelApi
  defaultBaseUrl?: string
  runtimeAdapter: ProviderRuntimeAdapter
  category?: 'api' | 'coding-plan' | 'account' | 'custom'
  modelDiscovery?: ProviderModelDiscovery
  fallbackModels?: ConnectionModel[]
  credentialLabel?: string
  signupUrl?: string
}

export interface ConnectionModel {
  id: string
  displayName?: string
  api?: ModelApi
  contextLength?: number
  maxTokens?: number
  capabilities?: ModelCapabilities
}

/** Non-secret, persisted configuration for one provider account or endpoint. */
export interface ConnectionProfile {
  id: ProviderId
  providerType: string
  label?: string
  enabled?: boolean
  baseUrl?: string
  headers?: Record<string, string>
  credentialRef?: string
  defaultModel?: string
  enabledModelIds?: string[]
  models?: ConnectionModel[]
  modelSource?: 'fetched' | 'fallback'
  modelsFetchedAt?: number
  lastTestStatus?: 'verified' | 'needs_reauth' | 'error'
  lastTestAt?: number
  lastTestMessage?: string
}

export interface ResolvedProviderCredential {
  value: string
  kind: ProviderAuthKind
  expiresAt?: number
}

export type ConnectionCredentialStatus =
  | 'secure'
  | 'settings'
  | 'environment'
  | 'missing'
  | 'not-required'

/** Secret-free state presented by hosts to provider management surfaces. */
export interface ProviderConnectionSnapshot {
  profile: ConnectionProfile
  definition: ProviderDefinition
  credentialStatus: ConnectionCredentialStatus
  configured: boolean
  persisted: boolean
}

export type ConnectionTestErrorClass =
  | 'auth'
  | 'timeout'
  | 'provider_unavailable'
  | 'network'
  | 'invalid_response'
  | 'unknown'

export interface ConnectionTestResult {
  ok: boolean
  latencyMs: number
  modelTested?: string
  errorMessage?: string
  statusCode?: number
  errorClass?: ConnectionTestErrorClass
}

export interface ConnectionModelDiscoveryResult {
  models: ConnectionModel[]
  source: 'fetched' | 'fallback'
  fetchedAt: number
}
