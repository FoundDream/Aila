import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  normalizePromptCacheSettings,
  normalizeToolApprovalMode,
  normalizeVisionFallbackMode,
  type Settings,
} from '@aila/agent'
import { ENV_KEY_BY_PROVIDER } from './auth'

export interface NodeSettingsOptions {
  dataDir?: string
  settingsPath?: string
}

export function defaultAilaDataDir(): string {
  return join(process.cwd(), '.aila-data')
}

export function getNodeSettingsPath(options: NodeSettingsOptions = {}): string {
  return options.settingsPath ?? join(options.dataDir ?? defaultAilaDataDir(), 'settings.json')
}

export function emptySettings(): Settings {
  return {
    apiKeys: {},
    connections: [],
    defaultModel: null,
    defaultImageModel: null,
    defaultVisionModel: null,
    visionFallbackMode: 'auto',
    promptCache: normalizePromptCacheSettings(undefined),
    approvalMode: 'safe',
    recentOpenRouterModels: [],
  }
}

function inferDefaultVisionModel(parsed: Partial<Settings>): Settings['defaultVisionModel'] {
  if (parsed.defaultVisionModel !== undefined) return parsed.defaultVisionModel
  const fromSettings = parsed.apiKeys?.openrouter
  const fromEnv = process.env[ENV_KEY_BY_PROVIDER.openrouter]
  if (fromSettings?.trim() || fromEnv?.trim()) {
    return { providerId: 'openrouter', modelId: 'openrouter/free' }
  }
  return null
}

export function loadNodeSettings(options: NodeSettingsOptions = {}): Settings {
  try {
    const raw = readFileSync(getNodeSettingsPath(options), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      apiKeys: parsed.apiKeys ?? {},
      connections: parsed.connections ?? [],
      defaultModel: parsed.defaultModel ?? null,
      defaultImageModel: parsed.defaultImageModel ?? null,
      defaultVisionModel: inferDefaultVisionModel(parsed),
      visionFallbackMode: normalizeVisionFallbackMode(parsed.visionFallbackMode),
      promptCache: normalizePromptCacheSettings(parsed.promptCache),
      approvalMode: normalizeToolApprovalMode(parsed.approvalMode),
      webSearch: parsed.webSearch ?? {},
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
