import type { WorkbenchStore } from '@aila/agent'
import { createFileRuntimeStore } from '../node/file-store'
import { getDataDir } from './paths'

let cachedDataDir: string | null = null
let cachedStore: WorkbenchStore | null = null

// The file store's journal cache assumes this process is the only writer, so
// every app-layer consumer must share one store instance per data dir.
export function getPersistedRuntimeStore(): WorkbenchStore {
  const dataDir = getDataDir()
  if (!cachedStore || cachedDataDir !== dataDir) {
    cachedDataDir = dataDir
    cachedStore = createFileRuntimeStore({ dataDir })
  }
  return cachedStore
}
