import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, Tool as SdkMcpTool } from '@modelcontextprotocol/sdk/types.js'
import type { LoadedMcpServerConfig, McpApprovalPolicy } from './mcp-config'
import { createMcpOAuthProvider } from './mcp-oauth'

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_TOOL_TIMEOUT_MS = 60_000

export type McpConnectionStatus = 'connected' | 'connecting' | 'failed' | 'disabled'

export interface McpToolDefinition {
  qualifiedName: string
  originalName: string
  serverName: string
  connectionKey: string
  description: string
  inputSchema: Record<string, unknown>
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  openWorldHint?: boolean
  approval: McpApprovalPolicy
}

export interface McpConnectionSnapshot {
  name: string
  scopeKey: string
  connectionKey: string
  type: LoadedMcpServerConfig['type']
  source: LoadedMcpServerConfig['source']
  sourcePath: string
  status: McpConnectionStatus
  tools: McpToolDefinition[]
  error?: string
  updatedAt: number
}

interface McpConnection {
  key: string
  name: string
  scopeKey: string
  config: LoadedMcpServerConfig
  fingerprint: string
  client: Client | null
  transport: Transport | null
  tools: McpToolDefinition[]
  status: McpConnectionStatus
  error?: string
  updatedAt: number
}

const connections = new Map<string, McpConnection>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`
}

function configFingerprint(config: LoadedMcpServerConfig): string {
  return stableStringify(config)
}

function sanitizeToolNamePart(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return sanitized || 'unnamed'
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function getConnectionKey(scopeKey: string, serverName: string): string {
  return `${shortHash(scopeKey)}:${serverName}`
}

function sanitizeServerNamePart(value: string): string {
  const sanitized = sanitizeToolNamePart(value)
  return sanitized === value ? sanitized : `${sanitized}_${shortHash(value)}`
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  const object = structuredClone(schema) as Record<string, unknown>
  return {
    ...object,
    type: 'object',
    properties:
      object.properties &&
      typeof object.properties === 'object' &&
      !Array.isArray(object.properties)
        ? object.properties
        : {},
  }
}

function toolApproval(config: LoadedMcpServerConfig, toolName: string): McpApprovalPolicy {
  return config.tools?.[toolName]?.approval ?? config.approval ?? 'ask'
}

function createToolDefinitions(
  serverName: string,
  connectionKey: string,
  config: LoadedMcpServerConfig,
  tools: SdkMcpTool[],
): McpToolDefinition[] {
  const serverPart = sanitizeServerNamePart(serverName)
  const used = new Set<string>()
  return tools
    .filter((tool) => toolApproval(config, tool.name) !== 'deny')
    .map((tool) => {
      const baseName = `mcp__${serverPart}__${sanitizeToolNamePart(tool.name)}`
      let qualifiedName = baseName
      let suffix = 2
      while (used.has(qualifiedName)) {
        qualifiedName = `${baseName}_${suffix}`
        suffix += 1
      }
      used.add(qualifiedName)

      return {
        qualifiedName,
        originalName: tool.name,
        serverName,
        connectionKey,
        description: tool.description ?? tool.title ?? `MCP tool ${tool.name} from ${serverName}`,
        inputSchema: normalizeInputSchema(tool.inputSchema),
        ...(tool.title && { title: tool.title }),
        ...(tool.annotations?.readOnlyHint !== undefined && {
          readOnlyHint: tool.annotations.readOnlyHint,
        }),
        ...(tool.annotations?.destructiveHint !== undefined && {
          destructiveHint: tool.annotations.destructiveHint,
        }),
        ...(tool.annotations?.openWorldHint !== undefined && {
          openWorldHint: tool.annotations.openWorldHint,
        }),
        approval: toolApproval(config, tool.name),
      }
    })
}

async function listAllTools(client: Client, timeout: number): Promise<SdkMcpTool[]> {
  const tools: SdkMcpTool[] = []
  let cursor: string | undefined
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout })
    tools.push(...result.tools)
    cursor = result.nextCursor
  } while (cursor)
  return tools
}

function createHttpHeaders(config: LoadedMcpServerConfig): Record<string, string> | undefined {
  return config.headers && Object.keys(config.headers).length > 0
    ? { ...config.headers }
    : undefined
}

function createTransport(config: LoadedMcpServerConfig): Transport {
  if (config.type === 'stdio') {
    return new StdioClientTransport({
      command: config.command ?? '',
      args: config.args ?? [],
      cwd: config.cwd,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      stderr: 'pipe',
    })
  }

  if (!config.url) throw new Error(`MCP server "${config.name}" has no url`)
  const headers = createHttpHeaders(config)
  const requestInit = headers ? { headers } : undefined
  const authProvider = config.auth?.type === 'oauth' ? createMcpOAuthProvider(config) : undefined
  const transportOptions = {
    ...(requestInit && { requestInit }),
    ...(authProvider && { authProvider }),
  }
  if (config.type === 'sse') {
    return new SSEClientTransport(new URL(config.url), transportOptions)
  }
  return new StreamableHTTPClientTransport(new URL(config.url), transportOptions)
}

async function connectScopedMcpServer(
  name: string,
  config: LoadedMcpServerConfig,
  scopeKey: string,
): Promise<void> {
  const key = getConnectionKey(scopeKey, name)
  const fingerprint = configFingerprint(config)
  const connection: McpConnection = {
    key,
    name,
    scopeKey,
    config,
    fingerprint,
    client: null,
    transport: null,
    tools: [],
    status: config.enabled === false ? 'disabled' : 'connecting',
    updatedAt: Date.now(),
  }
  connections.set(key, connection)

  if (config.enabled === false) return

  try {
    const client = new Client({
      name: `aila-${sanitizeToolNamePart(name)}-${shortHash(scopeKey)}`,
      version: '0.1.0',
    })
    const transport = createTransport(config)
    connection.client = client
    connection.transport = transport
    const startupTimeout = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    await client.connect(transport, { timeout: startupTimeout })
    const tools = await listAllTools(client, startupTimeout)

    connection.tools = createToolDefinitions(name, key, config, tools)
    connection.status = 'connected'
    connection.error = undefined
    connection.updatedAt = Date.now()
  } catch (error) {
    connection.status = 'failed'
    connection.error = errorMessage(error)
    connection.updatedAt = Date.now()
    try {
      await connection.client?.close()
    } catch {
      // ignore cleanup errors from failed starts
    }
    connection.client = null
    connection.transport = null
  }
}

async function disconnectScopedMcpServer(name: string, scopeKey: string): Promise<void> {
  const key = getConnectionKey(scopeKey, name)
  const connection = connections.get(key)
  if (!connection) return
  connections.delete(key)
  try {
    await connection.client?.close()
  } catch {
    // ignore close errors; the connection is being discarded
  }
}

export async function syncMcpConnections(
  configs: Record<string, LoadedMcpServerConfig>,
  scopeKey = 'default',
): Promise<void> {
  const desiredKeys = new Set(Object.keys(configs).map((name) => getConnectionKey(scopeKey, name)))

  for (const connection of [...connections.values()]) {
    if (connection.scopeKey === scopeKey && !desiredKeys.has(connection.key)) {
      await disconnectScopedMcpServer(connection.name, scopeKey)
    }
  }

  for (const [name, config] of Object.entries(configs)) {
    const key = getConnectionKey(scopeKey, name)
    const fingerprint = configFingerprint(config)
    const existing = connections.get(key)
    if (!existing || existing.fingerprint !== fingerprint || existing.status === 'failed') {
      if (existing) await disconnectScopedMcpServer(name, scopeKey)
      await connectScopedMcpServer(name, config, scopeKey)
    }
  }
}

export async function callMcpTool(
  connectionKey: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult | unknown> {
  const connection = connections.get(connectionKey)
  if (!connection?.client || connection.status !== 'connected') {
    throw new Error(`MCP server "${connection?.name ?? connectionKey}" is not connected`)
  }
  return connection.client.callTool(
    {
      name: toolName,
      arguments: args,
    },
    undefined,
    {
      timeout: connection.config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      ...(signal && { signal }),
    },
  )
}

export function getAllMcpTools(scopeKey = 'default'): McpToolDefinition[] {
  return [...connections.values()].flatMap((connection) =>
    connection.scopeKey === scopeKey && connection.status === 'connected' ? connection.tools : [],
  )
}

export function getMcpConnectionSnapshots(scopeKey?: string): McpConnectionSnapshot[] {
  return [...connections.values()]
    .filter((connection) => scopeKey === undefined || connection.scopeKey === scopeKey)
    .map((connection) => ({
      name: connection.name,
      scopeKey: connection.scopeKey,
      connectionKey: connection.key,
      type: connection.config.type,
      source: connection.config.source,
      sourcePath: connection.config.sourcePath,
      status: connection.status,
      tools: connection.tools.map((tool) => ({
        ...tool,
        inputSchema: structuredClone(tool.inputSchema),
      })),
      ...(connection.error && { error: connection.error }),
      updatedAt: connection.updatedAt,
    }))
}

export interface McpServerProbeResult {
  ok: boolean
  tools: string[]
  error?: string
}

export async function probeMcpServer(config: LoadedMcpServerConfig): Promise<McpServerProbeResult> {
  let client: Client | null = null
  try {
    client = new Client({
      name: `aila-probe-${sanitizeToolNamePart(config.name)}-${shortHash(Date.now().toString())}`,
      version: '0.1.0',
    })
    const transport = createTransport(config)
    const startupTimeout = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    await client.connect(transport, { timeout: startupTimeout })
    const tools = await listAllTools(client, startupTimeout)
    return { ok: true, tools: tools.map((tool) => tool.name) }
  } catch (error) {
    return { ok: false, tools: [], error: errorMessage(error) }
  } finally {
    try {
      await client?.close()
    } catch {
      // ignore probe cleanup errors
    }
  }
}

export async function disposeMcpConnections(): Promise<void> {
  const current = [...connections.values()]
  connections.clear()
  await Promise.all(
    current.map(async (connection) => {
      try {
        await connection.client?.close()
      } catch {
        // ignore shutdown cleanup errors
      }
    }),
  )
}
