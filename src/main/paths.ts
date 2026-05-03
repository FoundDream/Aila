import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { app } from 'electron'

export function getDataDir(): string {
  if (is.dev) return join(app.getAppPath(), '.dev-data')
  return app.getPath('userData')
}

export function getConversationsDir(): string {
  return join(getDataDir(), 'conversations')
}

export function getDocumentsDir(): string {
  return join(getDataDir(), 'documents')
}

export function getImagesDir(): string {
  return join(getDataDir(), 'images')
}

export function getSettingsPath(): string {
  return join(getDataDir(), 'settings.json')
}
