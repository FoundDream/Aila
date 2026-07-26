import type { McpOAuthConfig, McpServerConfig, McpToolPolicy } from './mcp-config'

export type IntegrationId = 'gmail'

export interface IntegrationToolDefinition {
  name: string
  approval: NonNullable<McpToolPolicy['approval']>
  risk: 'read' | 'write'
}

export interface IntegrationDefinition {
  id: IntegrationId
  label: string
  provider: string
  mcpServerName: string
  endpoint: string
  transport: 'http'
  requiredScopes: string[]
  tools: IntegrationToolDefinition[]
  docsUrl: string
}

export interface SaveIntegrationRequest {
  id: IntegrationId
  oauth?: {
    clientId?: string
    clientSecret?: string
    redirectUri?: string
    scopes?: string[]
  }
}

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
]

const GMAIL_TOOLS: IntegrationToolDefinition[] = [
  { name: 'search_threads', approval: 'auto', risk: 'read' },
  { name: 'get_thread', approval: 'auto', risk: 'read' },
  { name: 'list_labels', approval: 'auto', risk: 'read' },
  { name: 'list_drafts', approval: 'auto', risk: 'read' },
  { name: 'create_draft', approval: 'ask', risk: 'write' },
  { name: 'label_message', approval: 'ask', risk: 'write' },
  { name: 'label_thread', approval: 'ask', risk: 'write' },
  { name: 'unlabel_message', approval: 'ask', risk: 'write' },
  { name: 'unlabel_thread', approval: 'ask', risk: 'write' },
]

export const INTEGRATIONS: IntegrationDefinition[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    provider: 'Google Workspace',
    mcpServerName: 'gmail',
    endpoint: 'https://gmailmcp.googleapis.com/mcp/v1',
    transport: 'http',
    requiredScopes: GMAIL_SCOPES,
    tools: GMAIL_TOOLS,
    docsUrl: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
  },
]

export function listIntegrationDefinitions(): IntegrationDefinition[] {
  return INTEGRATIONS.map((integration) => ({
    ...integration,
    requiredScopes: [...integration.requiredScopes],
    tools: integration.tools.map((tool) => ({ ...tool })),
  }))
}

export function getIntegrationDefinition(id: IntegrationId): IntegrationDefinition {
  const integration = INTEGRATIONS.find((candidate) => candidate.id === id)
  if (!integration) throw new Error(`unknown integration "${id}"`)
  return integration
}

function compactOAuthConfig(value: McpOAuthConfig): McpOAuthConfig {
  return {
    type: 'oauth',
    ...(value.clientId?.trim() && { clientId: value.clientId.trim() }),
    ...(value.clientSecret?.trim() && { clientSecret: value.clientSecret.trim() }),
    ...(value.scopes && value.scopes.length > 0 && { scopes: value.scopes }),
    ...(value.redirectUri?.trim() && { redirectUri: value.redirectUri.trim() }),
    ...(value.clientName?.trim() && { clientName: value.clientName.trim() }),
    ...(value.authorizationParams &&
      Object.keys(value.authorizationParams).length > 0 && {
        authorizationParams: value.authorizationParams,
      }),
    ...(value.tokenEndpointAuthMethod && {
      tokenEndpointAuthMethod: value.tokenEndpointAuthMethod,
    }),
  }
}

export function buildIntegrationMcpServerConfig(request: SaveIntegrationRequest): McpServerConfig {
  const integration = getIntegrationDefinition(request.id)
  const scopes = request.oauth?.scopes?.length ? request.oauth.scopes : integration.requiredScopes
  const tools = Object.fromEntries(
    integration.tools.map((tool) => [tool.name, { approval: tool.approval }]),
  )
  const auth = compactOAuthConfig({
    type: 'oauth',
    scopes,
    clientName: `Aila ${integration.label}`,
    authorizationParams: {
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
    },
    tokenEndpointAuthMethod: request.oauth?.clientSecret ? 'client_secret_post' : 'none',
    ...(request.oauth?.clientId?.trim() && { clientId: request.oauth.clientId.trim() }),
    ...(request.oauth?.clientSecret?.trim() && { clientSecret: request.oauth.clientSecret.trim() }),
    ...(request.oauth?.redirectUri?.trim() && { redirectUri: request.oauth.redirectUri.trim() }),
  })

  return {
    type: integration.transport,
    url: integration.endpoint,
    enabled: true,
    integrationId: integration.id,
    auth,
    approval: 'ask',
    tools,
  }
}
