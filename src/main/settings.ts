/**
 * Plain-text settings.json next to conversations data.
 *
 * Reads fall back to environment variables for unset API keys so dev workflows
 * with .env keep working. Writes are best-effort synchronous.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProviderId } from '@shared/models'
import { getDataDir, getSettingsPath } from './paths'

export interface VertexConfig {
  /** GCP project id; required for any :predict call (Imagen) and for non-Express text. */
  project?: string
  /** GCP region, e.g. 'us-central1'. */
  location?: string
}

export interface Settings {
  apiKeys: {
    anthropic?: string
    openai?: string
    google?: string
    /** SA-bound Vertex API key (sent as x-goog-api-key for Imagen, apiKey for SDK). */
    vertex?: string
    openrouter?: string
  }
  /** Vertex needs project + location alongside the API key for Imagen :predict. */
  vertex?: VertexConfig
  defaultModel: { providerId: ProviderId; modelId: string } | null
  defaultImageModel?: { providerId: ProviderId; modelId: string } | null
  /** MRU list of recently chosen OpenRouter model ids (max 5). */
  recentOpenRouterModels?: string[]
}

const ENV_KEY_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  vertex: 'GOOGLE_VERTEX_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

function emptySettings(): Settings {
  return { apiKeys: {}, defaultModel: null }
}

export function loadSettings(): Settings {
  try {
    const raw = readFileSync(getSettingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      apiKeys: parsed.apiKeys ?? {},
      vertex: parsed.vertex ?? {},
      defaultModel: parsed.defaultModel ?? null,
      defaultImageModel: parsed.defaultImageModel ?? null,
      recentOpenRouterModels: parsed.recentOpenRouterModels ?? [],
    }
  } catch {
    return emptySettings()
  }
}

export function saveSettings(settings: Settings): Settings {
  const path = getSettingsPath()
  mkdirSync(dirname(path), { recursive: true })
  // Touch the data dir too in case it's the dev sentinel
  mkdirSync(getDataDir(), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
  return settings
}

/**
 * Returns the API key for a provider, falling back to env vars when settings
 * doesn't have one. Empty string is treated as "not set".
 */
export function resolveApiKey(providerId: ProviderId, settings: Settings): string | undefined {
  const fromSettings = settings.apiKeys[providerId]
  if (fromSettings && fromSettings.trim().length > 0) return fromSettings
  const fromEnv = process.env[ENV_KEY_BY_PROVIDER[providerId]]
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv
  return undefined
}

/**
 * Vertex needs project + location for any :predict call (Imagen) and for
 * service-account-bound (non-Express) auth. Falls back to env vars so dev
 * .env workflows keep working.
 */
export function resolveVertexConfig(settings: Settings): Required<VertexConfig> | null {
  const project = settings.vertex?.project?.trim() || process.env.GOOGLE_VERTEX_PROJECT?.trim()
  const location = settings.vertex?.location?.trim() || process.env.GOOGLE_VERTEX_LOCATION?.trim()
  if (!project || !location) return null
  return { project, location }
}

/**
 * The set of providers that have a usable API key (settings or env). For
 * Vertex this only checks the key; project + location are required at image
 * call time (Imagen :predict) but not for Gemini text via Express Mode.
 */
export function configuredProviders(settings: Settings): ProviderId[] {
  return (Object.keys(ENV_KEY_BY_PROVIDER) as ProviderId[]).filter((p) =>
    Boolean(resolveApiKey(p, settings)),
  )
}
