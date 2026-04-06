import type { Api, KnownProvider } from '@mariozechner/pi-ai'

/** User-facing protocol names mapped to pi-ai API types */
export type ProtocolType = 'openai-compatible' | 'anthropic-compatible' | 'google-compatible'

/** Model entry with capability metadata beyond what pi-ai provides */
export interface ModelConfig {
  id: string
  name: string
  toolUse: boolean
  reasoning: boolean
  supportsImageInput: boolean
  contextWindow: number
  maxTokens: number
}

/** Conservative defaults for custom provider models */
export const CUSTOM_MODEL_DEFAULTS: Omit<ModelConfig, 'id' | 'name'> = {
  toolUse: false,
  reasoning: false,
  supportsImageInput: false,
  contextWindow: 8192,
  maxTokens: 4096,
}

/** Provider configuration - both built-in and custom */
export interface ProviderConfig {
  id: string
  displayName: string
  /** pi-ai API type used for streaming */
  api: Api
  /** pi-ai provider identifier */
  provider: KnownProvider | string
  baseUrl: string
  apiKey: string
  /** For custom providers, the user-facing protocol name */
  protocol?: ProtocolType
  models: ModelConfig[]
  isBuiltIn: boolean
}

export interface WebSearchConfig {
  tavilyApiKey: string
}

/** Top-level app configuration persisted to disk */
export interface AppConfig {
  /** All configured providers (built-in templates + user-added custom) */
  providers: ProviderConfig[]
  /** Compound key "providerId/modelId", persisted across app restarts */
  activeModelId: string | null
  /** Web search provider settings */
  webSearch: WebSearchConfig
}

export function parseModelKey(key: string): { providerId: string; modelId: string } | null {
  const slash = key.indexOf('/')
  if (slash === -1) return null
  return { providerId: key.slice(0, slash), modelId: key.slice(slash + 1) }
}

/** Empty config used as initial state */
export const EMPTY_CONFIG: AppConfig = {
  providers: [],
  activeModelId: null,
  webSearch: {
    tavilyApiKey: '',
  },
}
