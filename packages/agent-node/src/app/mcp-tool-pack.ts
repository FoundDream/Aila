import type { ToolPack, ToolPackEntry } from '@aila/agent'
import {
  type LoadedMcpServerConfig,
  loadMcpServerConfigs,
  type McpConfigLoadResult,
} from './mcp-config'
import type { McpToolDefinition } from './mcp-connection-manager'
import { callMcpTool, getAllMcpTools, syncMcpConnections } from './mcp-connection-manager'

const MCP_TOOL_PACK_ID = 'mcp'
const MCP_TOOL_PACK_NAME = 'MCP Servers'
const MCP_RESULT_MAX_BYTES = 64 * 1024
const MCP_INLINE_DATA_CHARS = 8192

type McpContentBlock = Record<string, unknown> & { type?: unknown }

export interface LoadMcpToolPackOptions {
  loadResult?: McpConfigLoadResult
  cwd?: string
  scopeKey?: string
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf-8')
}

function truncateString(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value
  const truncated = Buffer.from(value, 'utf-8').subarray(0, maxBytes).toString('utf-8')
  return `${truncated}\n[truncated: ${byteLength(value) - byteLength(truncated)} bytes omitted]`
}

function truncateData(value: string): { data: string; truncated: boolean; sizeChars: number } {
  return {
    data: value.length > MCP_INLINE_DATA_CHARS ? value.slice(0, MCP_INLINE_DATA_CHARS) : value,
    truncated: value.length > MCP_INLINE_DATA_CHARS,
    sizeChars: value.length,
  }
}

function normalizeMcpContentBlock(block: McpContentBlock): Record<string, unknown> {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text }
  }

  if (
    (block.type === 'image' || block.type === 'audio') &&
    typeof block.data === 'string' &&
    typeof block.mimeType === 'string'
  ) {
    const data = truncateData(block.data)
    return {
      type: block.type,
      mimeType: block.mimeType,
      dataBase64: data.data,
      dataTruncated: data.truncated,
      dataSizeChars: data.sizeChars,
    }
  }

  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    return {
      type: 'resource_link',
      uri: block.uri,
      name: typeof block.name === 'string' ? block.name : undefined,
      title: typeof block.title === 'string' ? block.title : undefined,
      description: typeof block.description === 'string' ? block.description : undefined,
      mimeType: typeof block.mimeType === 'string' ? block.mimeType : undefined,
      size: typeof block.size === 'number' ? block.size : undefined,
    }
  }

  if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
    const resource = block.resource as Record<string, unknown>
    if (typeof resource.text === 'string') {
      return {
        type: 'resource',
        uri: typeof resource.uri === 'string' ? resource.uri : undefined,
        mimeType: typeof resource.mimeType === 'string' ? resource.mimeType : undefined,
        text: truncateString(resource.text, MCP_RESULT_MAX_BYTES / 2),
      }
    }
    if (typeof resource.blob === 'string') {
      const data = truncateData(resource.blob)
      return {
        type: 'resource',
        uri: typeof resource.uri === 'string' ? resource.uri : undefined,
        mimeType: typeof resource.mimeType === 'string' ? resource.mimeType : undefined,
        blobBase64: data.data,
        blobTruncated: data.truncated,
        blobSizeChars: data.sizeChars,
      }
    }
  }

  return block
}

function normalizeMcpCallResult(serverName: string, toolName: string, result: unknown): string {
  if (!result || typeof result !== 'object') {
    return truncateString(JSON.stringify({ serverName, toolName, result }), MCP_RESULT_MAX_BYTES)
  }

  const object = result as Record<string, unknown>
  if ('toolResult' in object) {
    return truncateString(
      JSON.stringify(
        {
          serverName,
          toolName,
          toolResult: object.toolResult,
          meta: object._meta,
        },
        null,
        2,
      ),
      MCP_RESULT_MAX_BYTES,
    )
  }

  const content = Array.isArray(object.content)
    ? object.content
        .filter((block): block is McpContentBlock => Boolean(block) && typeof block === 'object')
        .map(normalizeMcpContentBlock)
    : []

  const formatted = JSON.stringify(
    {
      serverName,
      toolName,
      isError: object.isError === true,
      structuredContent: object.structuredContent,
      content,
      meta: object._meta,
    },
    null,
    2,
  )

  if (object.isError === true) {
    throw new Error(truncateString(formatted, MCP_RESULT_MAX_BYTES))
  }
  return truncateString(formatted, MCP_RESULT_MAX_BYTES)
}

function createMcpToolEntry(tool: McpToolDefinition): ToolPackEntry {
  const readOnly = tool.readOnlyHint === true && tool.destructiveHint !== true
  const requiresApproval = tool.approval !== 'auto'
  return {
    spec: {
      type: 'function',
      function: {
        name: tool.qualifiedName,
        description: [
          tool.description,
          '',
          `MCP server: ${tool.serverName}. Original tool: ${tool.originalName}.`,
        ]
          .filter(Boolean)
          .join('\n'),
        parameters: tool.inputSchema,
      },
      metadata: {
        name: tool.qualifiedName,
        readOnly,
        destructive: tool.destructiveHint === true,
        requiresApproval,
        access: readOnly ? ['read'] : ['network'],
        scope: ['external'],
        maxResultBytes: MCP_RESULT_MAX_BYTES,
      },
    },
    run: async (args, ctx) => {
      const result = await callMcpTool(tool.connectionKey, tool.originalName, args, ctx.signal)
      return normalizeMcpCallResult(tool.serverName, tool.originalName, result)
    },
  }
}

export function getMcpConnectionScopeKey(config: Pick<McpConfigLoadResult, 'projectConfigPath'>) {
  return config.projectConfigPath
}

export async function loadMcpToolPack(
  options: LoadMcpToolPackOptions = {},
): Promise<ToolPack | null> {
  const config = options.loadResult ?? (await loadMcpServerConfigs(options.cwd))
  const scopeKey = options.scopeKey ?? getMcpConnectionScopeKey(config)
  await syncMcpConnections(config.servers, scopeKey)
  const tools = getAllMcpTools(scopeKey)
  if (tools.length === 0) return null
  return {
    id: MCP_TOOL_PACK_ID,
    name: MCP_TOOL_PACK_NAME,
    description: 'Tools discovered from configured MCP servers.',
    tools: tools.map(createMcpToolEntry),
  }
}

export type { LoadedMcpServerConfig }
