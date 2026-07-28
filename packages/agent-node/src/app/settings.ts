/**
 * Plain-text settings.json next to conversations data.
 *
 * Delegates to the node-layer implementation bound to the app data dir. Reads
 * fall back to environment variables for unset API keys so dev workflows with
 * .env keep working. Writes are best-effort synchronous.
 */

import type { ProviderId, Settings } from '@aila/agent'
import { loadNodeSettings, saveNodeSettings } from '../node/settings'
import { getDataDir } from './paths'

export type { Settings } from '@aila/agent'

const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

export function loadSettings(): Settings {
  return loadNodeSettings({ dataDir: getDataDir() })
}

export function saveSettings(settings: Settings): Settings {
  return saveNodeSettings(settings, { dataDir: getDataDir() })
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
