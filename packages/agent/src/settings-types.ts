import type { ProviderId } from './models'
import type { ConnectionProfile } from './provider-types'
import type { ToolApprovalMode } from './tool-policy'

export type VisionFallbackMode = 'auto' | 'ask' | 'disabled'
export type PromptCacheMode = 'off' | 'auto' | 'explicit'
export type PromptCacheTtl = '5m' | '1h'

export function normalizeVisionFallbackMode(value: unknown): VisionFallbackMode {
  return value === 'ask' || value === 'disabled' ? value : 'auto'
}

export function normalizePromptCacheMode(value: unknown): PromptCacheMode {
  return value === 'off' || value === 'explicit' ? value : 'auto'
}

export function normalizePromptCacheTtl(value: unknown): PromptCacheTtl {
  return value === '1h' ? '1h' : '5m'
}

export interface PromptCacheSettings {
  mode?: PromptCacheMode
  ttl?: PromptCacheTtl
  openRouterStickySession?: boolean
  showDiagnostics?: boolean
}

export function normalizePromptCacheSettings(value: unknown): PromptCacheSettings {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<PromptCacheSettings>)
      : {}
  return {
    mode: normalizePromptCacheMode(record.mode),
    ttl: normalizePromptCacheTtl(record.ttl),
    openRouterStickySession: record.openRouterStickySession !== false,
    showDiagnostics: record.showDiagnostics === true,
  }
}

export interface Settings {
  /** Non-secret provider accounts/endpoints. Secrets remain in apiKeys or a host credential store. */
  connections?: ConnectionProfile[]
  apiKeys: Partial<Record<ProviderId, string>>
  defaultModel: { providerId: ProviderId; modelId: string } | null
  defaultImageModel?: { providerId: ProviderId; modelId: string } | null
  defaultVisionModel?: { providerId: ProviderId; modelId: string } | null
  visionFallbackMode?: VisionFallbackMode
  promptCache?: PromptCacheSettings
  approvalMode?: ToolApprovalMode
  webSearch?: WebSearchSettings
  /** MRU list of recently chosen OpenRouter model ids (max 5). */
  recentOpenRouterModels?: string[]
}

export interface WebSearchSettings {
  providers?: {
    tavily?: { apiKey?: string }
    searxng?: { baseUrl?: string }
    brave?: { apiKey?: string }
    google?: { apiKey?: string; cx?: string }
    duckduckgo?: { enabled?: boolean }
    wikimedia?: { enabled?: boolean }
    hackernews?: { enabled?: boolean }
    arxiv?: { enabled?: boolean }
    stackexchange?: { enabled?: boolean; site?: string }
  }
}
