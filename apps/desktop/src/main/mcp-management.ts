import {
  clearMcpOAuthCredentials,
  deleteUserMcpServerConfig,
  loadMcpServerConfigs,
  type McpOAuthFlowResult,
  type McpServerProbeResult,
  type OpenExternalUrl,
  parseUserMcpServerConfig,
  probeMcpServer,
  setMcpServerEnabledOverride,
  startMcpOAuthFlow,
  upsertUserMcpServerConfig,
} from '@aila/agent-node/app'

export interface SaveMcpServerRequest {
  name: string
  server: unknown
}

export async function saveUserMcpServerConfig(request: SaveMcpServerRequest): Promise<void> {
  await upsertUserMcpServerConfig(request.name, request.server)
}

export async function deleteUserMcpServer(name: string): Promise<void> {
  await deleteUserMcpServerConfig(name)
}

export async function setMcpServerEnabled(
  name: string,
  enabled: boolean,
  cwd = process.cwd(),
): Promise<void> {
  await setMcpServerEnabledOverride(name, enabled, cwd)
}

export async function testConfiguredMcpServer(
  name: string,
  cwd = process.cwd(),
): Promise<McpServerProbeResult> {
  const serverName = name.trim()
  const config = await loadMcpServerConfigs(cwd)
  const server = config.servers[serverName]
  if (!server) throw new Error(`MCP server "${serverName}" is not configured`)
  if (server.enabled === false) {
    return { ok: false, tools: [], error: `MCP server "${serverName}" is disabled` }
  }
  return probeMcpServer(server)
}

export async function testMcpServerDraft(
  request: SaveMcpServerRequest,
): Promise<McpServerProbeResult> {
  return probeMcpServer(parseUserMcpServerConfig(request.name, request.server))
}

export async function startMcpOAuthForServer(
  name: string,
  options: { openExternal: OpenExternalUrl; cwd?: string },
): Promise<McpOAuthFlowResult> {
  const serverName = name.trim()
  const config = await loadMcpServerConfigs(options.cwd)
  const server = config.servers[serverName]
  if (!server) throw new Error(`MCP server "${serverName}" is not configured`)
  return startMcpOAuthFlow(server, { openExternal: options.openExternal })
}

export async function clearMcpOAuthForServer(name: string, cwd = process.cwd()): Promise<void> {
  const serverName = name.trim()
  const config = await loadMcpServerConfigs(cwd)
  const server = config.servers[serverName]
  if (!server) throw new Error(`MCP server "${serverName}" is not configured`)
  await clearMcpOAuthCredentials(server)
}
