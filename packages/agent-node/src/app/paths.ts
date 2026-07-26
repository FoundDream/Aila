import { join } from 'node:path'

let configuredDataDir: string | null = null

export function configureDataDir(path: string): void {
  configuredDataDir = path
}

export function getDataDir(): string {
  return configuredDataDir ?? process.env.AILA_DATA_DIR ?? join(process.cwd(), '.aila-data')
}

export function getConversationsDir(): string {
  return join(getDataDir(), 'conversations')
}

export function getImagesDir(): string {
  return join(getDataDir(), 'images')
}

export function getPlansDir(): string {
  return join(getDataDir(), 'plans')
}

export function getRunsDir(): string {
  return join(getDataDir(), 'runs')
}

export function getSettingsPath(): string {
  return join(getDataDir(), 'settings.json')
}

export function getToolPacksDir(): string {
  return join(getDataDir(), 'tool-packs')
}

export function getSkillsDir(): string {
  return join(getDataDir(), 'skills')
}
