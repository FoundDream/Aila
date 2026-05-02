/**
 * Live OpenRouter model catalog. Fetches /api/v1/models on first call,
 * caches in-memory for the lifetime of the main process. Groups by family
 * (the segment before the slash in the model id).
 */

import {
  familyLabel,
  OPENROUTER_TOP_PICK_IDS,
  type OrCatalog,
  type OrFamily,
  type OrModel,
} from '@shared/openrouter'

const ENDPOINT = 'https://openrouter.ai/api/v1/models'
const TTL_MS = 1000 * 60 * 60 * 6 // 6h, refresh on next call after that

interface RawModel {
  id?: string
  name?: string
  context_length?: number | null
  pricing?: { prompt?: string }
}

let cached: OrCatalog | null = null
let inflight: Promise<OrCatalog> | null = null

function inferTags(id: string, name: string): OrModel['tags'] {
  const tags: OrModel['tags'] = []
  const haystack = `${id} ${name}`.toLowerCase()
  if (id.endsWith(':free') || haystack.includes(' free')) tags.push('free')
  if (haystack.includes('coder') || haystack.includes('codex')) tags.push('coding')
  if (
    haystack.includes('thinking') ||
    haystack.includes('reasoner') ||
    haystack.includes('reasoning')
  )
    tags.push('reasoning')
  if (haystack.includes('image')) tags.push('image')
  if (haystack.includes('audio')) tags.push('audio')
  return tags
}

function transform(raw: RawModel[]): OrCatalog {
  const models: OrModel[] = []
  for (const m of raw) {
    if (!m.id || !m.name) continue
    const slash = m.id.indexOf('/')
    if (slash <= 0) continue
    const family = m.id.slice(0, slash)
    // Skip the OpenRouter "latest" alias prefix entries (~google etc.)
    if (family.startsWith('~')) continue
    const promptStr = m.pricing?.prompt
    const promptPerToken = promptStr ? Number(promptStr) : Number.NaN
    const promptPricePerMTok = Number.isFinite(promptPerToken)
      ? Number((promptPerToken * 1_000_000).toFixed(3))
      : null
    models.push({
      id: m.id,
      name: m.name,
      family,
      contextLength: typeof m.context_length === 'number' ? m.context_length : 0,
      promptPricePerMTok,
      tags: inferTags(m.id, m.name),
    })
  }

  // Sort each model list deterministically: highest context first, then name.
  // Newer/bigger versions tend to bubble up.
  models.sort((a, b) => {
    if (b.contextLength !== a.contextLength) return b.contextLength - a.contextLength
    return a.id.localeCompare(b.id)
  })

  const byFamily = new Map<string, OrModel[]>()
  for (const m of models) {
    let bucket = byFamily.get(m.family)
    if (!bucket) {
      bucket = []
      byFamily.set(m.family, bucket)
    }
    bucket.push(m)
  }

  const families: OrFamily[] = Array.from(byFamily.entries())
    .map(([family, list]) => ({
      family,
      label: familyLabel(family),
      models: list,
    }))
    // Show the families with the most models first; ties by label.
    .sort((a, b) => {
      if (b.models.length !== a.models.length) return b.models.length - a.models.length
      return a.label.localeCompare(b.label)
    })

  const idIndex = new Map(models.map((m) => [m.id, m]))
  const topPicks = OPENROUTER_TOP_PICK_IDS.map((id) => idIndex.get(id)).filter((m): m is OrModel =>
    Boolean(m),
  )

  return { topPicks, families, fetchedAt: Date.now() }
}

async function fetchFresh(): Promise<OrCatalog> {
  const response = await fetch(ENDPOINT)
  if (!response.ok) throw new Error(`OpenRouter ${response.status}`)
  const json = (await response.json()) as { data?: RawModel[] }
  return transform(json.data ?? [])
}

export async function getOpenRouterCatalog(): Promise<OrCatalog> {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached
  if (inflight) return inflight
  inflight = fetchFresh()
    .then((cat) => {
      cached = cat
      return cat
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
