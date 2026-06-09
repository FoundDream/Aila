/**
 * Static model catalog. Single source of truth — imported by both main and
 * renderer. Each entry: which provider it lives on, its modelId string for
 * that provider's API, a display name, and metadata for the picker.
 *
 * Catalog snapshot date: 2026-05-02 (sourced from OpenRouter live /models).
 */

export type KnownProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter'

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
]

export interface ImageModelEntry {
  providerId: ProviderId
  modelId: string
  displayName: string
}

// First-class image-generation models. Adapter dispatch (`src/main/image/`) is
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

export const PROVIDER_ORDER: ProviderId[] = ['anthropic', 'openai', 'google', 'openrouter']

export const PROVIDER_LABELS: Record<KnownProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
}

export const PROVIDER_DEFAULT_API: Record<KnownProviderId, ModelApi> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-chat-completions',
  google: 'google-generative-ai',
  openrouter: 'openai-chat-completions',
}

export function providerLabel(providerId: ProviderId): string {
  return providerId in PROVIDER_LABELS ? PROVIDER_LABELS[providerId as KnownProviderId] : providerId
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
