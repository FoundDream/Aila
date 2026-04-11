/**
 * Provider & model configuration types persisted to providers.json.
 *
 * Zero imports from @mariozechner/*. ProtocolName identifies the wire
 * protocol we use to talk to the provider; it maps 1:1 to an LLMClient
 * implementation in src/main/llm/.
 */

/** Wire-protocol identifiers; each maps to one LLMClient implementation. */
export type ProtocolName =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'google-generative-ai'
  | 'google-vertex'

/** User-facing protocol names for the custom-provider UI. */
export type ProtocolType = 'openai-compatible' | 'anthropic-compatible' | 'google-compatible'

/** Model entry with capability metadata beyond raw identity. */
export interface ModelConfig {
  id: string
  name: string
  toolUse: boolean
  reasoning: boolean
  supportsImageInput: boolean
  contextWindow: number
  maxTokens: number
}

/** Conservative defaults for custom provider models. */
export const CUSTOM_MODEL_DEFAULTS: Omit<ModelConfig, 'id' | 'name'> = {
  toolUse: false,
  reasoning: false,
  supportsImageInput: false,
  contextWindow: 8192,
  maxTokens: 4096,
}

/** Provider configuration — both built-in and custom. */
export interface ProviderConfig {
  id: string
  displayName: string
  /** Wire protocol used for streaming / tool calls. */
  api: ProtocolName
  /**
   * Provider identity. For built-ins this equals one of the canonical ids
   * ('anthropic', 'openai', 'google', 'google-vertex'). For custom providers
   * it can be any user-chosen string.
   */
  provider: string
  baseUrl: string
  apiKey: string
  /** For custom providers, the user-facing protocol name. */
  protocol?: ProtocolType
  models: ModelConfig[]
  isBuiltIn: boolean
}

export interface WebSearchConfig {
  tavilyApiKey: string
}

/** Top-level app configuration persisted to disk. */
export interface AppConfig {
  providers: ProviderConfig[]
  /** Compound key "providerId/modelId", persisted across app restarts. */
  activeModelId: string | null
  webSearch: WebSearchConfig
}

export function providerCanUseWithoutApiKey(
  provider: Pick<ProviderConfig, 'api' | 'isBuiltIn'>,
): boolean {
  return !provider.isBuiltIn && provider.api === 'openai-completions'
}

export function providerHasUsableAuth(
  provider: Pick<ProviderConfig, 'api' | 'apiKey' | 'isBuiltIn'>,
): boolean {
  return Boolean(provider.apiKey.trim()) || providerCanUseWithoutApiKey(provider)
}

export function parseModelKey(key: string): { providerId: string; modelId: string } | null {
  const slash = key.indexOf('/')
  if (slash === -1) return null
  return { providerId: key.slice(0, slash), modelId: key.slice(slash + 1) }
}

/** Empty config used as initial state. */
export const EMPTY_CONFIG: AppConfig = {
  providers: [],
  activeModelId: null,
  webSearch: {
    tavilyApiKey: '',
  },
}
