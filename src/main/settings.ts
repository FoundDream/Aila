/**
 * Plain-text settings.json next to conversations data.
 *
 * Reads fall back to environment variables for unset API keys so dev workflows
 * with .env keep working. Writes are best-effort synchronous.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Settings } from '../runtime/core'
import type { ProviderId } from '../shared/models'
import { getDataDir, getSettingsPath } from './paths'

export type { Settings } from '../runtime/core'

const ENV_KEY_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
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
 * The set of providers that have a usable API key (settings or env).
 */
export function configuredProviders(settings: Settings): ProviderId[] {
  return (Object.keys(ENV_KEY_BY_PROVIDER) as ProviderId[]).filter((p) =>
    Boolean(resolveApiKey(p, settings)),
  )
}
