import { join } from 'node:path'
import { defaultAilaDataDir } from '../node/settings'

let configuredDataDir: string | null = null

export function configureDataDir(path: string): void {
  configuredDataDir = path
}

export function getDataDir(): string {
  return configuredDataDir ?? process.env.AILA_DATA_DIR ?? defaultAilaDataDir()
}

export function getImagesDir(): string {
  return join(getDataDir(), 'images')
}

export function getSettingsPath(): string {
  return join(getDataDir(), 'settings.json')
}

export function getSkillsDir(): string {
  return join(getDataDir(), 'skills')
}
