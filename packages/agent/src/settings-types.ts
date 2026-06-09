import type { ProviderId } from './models'
import type { ToolApprovalMode } from './tool-policy'

export interface Settings {
  apiKeys: Partial<Record<ProviderId, string>>
  defaultModel: { providerId: ProviderId; modelId: string } | null
  defaultImageModel?: { providerId: ProviderId; modelId: string } | null
  approvalMode?: ToolApprovalMode
  /** MRU list of recently chosen OpenRouter model ids (max 5). */
  recentOpenRouterModels?: string[]
}
