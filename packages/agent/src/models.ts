/**
 * Static model catalog. Single source of truth — imported by both main and
 * renderer. Each entry: which provider it lives on, its modelId string for
 * that provider's API, a display name, and metadata for the picker.
 *
 * Catalog snapshot date: 2026-05-02 (sourced from OpenRouter live /models).
 */

export type KnownProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'openrouter'
  | 'kimi-coding-plan'
  | 'minimax-coding-plan'
  | 'zai-coding-plan'
  | 'tencent-coding-plan'
  | 'volcengine-coding-plan'
  | 'alibaba-coding-plan-cn'
  | 'alibaba-coding-plan'
  | 'claude-subscription'
  | 'openai-codex'
  | 'github-copilot'

export type ProviderId = KnownProviderId | (string & {})

export type KnownModelApi =
  | 'anthropic-messages'
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'google-generative-ai'

export type ModelApi = KnownModelApi | (string & {})

export type ModelTag = 'flagship' | 'fast' | 'cheap' | 'coding' | 'reasoning'

export interface ModelEntry {
  providerId: ProviderId
  modelId: string
  displayName: string
  contextLength: number
  tags?: ModelTag[]
  api?: ModelApi
  baseUrl?: string
  headers?: Record<string, string>
  maxTokens?: number
  input?: ('text' | 'image')[]
  capabilities?: ModelCapabilities
  compat?: Record<string, unknown>
  pricing?: ModelPricing
}

export interface ModelCapabilities {
  tools?: boolean
  vision?: boolean
  reasoning?: boolean
  imageGeneration?: boolean
}

export interface ModelPricing {
  inputPerMTok?: number
  outputPerMTok?: number
  cacheReadPerMTok?: number
  cacheWritePerMTok?: number
}

export interface ModelDescriptor {
  /** Connection identity used by settings and credentials. Defaults to provider. */
  connectionId?: ProviderId
  /** Provider implementation selected by the connection. Defaults to provider. */
  providerType?: string
  provider: ProviderId
  modelId: string
  api: ModelApi
  displayName?: string
  baseUrl?: string
  headers?: Record<string, string>
  contextLength?: number
  maxTokens?: number
  input?: ('text' | 'image')[]
  capabilities?: ModelCapabilities
  compat?: Record<string, unknown>
  pricing?: ModelPricing
}

export const MODEL_CATALOG: ModelEntry[] = [
  // Anthropic (native)
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    contextLength: 1_000_000,
    tags: ['flagship'],
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    contextLength: 1_000_000,
    tags: ['flagship'],
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    contextLength: 1_000_000,
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    contextLength: 200_000,
    tags: ['fast', 'cheap'],
  },

  // OpenAI (native)
  {
    providerId: 'openai',
    modelId: 'gpt-5.5',
    displayName: 'GPT-5.5',
    contextLength: 1_050_000,
    tags: ['flagship'],
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.4',
    displayName: 'GPT-5.4',
    contextLength: 1_050_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 mini',
    contextLength: 400_000,
    tags: ['cheap', 'fast'],
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    contextLength: 400_000,
    tags: ['coding'],
  },

  // Google (native)
  {
    providerId: 'google',
    modelId: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro',
    contextLength: 1_048_576,
    tags: ['flagship'],
  },
  {
    providerId: 'google',
    modelId: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash',
    contextLength: 1_048_576,
    tags: ['fast'],
  },
  {
    providerId: 'google',
    modelId: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    contextLength: 1_048_576,
  },
  {
    providerId: 'google',
    modelId: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash Lite',
    contextLength: 1_048_576,
    tags: ['cheap'],
  },

  // DeepSeek (native; OpenAI-compatible chat completions)
  {
    providerId: 'deepseek',
    modelId: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    contextLength: 1_048_576,
    tags: ['flagship', 'reasoning', 'coding'],
    capabilities: { tools: true, reasoning: true },
  },
  {
    providerId: 'deepseek',
    modelId: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    contextLength: 1_048_576,
    tags: ['cheap', 'fast', 'reasoning'],
    capabilities: { tools: true, reasoning: true },
  },

  // OpenRouter (aggregator; modelId carries the provider/model prefix)
  {
    providerId: 'openrouter',
    modelId: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    contextLength: 1_048_576,
    tags: ['flagship'],
  },
  {
    providerId: 'openrouter',
    modelId: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    contextLength: 1_048_576,
    tags: ['cheap', 'fast'],
  },

  // Coding plans and account-backed providers. Credentials may be API keys or
  // OAuth access tokens; the Node credential resolver owns that distinction.
  {
    providerId: 'kimi-coding-plan',
    modelId: 'k3',
    displayName: 'Kimi K3',
    contextLength: 262_144,
    tags: ['coding', 'reasoning'],
    api: 'anthropic-messages',
    capabilities: { tools: true, reasoning: true },
  },
  {
    providerId: 'kimi-coding-plan',
    modelId: 'kimi-for-coding',
    displayName: 'Kimi for Coding',
    contextLength: 262_144,
    tags: ['coding'],
    api: 'anthropic-messages',
    capabilities: { tools: true },
  },
  {
    providerId: 'claude-subscription',
    modelId: 'claude-sonnet-4-5-20250929',
    displayName: 'Claude Sonnet 4.5',
    contextLength: 200_000,
    tags: ['coding'],
    api: 'anthropic-messages',
    capabilities: { tools: true, reasoning: true, vision: true },
  },
  {
    providerId: 'claude-subscription',
    modelId: 'claude-opus-4-1-20250805',
    displayName: 'Claude Opus 4.1',
    contextLength: 200_000,
    tags: ['coding', 'reasoning'],
    api: 'anthropic-messages',
    capabilities: { tools: true, reasoning: true, vision: true },
  },
  {
    providerId: 'openai-codex',
    modelId: 'gpt-5.5',
    displayName: 'GPT-5.5 Codex',
    contextLength: 400_000,
    tags: ['coding', 'reasoning'],
    api: 'openai-responses',
    capabilities: { tools: true, reasoning: true, vision: true },
  },
  {
    providerId: 'openai-codex',
    modelId: 'gpt-5.4',
    displayName: 'GPT-5.4 Codex',
    contextLength: 400_000,
    tags: ['coding', 'reasoning'],
    api: 'openai-responses',
    capabilities: { tools: true, reasoning: true, vision: true },
  },
  {
    providerId: 'openai-codex',
    modelId: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 mini Codex',
    contextLength: 400_000,
    tags: ['coding', 'fast'],
    api: 'openai-responses',
    capabilities: { tools: true, reasoning: true, vision: true },
  },
  {
    providerId: 'openai-codex',
    modelId: 'gpt-5.3-codex-spark',
    displayName: 'GPT-5.3 Codex Spark',
    contextLength: 400_000,
    tags: ['coding', 'fast'],
    api: 'openai-responses',
    capabilities: { tools: true, reasoning: true },
  },
  {
    providerId: 'github-copilot',
    modelId: 'gpt-5.4',
    displayName: 'GPT-5.4',
    contextLength: 400_000,
    tags: ['coding'],
    api: 'openai-chat-completions',
    capabilities: { tools: true, reasoning: true, vision: true },
  },
]

// Vision-only helper choices used by the fallback bridge. These are not shown
// in the normal chat picker unless they also exist in MODEL_CATALOG.
export const VISION_MODEL_CATALOG: ModelEntry[] = [
  {
    providerId: 'openrouter',
    modelId: 'openrouter/free',
    displayName: 'OpenRouter Free (auto)',
    contextLength: 200_000,
    tags: ['cheap'],
    input: ['text', 'image'],
    capabilities: { vision: true },
  },
  {
    providerId: 'openrouter',
    modelId: '~openai/gpt-mini-latest',
    displayName: 'OpenAI GPT Mini Latest',
    contextLength: 400_000,
    tags: ['cheap', 'fast'],
    input: ['text', 'image'],
    capabilities: { vision: true },
  },
  {
    providerId: 'openrouter',
    modelId: '~google/gemini-flash-latest',
    displayName: 'Google Gemini Flash Latest',
    contextLength: 1_048_576,
    tags: ['fast'],
    input: ['text', 'image'],
    capabilities: { vision: true },
  },
  {
    providerId: 'openrouter',
    modelId: '~anthropic/claude-sonnet-latest',
    displayName: 'Anthropic Claude Sonnet Latest',
    contextLength: 1_000_000,
    tags: ['flagship'],
    input: ['text', 'image'],
    capabilities: { vision: true },
  },
  {
    providerId: 'openrouter',
    modelId: '~openai/gpt-latest',
    displayName: 'OpenAI GPT Latest',
    contextLength: 1_050_000,
    tags: ['flagship'],
    input: ['text', 'image'],
    capabilities: { vision: true },
  },
]

export interface ImageModelEntry {
  providerId: ProviderId
  modelId: string
  displayName: string
}

// First-class image-generation models. Adapter dispatch (`@aila/agent-node`) is
// keyed by providerId; modelId is whatever string the provider expects.
// Order matters: non-moderated models first, since OpenAI's image moderation
// rejects many benign prompts (diagrams, people, etc.) with a 403.
export const IMAGE_MODEL_CATALOG: ImageModelEntry[] = [
  {
    providerId: 'openrouter',
    modelId: 'google/gemini-3-pro-image-preview',
    displayName: 'Nano Banana Pro (Gemini 3 Pro Image)',
  },
  {
    providerId: 'openrouter',
    modelId: 'google/gemini-3.1-flash-image-preview',
    displayName: 'Nano Banana 2 (Gemini 3.1 Flash Image)',
  },
  {
    providerId: 'openrouter',
    modelId: 'google/gemini-2.5-flash-image',
    displayName: 'Nano Banana (Gemini 2.5 Flash Image)',
  },
  {
    providerId: 'openrouter',
    modelId: 'black-forest-labs/flux.2-pro',
    displayName: 'FLUX.2 Pro',
  },
  {
    providerId: 'openrouter',
    modelId: 'openai/gpt-5.4-image-2',
    displayName: 'GPT-5.4 Image 2 (heavily moderated)',
  },
]

export const PROVIDER_ORDER: ProviderId[] = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'openrouter',
  'kimi-coding-plan',
  'minimax-coding-plan',
  'zai-coding-plan',
  'tencent-coding-plan',
  'volcengine-coding-plan',
  'alibaba-coding-plan-cn',
  'alibaba-coding-plan',
  'claude-subscription',
  'openai-codex',
  'github-copilot',
]

export const PROVIDER_LABELS: Record<KnownProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  'kimi-coding-plan': 'Kimi Coding Plan',
  'minimax-coding-plan': 'MiniMax Coding Plan',
  'zai-coding-plan': 'Z.AI Coding Plan',
  'tencent-coding-plan': 'Tencent Coding Plan',
  'volcengine-coding-plan': 'Volcengine Ark Coding Plan',
  'alibaba-coding-plan-cn': 'Alibaba Coding Plan (China)',
  'alibaba-coding-plan': 'Alibaba Coding Plan',
  'claude-subscription': 'Claude Subscription',
  'openai-codex': 'ChatGPT / Codex',
  'github-copilot': 'GitHub Copilot',
}

export const PROVIDER_DEFAULT_API: Record<KnownProviderId, ModelApi> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-chat-completions',
  google: 'google-generative-ai',
  deepseek: 'openai-chat-completions',
  openrouter: 'openai-chat-completions',
  'kimi-coding-plan': 'anthropic-messages',
  'minimax-coding-plan': 'anthropic-messages',
  'zai-coding-plan': 'openai-chat-completions',
  'tencent-coding-plan': 'openai-chat-completions',
  'volcengine-coding-plan': 'openai-chat-completions',
  'alibaba-coding-plan-cn': 'openai-chat-completions',
  'alibaba-coding-plan': 'openai-chat-completions',
  'claude-subscription': 'anthropic-messages',
  'openai-codex': 'openai-responses',
  'github-copilot': 'openai-chat-completions',
}

export function providerLabel(providerId: ProviderId): string {
  return providerId in PROVIDER_LABELS ? PROVIDER_LABELS[providerId as KnownProviderId] : providerId
}

export function modelSupportsVision(
  model:
    | Pick<ModelEntry, 'providerId' | 'modelId' | 'input' | 'capabilities'>
    | Pick<ModelDescriptor, 'provider' | 'modelId' | 'input' | 'capabilities'>,
): boolean {
  if (model.capabilities?.vision === true || model.input?.includes('image')) return true
  const providerId = 'provider' in model ? model.provider : model.providerId
  if (providerId === 'anthropic' || providerId === 'openai' || providerId === 'google') return true
  return false
}

export function modelEntryToDescriptor(entry: ModelEntry): ModelDescriptor {
  return {
    provider: entry.providerId,
    modelId: entry.modelId,
    api:
      entry.api ??
      (entry.providerId in PROVIDER_DEFAULT_API
        ? PROVIDER_DEFAULT_API[entry.providerId as KnownProviderId]
        : 'openai-chat-completions'),
    displayName: entry.displayName,
    contextLength: entry.contextLength,
    ...(entry.baseUrl && { baseUrl: entry.baseUrl }),
    ...(entry.headers && { headers: entry.headers }),
    ...(entry.maxTokens !== undefined && { maxTokens: entry.maxTokens }),
    ...(entry.input && { input: entry.input }),
    ...(entry.capabilities && { capabilities: entry.capabilities }),
    ...(entry.compat && { compat: entry.compat }),
    ...(entry.pricing && { pricing: entry.pricing }),
  }
}

/**
 * Look up a catalog entry. For OpenRouter, returns a synthetic entry for
 * unknown model IDs (long-tail escape hatch via the picker's custom input).
 */
export function findModel(providerId: ProviderId, modelId: string): ModelEntry | null {
  const entry = MODEL_CATALOG.find((m) => m.providerId === providerId && m.modelId === modelId)
  if (entry) return entry
  if (providerId === 'openrouter') {
    return {
      providerId,
      modelId,
      displayName: modelId,
      contextLength: 0,
      api: 'openai-chat-completions',
    }
  }
  return null
}

export function findModelDescriptor(
  providerId: ProviderId,
  modelId: string,
): ModelDescriptor | null {
  const entry = findModel(providerId, modelId)
  return entry ? modelEntryToDescriptor(entry) : null
}
