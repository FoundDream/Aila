import { getDataDir, getProfilesDir, getToolPacksDir } from './paths'
import { loadAgentProfilesFromDir } from './profile-loader'
import { loadToolPacksFromDir } from './tool-pack-loader'

export type ExtensionReportErrorKind = 'profiles' | 'toolPacks'

export interface ExtensionReportError {
  kind: ExtensionReportErrorKind
  message: string
}

export interface ExtensionProfileReport {
  id: string
  label: string
  baseProfileId: string
  path: string
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
  profilesDir: string
  toolPacksDir: string
  profiles: ExtensionProfileReport[]
  toolPacks: ExtensionToolPackReport[]
  errors: ExtensionReportError[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function getExtensionReport(): Promise<ExtensionReport> {
  let profileError: string | null = null
  let toolPackError: string | null = null
  const profiles = await loadAgentProfilesFromDir().catch((error) => {
    profileError = errorMessage(error)
    return []
  })
  const toolPacks = await loadToolPacksFromDir().catch((error) => {
    toolPackError = errorMessage(error)
    return []
  })
  const errors: ExtensionReportError[] = [
    ...(profileError ? [{ kind: 'profiles' as const, message: profileError }] : []),
    ...(toolPackError ? [{ kind: 'toolPacks' as const, message: toolPackError }] : []),
  ]

  return {
    ok: errors.length === 0,
    dataDir: getDataDir(),
    profilesDir: getProfilesDir(),
    toolPacksDir: getToolPacksDir(),
    profiles: profiles.map((profile) => ({
      id: profile.profile.id,
      label: profile.profile.label,
      baseProfileId: profile.profile.baseProfileId,
      path: profile.path,
    })),
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
