// Shared types for the live OpenRouter model catalog.

export interface OrModel {
  id: string // 'deepseek/deepseek-v4-pro'
  name: string // 'DeepSeek V4 Pro'
  family: string // 'deepseek' (first segment of id)
  contextLength: number
  /** USD per million prompt tokens, when known. */
  promptPricePerMTok: number | null
  /** Heuristic tags inferred from id/name. */
  tags: ('reasoning' | 'coding' | 'cheap' | 'free' | 'image' | 'audio')[]
}

export interface OrFamily {
  family: string
  label: string
  models: OrModel[]
}

export interface OrCatalog {
  /** Curated favourites (order matters). Always shown at the top. */
  topPicks: OrModel[]
  families: OrFamily[]
  /** When this snapshot was fetched. */
  fetchedAt: number
}

/** Hand-picked OpenRouter favourites, by id. Filter happens after live fetch. */
export const OPENROUTER_TOP_PICK_IDS = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'x-ai/grok-4.3',
  'qwen/qwen3-coder-plus',
] as const

const FAMILY_LABELS: Record<string, string> = {
  'x-ai': 'xAI / Grok',
  'meta-llama': 'Meta Llama',
  mistralai: 'Mistral',
  nousresearch: 'Nous Research',
  '01-ai': '01.AI',
  cognitivecomputations: 'Cognitive Computations',
}

export function familyLabel(family: string): string {
  if (FAMILY_LABELS[family]) return FAMILY_LABELS[family]
  return family.charAt(0).toUpperCase() + family.slice(1)
}
