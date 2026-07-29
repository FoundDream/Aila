import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getDataDir } from './paths'

export const AILA_MCP_CONFIG_FILE = 'mcp.json'
export const PROJECT_MCP_CONFIG_FILE = '.mcp.json'

export type McpTransportType = 'stdio' | 'http' | 'sse'
export type McpApprovalPolicy = 'ask' | 'auto' | 'deny'
export type McpConfigSourceKind = 'project' | 'claude-json' | 'claude-settings' | 'user'
export type McpOAuthTokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none'

export interface McpToolPolicy {
  approval?: McpApprovalPolicy
}

export interface McpOAuthConfig {
  type: 'oauth'
  clientId?: string
  clientSecret?: string
  scopes?: string[]
  redirectUri?: string
  clientName?: string
  authorizationParams?: Record<string, string>
  tokenEndpointAuthMethod?: McpOAuthTokenEndpointAuthMethod
}

export interface McpServerConfig {
  type?: McpTransportType | 'streamable-http'
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  envHttpHeaders?: Record<string, string>
  bearerTokenEnvVar?: string
  enabled?: boolean
  integrationId?: string
  auth?: McpOAuthConfig
  approval?: McpApprovalPolicy
  tools?: Record<string, McpToolPolicy>
  startupTimeoutMs?: number
  toolTimeoutMs?: number
}

export interface LoadedMcpServerConfig
  extends Omit<McpServerConfig, 'type' | 'env' | 'headers' | 'envHttpHeaders'> {
  name: string
  type: McpTransportType
  env?: Record<string, string>
  headers?: Record<string, string>
  source: McpConfigSourceKind
  sourcePath: string
}

export interface McpConfigLoadError {
  source: McpConfigSourceKind
  path: string
  message: string
}

export interface McpConfigLoadResult {
  servers: Record<string, LoadedMcpServerConfig>
  errors: McpConfigLoadError[]
  userConfigPath: string
  projectConfigPath: string
}

interface RawMcpConfigFile {
  mcpServers?: Record<string, unknown>
  mcpServerOverrides?: Record<string, { enabled?: boolean }>
}

type WritableMcpConfigFile = Record<string, unknown> & RawMcpConfigFile

interface McpConfigSource {
  kind: McpConfigSourceKind
  path: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function getUserMcpConfigPath(): string {
  return join(getDataDir(), AILA_MCP_CONFIG_FILE)
}

export function getProjectMcpConfigPath(cwd = process.cwd()): string {
  return join(resolve(cwd), PROJECT_MCP_CONFIG_FILE)
}

function getConfigSources(cwd = process.cwd()): McpConfigSource[] {
  return [
    { kind: 'project', path: getProjectMcpConfigPath(cwd) },
    { kind: 'claude-json', path: join(homedir(), '.claude.json') },
    { kind: 'claude-settings', path: join(homedir(), '.claude', 'settings.json') },
    { kind: 'user', path: getUserMcpConfigPath() },
  ]
}

async function readJsonIfPresent(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw)
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function cloneJsonObject(value: unknown, label: string): Record<string, unknown> {
  const object = asObject(value)
  if (!object) throw new Error(`${label} must be an object`)
  return JSON.parse(JSON.stringify(object)) as Record<string, unknown>
}

function parseStringArray(value: unknown, field: string, serverName: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`MCP server "${serverName}" field "${field}" must be an array of strings`)
  }
  return [...value]
}

function parseStringMap(
  value: unknown,
  field: string,
  serverName: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const object = asObject(value)
  if (!object) {
    throw new Error(`MCP server "${serverName}" field "${field}" must be an object`)
  }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(object)) {
    if (typeof item !== 'string') {
      throw new Error(`MCP server "${serverName}" field "${field}.${key}" must be a string`)
    }
    out[key] = item
  }
  return out
}

function parseApproval(value: unknown, serverName: string): McpApprovalPolicy | undefined {
  if (value === undefined) return undefined
  if (value === 'ask' || value === 'auto' || value === 'deny') return value
  throw new Error(`MCP server "${serverName}" field "approval" must be ask, auto, or deny`)
}

function parseTokenEndpointAuthMethod(
  value: unknown,
  serverName: string,
): McpOAuthTokenEndpointAuthMethod | undefined {
  if (value === undefined) return undefined
  if (value === 'client_secret_basic' || value === 'client_secret_post' || value === 'none') {
    return value
  }
  throw new Error(
    `MCP server "${serverName}" field "auth.tokenEndpointAuthMethod" must be client_secret_basic, client_secret_post, or none`,
  )
}

function parseTimeout(value: unknown, field: string, serverName: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`MCP server "${serverName}" field "${field}" must be a positive number`)
  }
  return Math.floor(value)
}

function normalizeTransport(value: unknown, server: Record<string, unknown>): McpTransportType {
  const raw = value ?? (typeof server.url === 'string' ? 'http' : 'stdio')
  if (raw === 'streamable-http') return 'http'
  if (raw === 'stdio' || raw === 'http' || raw === 'sse') return raw
  throw new Error(`MCP server transport must be stdio, http, streamable-http, or sse`)
}

function resolvePlaceholders(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    return process.env[name] ?? ''
  })
}

function resolveStringMapValues(
  values?: Record<string, string>,
): Record<string, string> | undefined {
  if (!values) return undefined
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, resolvePlaceholders(value)]),
  )
}

function resolveHttpHeaders(
  headers?: Record<string, string>,
  envHttpHeaders?: Record<string, string>,
  bearerTokenEnvVar?: string,
): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = resolvePlaceholders(value)
  }
  for (const [key, envName] of Object.entries(envHttpHeaders ?? {})) {
    const value = process.env[envName]
    if (value) out[key] = value
  }
  if (bearerTokenEnvVar) {
    const token = process.env[bearerTokenEnvVar]
    if (token) out.Authorization = `Bearer ${token}`
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseOptionalTrimmedString(
  value: unknown,
  field: string,
  serverName: string,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`MCP server "${serverName}" field "${field}" must be a string`)
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function parseOAuthConfig(value: unknown, serverName: string): McpOAuthConfig | undefined {
  if (value === undefined) return undefined
  const object = asObject(value)
  if (!object) throw new Error(`MCP server "${serverName}" field "auth" must be an object`)
  if (object.type !== 'oauth') {
    throw new Error(`MCP server "${serverName}" field "auth.type" must be oauth`)
  }

  const clientId = parseOptionalTrimmedString(object.clientId, 'auth.clientId', serverName)
  const clientSecret = parseOptionalTrimmedString(
    object.clientSecret,
    'auth.clientSecret',
    serverName,
  )
  const scopes = parseStringArray(object.scopes, 'auth.scopes', serverName)
    ?.map((scope) => scope.trim())
    .filter(Boolean)
  const redirectUri = parseOptionalTrimmedString(object.redirectUri, 'auth.redirectUri', serverName)
  const clientName = parseOptionalTrimmedString(object.clientName, 'auth.clientName', serverName)
  const authorizationParams =
    object.authorizationParams !== undefined
      ? parseStringMap(object.authorizationParams, 'auth.authorizationParams', serverName)
      : undefined
  const tokenEndpointAuthMethod = parseTokenEndpointAuthMethod(
    object.tokenEndpointAuthMethod,
    serverName,
  )
  if (redirectUri) {
    try {
      new URL(redirectUri)
    } catch {
      throw new Error(`MCP server "${serverName}" field "auth.redirectUri" must be a URL`)
    }
  }

  return {
    type: 'oauth',
    ...(clientId && { clientId }),
    ...(clientSecret && { clientSecret }),
    ...(scopes && scopes.length > 0 && { scopes }),
    ...(redirectUri && { redirectUri }),
    ...(clientName && { clientName }),
    ...(authorizationParams && { authorizationParams }),
    ...(tokenEndpointAuthMethod && { tokenEndpointAuthMethod }),
  }
}

function parseToolPolicies(
  value: unknown,
  serverName: string,
): Record<string, McpToolPolicy> | undefined {
  if (value === undefined) return undefined
  const object = asObject(value)
  if (!object) {
    throw new Error(`MCP server "${serverName}" field "tools" must be an object`)
  }
  const out: Record<string, McpToolPolicy> = {}
  for (const [toolName, raw] of Object.entries(object)) {
    const tool = asObject(raw)
    if (!tool) {
      throw new Error(`MCP server "${serverName}" tool policy "${toolName}" must be an object`)
    }
    out[toolName] = {
      ...(tool.approval !== undefined && { approval: parseApproval(tool.approval, serverName) }),
    }
  }
  return out
}

function parseServerConfig(
  name: string,
  raw: unknown,
  source: McpConfigSource,
): LoadedMcpServerConfig {
  const object = asObject(raw)
  if (!object) throw new Error(`MCP server "${name}" must be an object`)

  const type = normalizeTransport(object.type, object)
  const command = typeof object.command === 'string' ? object.command.trim() : undefined
  const url = typeof object.url === 'string' ? object.url.trim() : undefined
  if (type === 'stdio' && !command) {
    throw new Error(`MCP server "${name}" is stdio but has no command`)
  }
  if ((type === 'http' || type === 'sse') && !url) {
    throw new Error(`MCP server "${name}" is ${type} but has no url`)
  }

  const env = resolveStringMapValues(parseStringMap(object.env, 'env', name))
  const rawHeaders = parseStringMap(object.headers, 'headers', name)
  const envHttpHeaders = parseStringMap(object.envHttpHeaders, 'envHttpHeaders', name)
  const bearerTokenEnvVar =
    typeof object.bearerTokenEnvVar === 'string' ? object.bearerTokenEnvVar : undefined
  const headers = resolveHttpHeaders(rawHeaders, envHttpHeaders, bearerTokenEnvVar)
  const args = parseStringArray(object.args, 'args', name)
  const cwd =
    typeof object.cwd === 'string' && object.cwd.trim()
      ? resolve(dirname(source.path), object.cwd)
      : undefined
  const integrationId = parseOptionalTrimmedString(object.integrationId, 'integrationId', name)
  const auth = parseOAuthConfig(object.auth, name)

  return {
    name,
    type,
    source: source.kind,
    sourcePath: source.path,
    ...(command && { command }),
    ...(args && { args }),
    ...(cwd && { cwd }),
    ...(env && { env }),
    ...(url && { url }),
    ...(headers && { headers }),
    ...(bearerTokenEnvVar && { bearerTokenEnvVar }),
    ...(typeof object.enabled === 'boolean' && { enabled: object.enabled }),
    ...(integrationId && { integrationId }),
    ...(auth && { auth }),
    ...(object.approval !== undefined && { approval: parseApproval(object.approval, name) }),
    ...(object.tools !== undefined && { tools: parseToolPolicies(object.tools, name) }),
    ...(object.startupTimeoutMs !== undefined && {
      startupTimeoutMs: parseTimeout(object.startupTimeoutMs, 'startupTimeoutMs', name),
    }),
    ...(object.toolTimeoutMs !== undefined && {
      toolTimeoutMs: parseTimeout(object.toolTimeoutMs, 'toolTimeoutMs', name),
    }),
  }
}

export function parseUserMcpServerConfig(name: string, raw: unknown): LoadedMcpServerConfig {
  return parseServerConfig(normalizeMcpServerName(name), raw, {
    kind: 'user',
    path: getUserMcpConfigPath(),
  })
}

function normalizeMcpServerName(name: string): string {
  const normalized = name.trim()
  if (!normalized) throw new Error('MCP server name is required')
  if ([...normalized].some((char) => char.charCodeAt(0) < 32)) {
    throw new Error('MCP server name cannot contain control characters')
  }
  return normalized
}

function readOverrides(raw: unknown): Record<string, { enabled?: boolean }> {
  const file = asObject(raw)
  const overrides = asObject(file?.mcpServerOverrides)
  if (!overrides) return {}
  const out: Record<string, { enabled?: boolean }> = {}
  for (const [name, value] of Object.entries(overrides)) {
    const object = asObject(value)
    if (!object || typeof object.enabled !== 'boolean') continue
    out[name] = { enabled: object.enabled }
  }
  return out
}

export async function loadMcpServerConfigs(cwd = process.cwd()): Promise<McpConfigLoadResult> {
  const errors: McpConfigLoadError[] = []
  const servers: Record<string, LoadedMcpServerConfig> = {}
  const overrides: Record<string, { enabled?: boolean }> = {}
  const sources = getConfigSources(cwd)

  for (const source of sources) {
    let raw: unknown | null
    try {
      raw = await readJsonIfPresent(source.path)
    } catch (error) {
      errors.push({ source: source.kind, path: source.path, message: errorMessage(error) })
      continue
    }
    if (!raw) continue

    Object.assign(overrides, readOverrides(raw))
    const file = asObject(raw) as RawMcpConfigFile | null
    const rawServers = asObject(file?.mcpServers)
    if (!rawServers) continue
    for (const [name, server] of Object.entries(rawServers)) {
      try {
        servers[name] = parseServerConfig(name, server, source)
      } catch (error) {
        errors.push({ source: source.kind, path: source.path, message: errorMessage(error) })
      }
    }
  }

  for (const [name, override] of Object.entries(overrides)) {
    if (servers[name] && override.enabled !== undefined) {
      servers[name] = { ...servers[name], enabled: override.enabled }
    }
  }

  return {
    servers,
    errors,
    userConfigPath: getUserMcpConfigPath(),
    projectConfigPath: getProjectMcpConfigPath(cwd),
  }
}

async function readUserMcpConfigForWrite(): Promise<WritableMcpConfigFile> {
  const raw = await readJsonIfPresent(getUserMcpConfigPath())
  if (!raw) return {}
  const object = asObject(raw)
  if (!object) throw new Error('Aila MCP config must be a JSON object')
  return { ...object } as WritableMcpConfigFile
}

function getWritableRecord(file: WritableMcpConfigFile, field: string): Record<string, unknown> {
  const current = file[field]
  if (current === undefined) {
    const next: Record<string, unknown> = {}
    file[field] = next
    return next
  }
  const object = asObject(current)
  if (!object) throw new Error(`Aila MCP config field "${field}" must be an object`)
  return object
}

async function writeUserMcpConfig(file: WritableMcpConfigFile): Promise<void> {
  const path = getUserMcpConfigPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
}

export async function upsertUserMcpServerConfig(
  name: string,
  server: unknown,
): Promise<LoadedMcpServerConfig> {
  const serverName = normalizeMcpServerName(name)
  const serverObject = cloneJsonObject(server, 'MCP server config')
  const parsed = parseUserMcpServerConfig(serverName, serverObject)
  const file = await readUserMcpConfigForWrite()
  const servers = getWritableRecord(file, 'mcpServers')
  servers[serverName] = serverObject
  await writeUserMcpConfig(file)
  return parsed
}

export async function deleteUserMcpServerConfig(name: string): Promise<void> {
  const serverName = normalizeMcpServerName(name)
  const file = await readUserMcpConfigForWrite()
  const servers = asObject(file.mcpServers)
  if (!servers || !(serverName in servers)) {
    throw new Error(`user MCP server "${serverName}" is not configured in Aila`)
  }
  delete servers[serverName]
  const overrides = asObject(file.mcpServerOverrides)
  if (overrides) delete overrides[serverName]
  await writeUserMcpConfig(file)
}

export async function setMcpServerEnabledOverride(
  name: string,
  enabled: boolean,
  cwd = process.cwd(),
): Promise<void> {
  const serverName = normalizeMcpServerName(name)
  const loaded = await loadMcpServerConfigs(cwd)
  if (!loaded.servers[serverName]) throw new Error(`MCP server "${serverName}" is not configured`)

  const file = await readUserMcpConfigForWrite()
  const servers = asObject(file.mcpServers)
  const userServer = asObject(servers?.[serverName])
  if (userServer) {
    userServer.enabled = enabled
  } else {
    const overrides = getWritableRecord(file, 'mcpServerOverrides')
    const current = asObject(overrides[serverName])
    overrides[serverName] = { ...(current ?? {}), enabled }
  }
  await writeUserMcpConfig(file)
}
