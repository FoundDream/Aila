import { cp, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { type LoadedMcpServerConfig, loadMcpServerConfigs } from './mcp-config'
import { getMcpConnectionSnapshots } from './mcp-connection-manager'
import { getMcpConnectionScopeKey } from './mcp-tool-pack'
import { getDataDir, getSkillsDir, getToolPacksDir } from './paths'
import { loadSkillFromDir, loadSkillsFromDir } from './skill-loader'
import { loadToolPacksFromDir } from './tool-pack-loader'

export type ExtensionReportErrorKind = 'toolPacks' | 'skills' | 'mcp'

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

export interface ExtensionMcpServerReport {
  name: string
  transport: LoadedMcpServerConfig['type']
  source: LoadedMcpServerConfig['source']
  sourcePath: string
  enabled: boolean
  status: 'connected' | 'connecting' | 'failed' | 'disabled' | 'not_connected'
  tools: string[]
  command?: string
  args?: string[]
  url?: string
  error?: string
}

export interface ExtensionReport {
  ok: boolean
  dataDir: string
  toolPacksDir: string
  skillsDir: string
  mcpConfigPath: string
  projectMcpConfigPath: string
  toolPacks: ExtensionToolPackReport[]
  skills: ExtensionSkillReport[]
  mcpServers: ExtensionMcpServerReport[]
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

async function buildMcpServerReports(cwd = process.cwd()): Promise<{
  mcpConfigPath: string
  projectMcpConfigPath: string
  mcpServers: ExtensionMcpServerReport[]
  errors: ExtensionReportError[]
}> {
  const config = await loadMcpServerConfigs(cwd)
  const scopeKey = getMcpConnectionScopeKey(config)
  const snapshots = new Map(
    getMcpConnectionSnapshots(scopeKey).map((snapshot) => [snapshot.name, snapshot]),
  )
  return {
    mcpConfigPath: config.userConfigPath,
    projectMcpConfigPath: config.projectConfigPath,
    mcpServers: Object.entries(config.servers).map(([name, server]) => {
      const snapshot = snapshots.get(name)
      const status =
        server.enabled === false
          ? 'disabled'
          : (snapshot?.status ?? ('not_connected' as ExtensionMcpServerReport['status']))
      return {
        name,
        transport: server.type,
        source: server.source,
        sourcePath: server.sourcePath,
        enabled: server.enabled !== false,
        status,
        tools: snapshot?.tools.map((tool) => tool.qualifiedName) ?? [],
        ...(server.command && { command: server.command }),
        ...(server.args && { args: [...server.args] }),
        ...(server.url && { url: server.url }),
        ...(snapshot?.error && { error: snapshot.error }),
      }
    }),
    errors: config.errors.map((error) => ({
      kind: 'mcp' as const,
      message: `${error.source} ${error.path}: ${error.message}`,
    })),
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

export async function getSkillExtensionReport(cwd = process.cwd()): Promise<ExtensionReport> {
  const mcp = await buildMcpServerReports(cwd).catch((error) => ({
    mcpConfigPath: '',
    projectMcpConfigPath: '',
    mcpServers: [],
    errors: [{ kind: 'mcp' as const, message: errorMessage(error) }],
  }))
  const skillResult = await loadSkillsFromDir().catch((error) => ({
    skills: [],
    errors: [{ directory: getSkillsDir(), message: errorMessage(error) }],
  }))
  const errors = skillResult.errors.map((skillError) => ({
    kind: 'skills' as const,
    message: skillError.message,
  }))

  return {
    ok: errors.length === 0 && mcp.errors.length === 0,
    dataDir: getDataDir(),
    toolPacksDir: getToolPacksDir(),
    skillsDir: getSkillsDir(),
    mcpConfigPath: mcp.mcpConfigPath,
    projectMcpConfigPath: mcp.projectMcpConfigPath,
    toolPacks: [],
    skills: skillResult.skills.map((skill) => ({
      name: skill.definition.name,
      description: skill.definition.description,
      directory: skill.directory,
      skillPath: skill.skillPath,
    })),
    mcpServers: mcp.mcpServers,
    errors: [...errors, ...mcp.errors],
  }
}

export async function getExtensionReport(cwd = process.cwd()): Promise<ExtensionReport> {
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

  const mcp = await buildMcpServerReports(cwd).catch((error) => ({
    mcpConfigPath: '',
    projectMcpConfigPath: '',
    mcpServers: [],
    errors: [{ kind: 'mcp' as const, message: errorMessage(error) }],
  }))
  errors.push(...mcp.errors)

  return {
    ok: errors.length === 0,
    dataDir: getDataDir(),
    toolPacksDir: getToolPacksDir(),
    skillsDir: getSkillsDir(),
    mcpConfigPath: mcp.mcpConfigPath,
    projectMcpConfigPath: mcp.projectMcpConfigPath,
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
    mcpServers: mcp.mcpServers,
    errors,
  }
}
