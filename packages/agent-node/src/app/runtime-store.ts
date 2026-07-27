import type { WorkbenchStore } from '@aila/agent'
import { createFileRuntimeStore } from '../node/file-store'
import { getDataDir } from './paths'

export function createPersistedRuntimeStore(): WorkbenchStore {
  return createFileRuntimeStore({ dataDir: getDataDir() })
}
