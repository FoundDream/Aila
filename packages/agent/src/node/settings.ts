import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Settings } from '../settings-types'

export interface NodeSettingsOptions {
  dataDir?: string
  settingsPath?: string
}

export function defaultAilaDataDir(): string {
  return join(process.cwd(), '.aila')
}

export function getNodeSettingsPath(options: NodeSettingsOptions = {}): string {
  return options.settingsPath ?? join(options.dataDir ?? defaultAilaDataDir(), 'settings.json')
}

export function emptySettings(): Settings {
  return { apiKeys: {}, defaultModel: null, defaultImageModel: null, recentOpenRouterModels: [] }
}

export function loadNodeSettings(options: NodeSettingsOptions = {}): Settings {
  try {
    const raw = readFileSync(getNodeSettingsPath(options), 'utf-8')
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

export function saveNodeSettings(settings: Settings, options: NodeSettingsOptions = {}): Settings {
  const path = getNodeSettingsPath(options)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
  return settings
}
