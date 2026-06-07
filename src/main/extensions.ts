import { getDataDir, getToolPacksDir } from './paths'
import { loadToolPacksFromDir } from './tool-pack-loader'

export type ExtensionReportErrorKind = 'toolPacks'

export interface ExtensionReportError {
  kind: ExtensionReportErrorKind
  message: string
}

export interface ExtensionToolPackReport {
  id: string
  name: string
  directory: string
  manifestPath: string
  tools: string[]
}

export interface ExtensionReport {
  ok: boolean
  dataDir: string
  toolPacksDir: string
  toolPacks: ExtensionToolPackReport[]
  errors: ExtensionReportError[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function getExtensionReport(): Promise<ExtensionReport> {
  let toolPackError: string | null = null
  const toolPacks = await loadToolPacksFromDir().catch((error) => {
    toolPackError = errorMessage(error)
    return []
  })
  const errors: ExtensionReportError[] = toolPackError
    ? [{ kind: 'toolPacks', message: toolPackError }]
    : []

  return {
    ok: errors.length === 0,
    dataDir: getDataDir(),
    toolPacksDir: getToolPacksDir(),
    toolPacks: toolPacks.map((pack) => ({
      id: pack.toolPack.id,
      name: pack.toolPack.name,
      directory: pack.directory,
      manifestPath: pack.manifestPath,
      tools: pack.toolPack.tools.map((tool) => tool.spec.function.name),
    })),
    errors,
  }
}
