import type { ProviderId } from './models'
import type { ToolApprovalMode } from './tool-policy'

export interface Settings {
  apiKeys: Partial<Record<ProviderId, string>>
  defaultModel: { providerId: ProviderId; modelId: string } | null
  defaultImageModel?: { providerId: ProviderId; modelId: string } | null
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
