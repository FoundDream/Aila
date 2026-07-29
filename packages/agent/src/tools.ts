/**
 * Tool definitions and local executor for the agent loop.
 *
 * Tools are passed to OpenRouter using the OpenAI-compatible function-calling
 * schema. When the model emits a tool_call, the agent loop invokes the matching
 * handler here and feeds the result back as a `role: "tool"` message.
 */

import type { ProviderId } from './models'
import type { Settings } from './settings-types'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ToolAccess = 'read' | 'write' | 'shell' | 'network' | 'image'
export type ToolScope = 'workspace' | 'external' | 'image_library'

export interface ToolMetadata {
  name: string
  readOnly: boolean
  destructive: boolean
  requiresApproval: boolean
  access: ToolAccess[]
  scope: ToolScope[]
  maxResultBytes?: number
}

export interface ToolActivityTarget {
  kind: 'file' | 'command' | 'query' | 'prompt'
  preview: string
  size: number
}

export interface ToolSpec extends ToolDefinition {
  metadata: ToolMetadata
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>

export interface ToolPackEntry {
  spec: ToolSpec
  run: ToolHandler
}

export interface ToolPack {
  id: string
  name: string
  description?: string
  tools: ToolPackEntry[]
}

export interface ToolRegistry {
  toolPacks: ToolPack[]
  specs: ToolSpec[]
  definitions: ToolDefinition[]
  specsByName: Map<string, ToolSpec>
  runnersByName: Map<string, ToolHandler>
}

const BUILTIN_TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'read',
      description:
        'Read the full contents of a UTF-8 text file from the local filesystem. Path must be absolute.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    metadata: {
      name: 'read',
      readOnly: true,
      destructive: false,
      requiresApproval: false,
      access: ['read'],
      scope: ['workspace'],
      maxResultBytes: 64 * 1024,
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description:
        'Write (create or overwrite) a UTF-8 text file. Path must be absolute. Returns the number of bytes written.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file.',
          },
          content: {
            type: 'string',
            description: 'Full file contents to write.',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    metadata: {
      name: 'write',
      readOnly: false,
      destructive: true,
      requiresApproval: true,
      access: ['write'],
      scope: ['workspace'],
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description:
        'Edit a UTF-8 text file by replacing an exact occurrence of `oldText` with `newText`. `oldText` must match the file contents byte-for-byte (including whitespace and indentation) and must appear exactly once unless `replaceAll` is true. Path must be absolute.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file.',
          },
          oldText: {
            type: 'string',
            description: 'Exact text to find. Must match byte-for-byte.',
          },
          newText: {
            type: 'string',
            description: 'Replacement text.',
          },
          replaceAll: {
            type: 'boolean',
            description:
              'If true, replace every occurrence. Defaults to false (must match exactly once).',
          },
        },
        required: ['path', 'oldText', 'newText'],
        additionalProperties: false,
      },
    },
    metadata: {
      name: 'edit',
      readOnly: false,
      destructive: true,
      requiresApproval: true,
      access: ['read', 'write'],
      scope: ['workspace'],
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web through the configured host search provider and return ranked results. Use for fresh information, current events, or facts that may have changed since training. Returns an optional `answer` plus a list of `{title, url, content}` snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query.',
          },
          search_depth: {
            type: 'string',
            enum: ['basic', 'advanced'],
            description: '`basic` (default, 1 credit) or `advanced` (better snippets, 2 credits).',
          },
          topic: {
            type: 'string',
            enum: ['general', 'news', 'finance'],
            description: 'Search agent. Default `general`.',
          },
          time_range: {
            type: 'string',
            enum: ['day', 'week', 'month', 'year'],
            description: 'Restrict results to a time window relative to today.',
          },
          max_results: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: 'Max results to return. Default 5.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    metadata: {
      name: 'web_search',
      readOnly: true,
      destructive: false,
      requiresApproval: false,
      access: ['network'],
      scope: ['external'],
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        'Generate an image from a text prompt. The image is saved and shown to the user automatically — DO NOT embed it in your reply (no markdown image syntax). After calling this tool, just briefly describe what you generated. Use this when the user asks to draw, paint, render, or visualize something.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Detailed description of the desired image (subject, style, composition, colors, mood).',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
    metadata: {
      name: 'generate_image',
      readOnly: false,
      destructive: false,
      requiresApproval: false,
      access: ['image'],
      scope: ['image_library'],
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run an approved shell command via /bin/sh with its working directory inside the workspace. Shell commands are not a filesystem sandbox and may access external paths. Returns stdout, stderr, and exit code. 30s timeout.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    metadata: {
      name: 'bash',
      readOnly: false,
      destructive: true,
      requiresApproval: true,
      access: ['shell'],
      scope: ['workspace', 'external'],
      maxResultBytes: 64 * 1024,
    },
  },
]

const BUILTIN_TOOL_HANDLERS: Record<string, ToolHandler> = {
  read: (args, ctx) => runRead(args, ctx),
  write: (args, ctx) => runWrite(args, ctx),
  edit: (args, ctx) => runEdit(args, ctx),
  web_search: (args, ctx) => runWebSearch(args, ctx),
  generate_image: (args, ctx) => runGenerateImage(args, ctx),
  bash: (args, ctx) => runBash(args, ctx),
}

const BUILTIN_TOOL_PACK_DEFINITIONS = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and modify files inside the workspace.',
    toolNames: ['read', 'write', 'edit'],
  },
  {
    id: 'web',
    name: 'Web',
    description: 'Fetch fresh external information.',
    toolNames: ['web_search'],
  },
  {
    id: 'image',
    name: 'Image',
    description: 'Generate and store images in the local image library.',
    toolNames: ['generate_image'],
  },
  {
    id: 'shell',
    name: 'Shell',
    description: 'Run approved shell commands in the workspace.',
    toolNames: ['bash'],
  },
]

function createBuiltinToolPack(
  definition: (typeof BUILTIN_TOOL_PACK_DEFINITIONS)[number],
): ToolPack {
  const tools = definition.toolNames.map((toolName) => {
    const spec = BUILTIN_TOOL_SPECS.find((candidate) => candidate.function.name === toolName)
    const run = BUILTIN_TOOL_HANDLERS[toolName]
    if (!spec || !run) throw new Error(`builtin tool is not registered: ${toolName}`)
    return { spec, run }
  })

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    tools,
  }
}

export const BUILTIN_TOOL_PACKS: ToolPack[] =
  BUILTIN_TOOL_PACK_DEFINITIONS.map(createBuiltinToolPack)

function snapshotToolDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    type: definition.type,
    function: structuredClone(definition.function),
  }
}

function snapshotToolSpec(spec: ToolSpec): ToolSpec {
  return {
    type: spec.type,
    function: structuredClone(spec.function),
    metadata: structuredClone(spec.metadata),
  }
}

function snapshotToolPack(toolPack: ToolPack): ToolPack {
  return {
    ...toolPack,
    tools: toolPack.tools.map((entry) => ({
      spec: snapshotToolSpec(entry.spec),
      run: entry.run,
    })),
  }
}

export function createToolRegistry(
  toolPacks: readonly ToolPack[] = BUILTIN_TOOL_PACKS,
): ToolRegistry {
  const registryToolPacks = toolPacks.map(snapshotToolPack)
  const specs: ToolSpec[] = []
  const definitions: ToolDefinition[] = []
  const specsByName = new Map<string, ToolSpec>()
  const runnersByName = new Map<string, ToolHandler>()

  for (const pack of registryToolPacks) {
    for (const entry of pack.tools) {
      const name = entry.spec.function.name
      if (entry.spec.metadata.name !== name) {
        throw new Error(`tool metadata name mismatch in "${pack.id}": ${entry.spec.metadata.name}`)
      }
      if (specsByName.has(name)) {
        throw new Error(`duplicate tool registered: ${name}`)
      }

      specs.push(entry.spec)
      definitions.push(snapshotToolDefinition(entry.spec))
      specsByName.set(name, entry.spec)
      runnersByName.set(name, entry.run)
    }
  }

  return {
    toolPacks: registryToolPacks,
    specs,
    definitions,
    specsByName,
    runnersByName,
  }
}

export function createDefaultToolRegistry(extraToolPacks: readonly ToolPack[] = []): ToolRegistry {
  return createToolRegistry([...BUILTIN_TOOL_PACKS, ...extraToolPacks])
}

const DEFAULT_TOOL_REGISTRY = createDefaultToolRegistry()

export function getToolDefinitions(
  registry: ToolRegistry = DEFAULT_TOOL_REGISTRY,
): ToolDefinition[] {
  return registry.specs.map(snapshotToolDefinition)
}

const MAX_OUTPUT_BYTES = 64 * 1024
const BASH_TIMEOUT_MS = 30_000
const BASH_MAX_BUFFER_BYTES = MAX_OUTPUT_BYTES * 2
const TOOL_TARGET_PREVIEW_CHARS = 300

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'known_hosts',
  'credentials',
  'credentials.json',
])

const SENSITIVE_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gcp', '.gnupg'])

const SENSITIVE_EXEMPTIONS = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  'id_rsa.pub',
  'id_dsa.pub',
  'id_ecdsa.pub',
  'id_ed25519.pub',
])

const BLOCKED_SHELL_PATTERNS: RegExp[] = [
  /\bsudo\b/,
  /\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/,
  /\bchmod\s+-R\s+777\b/,
  /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh)\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\brsync\b/,
]

function truncate(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) return text
  return `${new TextDecoder().decode(bytes.subarray(0, MAX_OUTPUT_BYTES))}\n…[truncated]`
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function target(kind: ToolActivityTarget['kind'], value: string): ToolActivityTarget {
  return {
    kind,
    preview:
      value.length > TOOL_TARGET_PREVIEW_CHARS
        ? `${value.slice(0, TOOL_TARGET_PREVIEW_CHARS)}...`
        : value,
    size: value.length,
  }
}

export function summarizeToolTarget(
  name: string,
  args: Record<string, unknown>,
): ToolActivityTarget | null {
  if (
    name === 'read' ||
    name === 'write' ||
    name === 'edit' ||
    name === 'read_file' ||
    name === 'write_file' ||
    name === 'edit_file'
  ) {
    const path = stringArg(args, 'path')
    return path ? target('file', path) : null
  }
  if (name === 'bash' || name === 'run_shell') {
    const command = stringArg(args, 'command')
    return command ? target('command', command) : null
  }
  if (name === 'web_search') {
    const query = stringArg(args, 'query')
    return query ? target('query', query) : null
  }
  if (name === 'generate_image') {
    const prompt = stringArg(args, 'prompt')
    return prompt ? target('prompt', prompt) : null
  }
  if (name === 'skill') {
    const skillName = stringArg(args, 'name')
    return skillName ? target('query', skillName) : null
  }
  return null
}

function resolveToolSpec(name: string, registry: ToolRegistry = DEFAULT_TOOL_REGISTRY): ToolSpec {
  const spec = registry.specsByName.get(name)
  if (!spec) throw new Error(`unknown tool: ${name}`)
  return spec
}

function requireToolPath(ctx: ToolContext): ToolPath {
  if (!ctx.path) throw new Error('path host is not available')
  return ctx.path
}

function isInsideRoot(path: string, root: string, pathHost: ToolPath): boolean {
  const rel = pathHost.relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !pathHost.isAbsolute(rel))
}

function normalizeWorkspaceRoots(ctx: ToolContext): string[] {
  const pathHost = requireToolPath(ctx)
  const roots: string[] = []
  for (const root of ctx.workspaceRoots ?? []) {
    const raw = typeof root === 'string' ? root : root.path
    if (raw.trim()) roots.push(pathHost.resolve(raw))
  }
  return Array.from(new Set(roots))
}

function assertNotSensitivePath(
  path: string,
  operation: 'read' | 'write',
  pathHost: ToolPath,
): void {
  const name = pathHost.basename(path)
  if (SENSITIVE_EXEMPTIONS.has(name)) return
  if (SENSITIVE_BASENAMES.has(name) || name.startsWith('.env.')) {
    throw new Error(`${operation} denied for sensitive file: ${name}`)
  }

  const segments = path.split(pathHost.separator)
  for (const segment of segments) {
    if (SENSITIVE_SEGMENTS.has(segment)) {
      throw new Error(`${operation} denied for sensitive path segment: ${segment}`)
    }
  }
}

function resolveWorkspacePath(
  path: unknown,
  operation: 'read' | 'write',
  ctx: ToolContext,
): string {
  const pathHost = requireToolPath(ctx)
  if (typeof path !== 'string') throw new Error('`path` must be a string')
  if (!pathHost.isAbsolute(path)) throw new Error('`path` must be absolute')
  const normalized = pathHost.resolve(path)
  const roots = normalizeWorkspaceRoots(ctx)
  if (roots.length === 0) {
    throw new Error(`${operation} denied: no workspace roots configured`)
  }
  if (!roots.some((root) => isInsideRoot(normalized, root, pathHost))) {
    throw new Error(
      `${operation} denied outside workspace roots: ${normalized} (allowed roots: ${roots.join(
        ', ',
      )})`,
    )
  }
  assertNotSensitivePath(normalized, operation, pathHost)
  return normalized
}

function resolveWorkspaceShellCwd(ctx: ToolContext): string {
  const pathHost = requireToolPath(ctx)
  const roots = normalizeWorkspaceRoots(ctx)
  if (roots.length === 0) {
    throw new Error('shell denied: no workspace roots configured')
  }

  const configuredCwd = ctx.shellCwd
  if (configuredCwd === undefined) {
    throw new Error('shell denied: no workspace working directory configured')
  }
  if (!pathHost.isAbsolute(configuredCwd)) {
    throw new Error('shell denied: `shellCwd` must be absolute')
  }
  const cwd = pathHost.resolve(configuredCwd)
  if (!roots.some((root) => isInsideRoot(cwd, root, pathHost))) {
    throw new Error(
      `shell denied outside workspace roots: ${cwd} (allowed roots: ${roots.join(', ')})`,
    )
  }
  return cwd
}

function assertBashCommandAllowed(command: string): void {
  const trimmed = command.trim()
  if (trimmed.length === 0) throw new Error('`command` must not be empty')
  for (const pattern of BLOCKED_SHELL_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error(`shell command denied by policy: ${pattern.source}`)
    }
  }
}

async function runRead(args: { path?: unknown }, ctx: ToolContext): Promise<string> {
  const path = resolveWorkspacePath(args.path, 'read', ctx)
  if (!ctx.fileSystem) {
    throw new Error('filesystem host is not available')
  }
  const content = await ctx.fileSystem.readTextFile(path)
  return truncate(content)
}

async function runWrite(
  args: { path?: unknown; content?: unknown },
  ctx: ToolContext,
): Promise<string> {
  const path = resolveWorkspacePath(args.path, 'write', ctx)
  const content = args.content
  if (typeof content !== 'string') throw new Error('`content` must be a string')
  if (!ctx.fileSystem) {
    throw new Error('filesystem host is not available')
  }
  await ctx.fileSystem.writeTextFile(path, content)
  return `Wrote ${new TextEncoder().encode(content).byteLength} bytes to ${path}`
}

async function runEdit(
  args: {
    path?: unknown
    oldText?: unknown
    newText?: unknown
    replaceAll?: unknown
  },
  ctx: ToolContext,
): Promise<string> {
  const path = resolveWorkspacePath(args.path, 'write', ctx)
  const oldText = args.oldText
  const newText = args.newText
  const replaceAll = args.replaceAll === true
  if (typeof oldText !== 'string') throw new Error('`oldText` must be a string')
  if (typeof newText !== 'string') throw new Error('`newText` must be a string')
  if (oldText.length === 0) throw new Error('`oldText` must not be empty')

  if (!ctx.fileSystem) {
    throw new Error('filesystem host is not available')
  }
  const original = await ctx.fileSystem.readTextFile(path)

  let occurrences = 0
  let index = original.indexOf(oldText)
  while (index !== -1) {
    occurrences++
    index = original.indexOf(oldText, index + oldText.length)
  }

  if (occurrences === 0) {
    throw new Error('`oldText` not found in file (must match byte-for-byte)')
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `\`oldText\` matches ${occurrences} times; provide more context or set \`replaceAll: true\``,
    )
  }

  const updated = replaceAll
    ? original.split(oldText).join(newText)
    : original.replace(oldText, newText)

  await ctx.fileSystem.writeTextFile(path, updated)
  return `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${path}`
}

export interface ToolWebSearchResultItem {
  title?: string
  url?: string
  content?: string
  source?: string
  publishedAt?: string
}

export interface ToolWebSearchResult {
  answer?: string
  results?: ToolWebSearchResultItem[]
}

export interface ToolWebSearchRequest {
  query: string
  searchDepth: 'basic' | 'advanced'
  topic: 'general' | 'news' | 'finance'
  timeRange?: 'day' | 'week' | 'month' | 'year'
  maxResults: number
  signal?: AbortSignal
}

export type ToolWebSearcher = (request: ToolWebSearchRequest) => Promise<ToolWebSearchResult>

function webSearchStringOption<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof value !== 'string') return fallback
  return allowed.find((candidate) => candidate === value) ?? fallback
}

async function runWebSearch(
  args: {
    query?: unknown
    search_depth?: unknown
    topic?: unknown
    time_range?: unknown
    max_results?: unknown
  },
  ctx: ToolContext,
): Promise<string> {
  const query = args.query
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('`query` must be a non-empty string')
  }
  if (!ctx.webSearch) {
    throw new Error('web search host is not available')
  }

  const maxResults =
    typeof args.max_results === 'number' && Number.isFinite(args.max_results)
      ? Math.max(1, Math.min(10, Math.floor(args.max_results)))
      : 5
  const request: ToolWebSearchRequest = {
    query,
    searchDepth: webSearchStringOption(args.search_depth, ['basic', 'advanced'], 'basic'),
    topic: webSearchStringOption(args.topic, ['general', 'news', 'finance'], 'general'),
    maxResults,
    ...(typeof args.time_range === 'string' &&
      ['day', 'week', 'month', 'year'].includes(args.time_range) && {
        timeRange: args.time_range as 'day' | 'week' | 'month' | 'year',
      }),
    ...(ctx.signal && { signal: ctx.signal }),
  }

  const data = await ctx.webSearch(request)
  const compact = {
    answer: data.answer,
    results: (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      source: r.source,
      publishedAt: r.publishedAt,
    })),
  }
  return truncate(JSON.stringify(compact))
}

// `image` block emitted to the renderer as a side-channel; see agent.ts for
// how this is plumbed onto the assistant message.
export interface ImageSideChannelBlock {
  type: 'image'
  url: string
  mime: string
  prompt: string
}

export interface ImageGenerateRequest {
  prompt: string
  providerId: ProviderId
  modelId: string
  signal?: AbortSignal
}

export interface ImageResult {
  bytes: ArrayBuffer | Uint8Array
  mime: string
}

export type ToolImageGenerator = (
  request: ImageGenerateRequest,
  settings: Settings,
) => Promise<ImageResult>

export type ToolImageSaver = (
  bytes: ArrayBuffer | Uint8Array,
  filename: string,
) => Promise<{ url: string }>

export interface ToolShellRequest {
  command: string
  cwd?: string
  timeoutMs: number
  maxBufferBytes: number
  signal?: AbortSignal
}

export interface ToolShellResult {
  exitCode: number
  stdout?: string
  stderr?: string
}

export type ToolShellRunner = (request: ToolShellRequest) => Promise<ToolShellResult>

export interface ToolFileSystem {
  readTextFile(path: string): Promise<string>
  writeTextFile(path: string, content: string): Promise<void>
}

export interface ToolPath {
  basename(path: string): string
  isAbsolute(path: string): boolean
  relative(from: string, to: string): string
  resolve(path: string): string
  separator: string
}

export interface ToolApprovalRequest {
  name: string
  args: Record<string, unknown>
  metadata: ToolMetadata
  target?: ToolActivityTarget | null
  conversationId?: string
  messageId?: string
  turnId?: string
  runId?: string
  stepId?: string
  toolCallId?: string
}

export type ToolPolicyAction = 'allow' | 'ask' | 'deny'

export interface ToolPolicyDecision {
  action: ToolPolicyAction
  reason?: string
}

export type ToolPolicyRequest = ToolApprovalRequest

export interface ToolAuthorization {
  request: ToolPolicyRequest
  decision: ToolPolicyDecision
}

export type ToolPolicyEvaluator = (
  request: ToolPolicyRequest,
) => ToolPolicyDecision | undefined | Promise<ToolPolicyDecision | undefined>

const TOOL_POLICY_ACTIONS = new Set<ToolPolicyAction>(['allow', 'ask', 'deny'])

function normalizeToolPolicyDecision(
  request: ToolPolicyRequest,
  decision: unknown,
): ToolPolicyDecision {
  if (!decision || typeof decision !== 'object') {
    throw new Error(`invalid tool policy decision for "${request.name}"`)
  }
  const action = (decision as { action?: unknown }).action
  if (typeof action !== 'string' || !TOOL_POLICY_ACTIONS.has(action as ToolPolicyAction)) {
    throw new Error(`invalid tool policy decision for "${request.name}"`)
  }
  const reason = (decision as { reason?: unknown }).reason
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error(`invalid tool policy reason for "${request.name}"`)
  }
  return { action: action as ToolPolicyAction, ...(reason ? { reason } : {}) }
}

function cloneToolPolicyRequest(request: ToolPolicyRequest): ToolPolicyRequest {
  return {
    name: request.name,
    args: structuredClone(request.args),
    metadata: structuredClone(request.metadata),
    ...(request.target ? { target: structuredClone(request.target) } : {}),
    ...(request.conversationId ? { conversationId: request.conversationId } : {}),
    ...(request.messageId ? { messageId: request.messageId } : {}),
    ...(request.turnId ? { turnId: request.turnId } : {}),
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.stepId ? { stepId: request.stepId } : {}),
    ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
  }
}

function cloneToolValue<T>(value: T): T {
  return structuredClone(value)
}

function cloneToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return cloneToolValue(args)
}

function cloneToolContext(ctx: ToolContext): ToolContext {
  return {
    ...ctx,
    settings: cloneToolValue(ctx.settings),
    ...(ctx.workspaceRoots !== undefined && {
      workspaceRoots: cloneToolValue(ctx.workspaceRoots),
    }),
  }
}

export type ToolWorkspaceRoot = string | { path: string; label?: string }

export interface ToolContext {
  settings: Settings
  conversationId?: string
  messageId?: string
  turnId?: string
  runId?: string
  stepId?: string
  toolCallId?: string
  workspaceRoots?: readonly ToolWorkspaceRoot[]
  shellCwd?: string
  signal?: AbortSignal
  onToolPolicy?: ToolPolicyEvaluator
  onToolApproval?: (request: ToolApprovalRequest) => Promise<boolean>
  webSearch?: ToolWebSearcher
  generateImage?: ToolImageGenerator
  saveImage?: ToolImageSaver
  runShell?: ToolShellRunner
  fileSystem?: ToolFileSystem
  path?: ToolPath
  onImage?: (block: ImageSideChannelBlock) => void
}

async function runGenerateImage(args: { prompt?: unknown }, ctx: ToolContext): Promise<string> {
  const prompt = args.prompt
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('`prompt` must be a non-empty string')
  }
  const selection = ctx.settings.defaultImageModel
  if (!selection) {
    throw new Error(
      'No default image model configured. Open Settings and pick one under "Default Image Model".',
    )
  }

  if (!ctx.generateImage) {
    throw new Error('image generation host is not available')
  }
  if (!ctx.saveImage) {
    throw new Error('image storage host is not available')
  }

  const { bytes, mime } = await ctx.generateImage(
    {
      providerId: selection.providerId,
      modelId: selection.modelId,
      prompt,
      signal: ctx.signal,
    },
    ctx.settings,
  )

  const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png'
  const { url } = await ctx.saveImage(bytes, `image${ext}`)
  ctx.onImage?.({ type: 'image', url, mime, prompt })

  return JSON.stringify({
    ok: true,
    note: 'Image generated and shown to user. Do NOT embed it in your reply.',
    model: `${selection.providerId}:${selection.modelId}`,
  })
}

async function runBash(args: { command?: unknown }, ctx: ToolContext): Promise<string> {
  const command = args.command
  if (typeof command !== 'string') throw new Error('`command` must be a string')
  assertBashCommandAllowed(command)
  if (!ctx.runShell) {
    throw new Error('shell host is not available')
  }
  const cwd = resolveWorkspaceShellCwd(ctx)

  const result = await ctx.runShell({
    command,
    cwd,
    timeoutMs: BASH_TIMEOUT_MS,
    maxBufferBytes: BASH_MAX_BUFFER_BYTES,
    ...(ctx.signal && { signal: ctx.signal }),
  })

  return JSON.stringify({
    exit_code: result.exitCode,
    stdout: truncate(result.stdout ?? ''),
    stderr: truncate(result.stderr ?? ''),
  })
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  registry: ToolRegistry = DEFAULT_TOOL_REGISTRY,
): Promise<string> {
  const { decision, request } = await authorizeTool(name, args, ctx, registry)
  if (decision.action === 'deny') {
    throw new Error(decision.reason ?? `tool "${name}" was denied by policy`)
  }
  if (decision.action === 'ask') {
    if (!ctx.onToolApproval) {
      throw new Error(`tool "${name}" requires approval but no approval host is available`)
    }
    const approved = await ctx.onToolApproval(cloneToolPolicyRequest(request))
    if (approved !== true) throw new Error(`tool "${name}" was rejected by user`)
  }
  return executeAuthorizedTool(name, args, ctx, registry)
}

/** Evaluate policy without executing a tool or waiting for user approval. */
export async function authorizeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  registry: ToolRegistry = DEFAULT_TOOL_REGISTRY,
): Promise<ToolAuthorization> {
  const spec = resolveToolSpec(name, registry)
  const toolArgs = cloneToolArgs(args)
  const toolContext = cloneToolContext(ctx)
  const request: ToolPolicyRequest = {
    name,
    args: cloneToolArgs(toolArgs),
    metadata: cloneToolValue(spec.metadata),
    target: summarizeToolTarget(name, toolArgs),
    ...(ctx.conversationId && { conversationId: ctx.conversationId }),
    ...(ctx.messageId && { messageId: ctx.messageId }),
    ...(ctx.turnId && { turnId: ctx.turnId }),
    ...(ctx.runId && { runId: ctx.runId }),
    ...(ctx.stepId && { stepId: ctx.stepId }),
    ...(ctx.toolCallId && { toolCallId: ctx.toolCallId }),
  }
  const decision = await evaluateToolPolicy(request, toolContext)
  return {
    request: cloneToolPolicyRequest(request),
    decision: cloneToolValue(decision),
  }
}

/** Execute a tool after the runtime has resolved policy and approval. */
export async function executeAuthorizedTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  registry: ToolRegistry = DEFAULT_TOOL_REGISTRY,
): Promise<string> {
  resolveToolSpec(name, registry)
  const toolArgs = cloneToolArgs(args)
  const toolContext = cloneToolContext(ctx)
  const runner = registry.runnersByName.get(name)
  if (!runner) throw new Error(`unknown tool: ${name}`)
  return runner(cloneToolArgs(toolArgs), toolContext)
}

export async function evaluateToolPolicy(
  request: ToolPolicyRequest,
  ctx: Pick<ToolContext, 'onToolPolicy' | 'onToolApproval'>,
): Promise<ToolPolicyDecision> {
  const requiresApproval = request.metadata.requiresApproval
  const decision = await ctx.onToolPolicy?.(cloneToolPolicyRequest(request))
  if (decision !== undefined) return normalizeToolPolicyDecision(request, decision)
  if (requiresApproval) return { action: 'ask' }
  return { action: 'allow' }
}
