import { cp, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { getDataDir, getSkillsDir, getToolPacksDir } from './paths'
import { loadSkillFromDir, loadSkillsFromDir } from './skill-loader'
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

const SKILL_INSTALL_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules'])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isSamePath(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right))
  } catch {
    return false
  }
}

function shouldCopySkillPath(path: string): boolean {
  return !SKILL_INSTALL_IGNORED_DIRECTORIES.has(basename(path))
}

function skillReportFromLoaded(
  skill: Awaited<ReturnType<typeof loadSkillFromDir>>,
): ExtensionSkillReport {
  return {
    name: skill.definition.name,
    description: skill.definition.description,
    directory: skill.directory,
    skillPath: skill.skillPath,
  }
}

export async function installSkillFromDirectory(directory: string): Promise<ExtensionSkillReport> {
  const source = resolve(directory)
  const sourceSkill = await loadSkillFromDir(source)
  const skillsDir = getSkillsDir()
  await mkdir(skillsDir, { recursive: true })

  const target = join(skillsDir, sourceSkill.definition.name)
  if (await isSamePath(source, target)) return skillReportFromLoaded(sourceSkill)
  if (await pathExists(target)) {
    throw new Error(`skill "${sourceSkill.definition.name}" is already installed`)
  }

  const staging = join(
    skillsDir,
    `.${sourceSkill.definition.name}.${process.pid}.${Date.now()}.installing`,
  )
  await rm(staging, { recursive: true, force: true })

  try {
    await cp(source, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: shouldCopySkillPath,
    })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return skillReportFromLoaded(await loadSkillFromDir(target))
}

export async function getSkillExtensionReport(): Promise<ExtensionReport> {
  const skillResult = await loadSkillsFromDir().catch((error) => ({
    skills: [],
    errors: [{ directory: getSkillsDir(), message: errorMessage(error) }],
  }))
  const errors = skillResult.errors.map((skillError) => ({
    kind: 'skills' as const,
    message: skillError.message,
  }))

  return {
    ok: errors.length === 0,
    dataDir: getDataDir(),
    toolPacksDir: getToolPacksDir(),
    skillsDir: getSkillsDir(),
    toolPacks: [],
    skills: skillResult.skills.map((skill) => ({
      name: skill.definition.name,
      description: skill.definition.description,
      directory: skill.directory,
      skillPath: skill.skillPath,
    })),
    errors,
  }
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
