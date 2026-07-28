import {
  buildIntegrationMcpServerConfig,
  getIntegrationDefinition,
  listIntegrationDefinitions,
  type SaveIntegrationRequest,
} from './integrations'
import { upsertUserMcpServerConfig } from './mcp-config'

export type { IntegrationDefinition, IntegrationId, SaveIntegrationRequest } from './integrations'
export { listIntegrationDefinitions }

export async function saveIntegrationMcpServerConfig(
  request: SaveIntegrationRequest,
): Promise<void> {
  const integration = getIntegrationDefinition(request.id)
  const config = buildIntegrationMcpServerConfig(request)
  await upsertUserMcpServerConfig(integration.mcpServerName, config)
}
