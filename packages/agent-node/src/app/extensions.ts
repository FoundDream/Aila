import { cp, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { listIntegrationDefinitions } from './integrations'
import { type LoadedMcpServerConfig, loadMcpServerConfigs } from './mcp-config'
import { getMcpConnectionSnapshots } from './mcp-connection-manager'
import { getMcpOAuthStatus, type PublicMcpOAuthStatus } from './mcp-oauth'
import { getMcpConnectionScopeKey } from './mcp-tools'
import { getDataDir, getSkillsDir } from './paths'
import { loadSkillFromDir, loadSkillsFromDir } from './skill-loader'

export type ExtensionReportErrorKind = 'skills' | 'mcp'

export interface ExtensionReportError {
  kind: ExtensionReportErrorKind
  message: string
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
  integrationId?: string
  auth?: PublicMcpOAuthStatus
  error?: string
}

export interface ExtensionIntegrationReport {
  id: string
  label: string
  provider: string
  mcpServerName: string
  endpoint: string
  requiredScopes: string[]
  configured: boolean
  docsUrl: string
  server?: ExtensionMcpServerReport
}

export interface ExtensionReport {
  ok: boolean
  dataDir: string
  skillsDir: string
  mcpConfigPath: string
  projectMcpConfigPath: string
  skills: ExtensionSkillReport[]
  integrations: ExtensionIntegrationReport[]
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
    mcpServers: await Promise.all(
      Object.entries(config.servers).map(async ([name, server]) => {
        const snapshot = snapshots.get(name)
        const status =
          server.enabled === false
            ? 'disabled'
            : (snapshot?.status ?? ('not_connected' as ExtensionMcpServerReport['status']))
        const auth = await getMcpOAuthStatus(server)
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
          ...(server.integrationId && { integrationId: server.integrationId }),
          ...(auth && { auth }),
          ...(snapshot?.error && { error: snapshot.error }),
        }
      }),
    ),
    errors: config.errors.map((error) => ({
      kind: 'mcp' as const,
      message: `${error.source} ${error.path}: ${error.message}`,
    })),
  }
}

function buildIntegrationReports(
  mcpServers: ExtensionMcpServerReport[],
): ExtensionIntegrationReport[] {
  return listIntegrationDefinitions().map((integration) => {
    const server = mcpServers.find(
      (candidate) =>
        candidate.integrationId === integration.id ||
        (candidate.source === 'user' && candidate.name === integration.mcpServerName),
    )
    return {
      id: integration.id,
      label: integration.label,
      provider: integration.provider,
      mcpServerName: integration.mcpServerName,
      endpoint: integration.endpoint,
      requiredScopes: [...integration.requiredScopes],
      configured: Boolean(server),
      docsUrl: integration.docsUrl,
      ...(server && { server }),
    }
  })
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

export async function getExtensionReport(cwd = process.cwd()): Promise<ExtensionReport> {
  const errors: ExtensionReportError[] = []

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
    skillsDir: getSkillsDir(),
    mcpConfigPath: mcp.mcpConfigPath,
    projectMcpConfigPath: mcp.projectMcpConfigPath,
    skills: skillResult.skills.map((skill) => ({
      name: skill.definition.name,
      description: skill.definition.description,
      directory: skill.directory,
      skillPath: skill.skillPath,
    })),
    integrations: buildIntegrationReports(mcp.mcpServers),
    mcpServers: mcp.mcpServers,
    errors,
  }
}
