import { getDataDir, getSkillsDir, getToolPacksDir } from './paths'
import { loadSkillsFromDir } from './skills'
import { loadToolPacksFromDir } from './tool-pack-loader'

export type ExtensionReportErrorKind = 'toolPacks' | 'skills'

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

export interface ExtensionSkillReport {
  name: string
  description: string
  directory: string
  skillPath: string
}

export interface ExtensionReport {
  ok: boolean
  dataDir: string
  toolPacksDir: string
  skillsDir: string
  toolPacks: ExtensionToolPackReport[]
  skills: ExtensionSkillReport[]
  errors: ExtensionReportError[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function getExtensionReport(): Promise<ExtensionReport> {
  const errors: ExtensionReportError[] = []

  let toolPackError: string | null = null
  const toolPacks = await loadToolPacksFromDir().catch((error) => {
    toolPackError = errorMessage(error)
    return []
  })
  if (toolPackError) errors.push({ kind: 'toolPacks', message: toolPackError })

  const skillResult = await loadSkillsFromDir().catch((error) => ({
    skills: [],
    errors: [{ directory: getSkillsDir(), message: errorMessage(error) }],
  }))
  for (const skillError of skillResult.errors) {
    errors.push({ kind: 'skills', message: skillError.message })
  }

  return {
    ok: errors.length === 0,
    dataDir: getDataDir(),
    toolPacksDir: getToolPacksDir(),
    skillsDir: getSkillsDir(),
    toolPacks: toolPacks.map((pack) => ({
      id: pack.toolPack.id,
      name: pack.toolPack.name,
      directory: pack.directory,
      manifestPath: pack.manifestPath,
      tools: pack.toolPack.tools.map((tool) => tool.spec.function.name),
    })),
    skills: skillResult.skills.map((skill) => ({
      name: skill.definition.name,
      description: skill.definition.description,
      directory: skill.directory,
      skillPath: skill.skillPath,
    })),
    errors,
  }
}
