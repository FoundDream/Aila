/**
 * Plain-text settings.json next to conversations data.
 *
 * Delegates to the node-layer implementation bound to the app data dir. Reads
 * fall back to environment variables for unset API keys so dev workflows with
 * .env keep working. Writes are best-effort synchronous.
 */

import type { ProviderId, Settings } from '@aila/agent'
import {
  configuredProviders as nodeConfiguredProviders,
  resolveApiKey as nodeResolveApiKey,
} from '../node/auth'
import { loadNodeSettings, saveNodeSettings } from '../node/settings'
import { getDataDir } from './paths'

export type { Settings } from '@aila/agent'

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
  return nodeResolveApiKey(providerId, { settings })
}

/**
 * The set of providers that have a usable API key (settings or env).
 */
export function configuredProviders(settings: Settings): ProviderId[] {
  return nodeConfiguredProviders(settings)
}
