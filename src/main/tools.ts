/**
 * Tool definitions and local executor for the agent loop.
 *
 * Tools are passed to OpenRouter using the OpenAI-compatible function-calling
 * schema. When the model emits a tool_call, the agent loop invokes the matching
 * handler here and feeds the result back as a `role: "tool"` message.
 */

import { exec } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { AgentProfileId } from './agent-profile'
import type { FindReplaceEdit } from './find-replace'
import { generateImage } from './image'
import { saveImage } from './images'
import type { Settings } from './settings'

const execAsync = promisify(exec)

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

type ToolAccess = 'read' | 'write' | 'shell' | 'network' | 'image' | 'doc'
type ToolScope = 'workspace' | 'current_doc' | 'external' | 'image_library'

export interface ToolMetadata {
  name: string
  readOnly: boolean
  destructive: boolean
  requiresApproval: boolean
  access: ToolAccess[]
  scope: ToolScope[]
  allowedProfiles: AgentProfileId[]
  maxResultBytes?: number
}

export interface ToolSpec extends ToolDefinition {
  metadata: ToolMetadata
}

export const TOOL_SPECS: ToolSpec[] = [
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
      allowedProfiles: ['coding', 'research'],
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
      allowedProfiles: ['coding'],
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
      allowedProfiles: ['coding'],
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web via Tavily and return ranked results. Use for fresh information, current events, or facts that may have changed since training. Returns an optional LLM-written `answer` plus a list of `{title, url, content}` snippets.',
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
      allowedProfiles: ['chat', 'doc', 'coding', 'research'],
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
      allowedProfiles: ['chat', 'doc'],
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command via /bin/sh in the app working directory. Returns stdout, stderr, and exit code. 30s timeout.',
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
      allowedProfiles: ['coding'],
      maxResultBytes: 64 * 1024,
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_doc',
      description:
        "Edit a markdown document by find-and-replace. Each edit's `old_string` " +
        'must appear EXACTLY ONCE in the doc body — include enough surrounding ' +
        'context to be unique. All edits in one call apply atomically (a single ' +
        'undo step in the editor). If any edit fails, NONE are applied and you ' +
        'will receive an error with details to retry. Use this to refine, ' +
        "restructure, or extend a doc the user is working on. The target doc's " +
        'path is given in the system message of doc-bound conversations.',
      parameters: {
        type: 'object',
        properties: {
          docPath: {
            type: 'string',
            description:
              'Target document path (vault-relative, no .md extension). In ' +
              'doc-bound conversations, default to the path mentioned in the ' +
              'system message.',
          },
          edits: {
            type: 'array',
            minItems: 1,
            description: 'Ordered list of find-and-replace edits to apply atomically.',
            items: {
              type: 'object',
              properties: {
                old_string: {
                  type: 'string',
                  description:
                    'Exact text to find. Must match byte-for-byte (including whitespace) ' +
                    'and occur exactly once in the doc body.',
                },
                new_string: {
                  type: 'string',
                  description: 'Replacement text.',
                },
              },
              required: ['old_string', 'new_string'],
              additionalProperties: false,
            },
          },
          reason: {
            type: 'string',
            description: 'One short line explaining why these edits.',
          },
        },
        required: ['docPath', 'edits'],
        additionalProperties: false,
      },
    },
    metadata: {
      name: 'edit_doc',
      readOnly: false,
      destructive: true,
      requiresApproval: false,
      access: ['doc'],
      scope: ['current_doc'],
      allowedProfiles: ['doc'],
    },
  },
]

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOL_SPECS.map(({ type, function: fn }) => ({
  type,
  function: fn,
}))

const TOOL_SPECS_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.function.name, spec]))

export function getToolDefinitionsForProfile(profileId: AgentProfileId): ToolDefinition[] {
  return TOOL_SPECS.filter((spec) => spec.metadata.allowedProfiles.includes(profileId)).map(
    ({ type, function: fn }) => ({ type, function: fn }),
  )
}

const MAX_OUTPUT_BYTES = 64 * 1024
const BASH_TIMEOUT_MS = 30_000
const WORKSPACE_ROOT = resolve(process.cwd())

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
  if (Buffer.byteLength(text, 'utf-8') <= MAX_OUTPUT_BYTES) return text
  const buf = Buffer.from(text, 'utf-8').subarray(0, MAX_OUTPUT_BYTES)
  return `${buf.toString('utf-8')}\n…[truncated]`
}

function assertToolAllowed(name: string, profileId: AgentProfileId): ToolSpec {
  const spec = TOOL_SPECS_BY_NAME.get(name)
  if (!spec) throw new Error(`unknown tool: ${name}`)
  if (!spec.metadata.allowedProfiles.includes(profileId)) {
    throw new Error(`tool "${name}" is not available in the ${profileId} agent profile`)
  }
  return spec
}

function isInsideWorkspace(path: string): boolean {
  const rel = relative(WORKSPACE_ROOT, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function assertNotSensitivePath(path: string, operation: 'read' | 'write'): void {
  const name = basename(path)
  if (SENSITIVE_EXEMPTIONS.has(name)) return
  if (SENSITIVE_BASENAMES.has(name) || name.startsWith('.env.')) {
    throw new Error(`${operation} denied for sensitive file: ${name}`)
  }

  const segments = path.split(sep)
  for (const segment of segments) {
    if (SENSITIVE_SEGMENTS.has(segment)) {
      throw new Error(`${operation} denied for sensitive path segment: ${segment}`)
    }
  }
}

function resolveWorkspacePath(path: unknown, operation: 'read' | 'write'): string {
  if (typeof path !== 'string') throw new Error('`path` must be a string')
  if (!isAbsolute(path)) throw new Error('`path` must be absolute')
  const normalized = resolve(path)
  if (!isInsideWorkspace(normalized)) {
    throw new Error(`${operation} denied outside workspace: ${normalized}`)
  }
  assertNotSensitivePath(normalized, operation)
  return normalized
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

async function runRead(args: { path?: unknown }): Promise<string> {
  const path = resolveWorkspacePath(args.path, 'read')
  const content = await readFile(path, 'utf-8')
  return truncate(content)
}

async function runWrite(args: { path?: unknown; content?: unknown }): Promise<string> {
  const path = resolveWorkspacePath(args.path, 'write')
  const content = args.content
  if (typeof content !== 'string') throw new Error('`content` must be a string')
  await writeFile(path, content, 'utf-8')
  return `Wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${path}`
}

async function runEdit(args: {
  path?: unknown
  oldText?: unknown
  newText?: unknown
  replaceAll?: unknown
}): Promise<string> {
  const path = resolveWorkspacePath(args.path, 'write')
  const oldText = args.oldText
  const newText = args.newText
  const replaceAll = args.replaceAll === true
  if (typeof oldText !== 'string') throw new Error('`oldText` must be a string')
  if (typeof newText !== 'string') throw new Error('`newText` must be a string')
  if (oldText.length === 0) throw new Error('`oldText` must not be empty')

  const original = await readFile(path, 'utf-8')

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

  await writeFile(path, updated, 'utf-8')
  return `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${path}`
}

interface TavilyResult {
  title?: string
  url?: string
  content?: string
}

interface TavilyResponse {
  answer?: string
  results?: TavilyResult[]
}

async function runWebSearch(args: {
  query?: unknown
  search_depth?: unknown
  topic?: unknown
  time_range?: unknown
  max_results?: unknown
}): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not set. Add it to .env and restart the app.')
  }

  const query = args.query
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('`query` must be a non-empty string')
  }

  const body: Record<string, unknown> = {
    query,
    search_depth: args.search_depth ?? 'basic',
    topic: args.topic ?? 'general',
    max_results: typeof args.max_results === 'number' ? args.max_results : 5,
    include_answer: true,
  }
  if (typeof args.time_range === 'string') body.time_range = args.time_range

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Tavily ${response.status}: ${text || response.statusText}`)
  }

  const data = (await response.json()) as TavilyResponse
  const compact = {
    answer: data.answer,
    results: (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
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

export interface DocEditRequest {
  docPath: string
  edits: FindReplaceEdit[]
  reason?: string
}

export type DocEditResult =
  | { ok: true; title: string; appliedCount: number }
  | { ok: false; error: string }

export interface ToolContext {
  settings: Settings
  profileId: AgentProfileId
  boundDocPath?: string
  signal?: AbortSignal
  onImage?: (block: ImageSideChannelBlock) => void
  // Round-trips through the renderer (active doc → CodeMirror transaction)
  // or main's disk path (inactive doc). Resolves with success or a structured
  // error the model can use to retry. Wired in src/main/index.ts.
  onDocEdit?: (req: DocEditRequest) => Promise<DocEditResult>
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

  const { bytes, mime } = await generateImage(
    {
      providerId: selection.providerId,
      modelId: selection.modelId,
      prompt,
      signal: ctx.signal,
    },
    ctx.settings,
  )

  const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png'
  const { url } = await saveImage(bytes, `image${ext}`)
  ctx.onImage?.({ type: 'image', url, mime, prompt })

  return JSON.stringify({
    ok: true,
    note: 'Image generated and shown to user. Do NOT embed it in your reply.',
    model: `${selection.providerId}:${selection.modelId}`,
  })
}

async function runEditDoc(
  args: { docPath?: unknown; edits?: unknown; reason?: unknown },
  ctx: ToolContext,
): Promise<string> {
  const { docPath, edits, reason } = args
  if (typeof docPath !== 'string' || docPath.length === 0) {
    throw new Error('`docPath` must be a non-empty string')
  }
  if (ctx.boundDocPath && docPath !== ctx.boundDocPath) {
    throw new Error(`document editing is only available for the active doc: ${ctx.boundDocPath}`)
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('`edits` must be a non-empty array')
  }
  const validatedEdits: FindReplaceEdit[] = edits.map((edit, i) => {
    if (!edit || typeof edit !== 'object') {
      throw new Error(`edit #${i} must be an object`)
    }
    const e = edit as { old_string?: unknown; new_string?: unknown }
    if (typeof e.old_string !== 'string' || e.old_string.length === 0) {
      throw new Error(`edit #${i}: \`old_string\` must be a non-empty string`)
    }
    if (typeof e.new_string !== 'string') {
      throw new Error(`edit #${i}: \`new_string\` must be a string`)
    }
    return { old_string: e.old_string, new_string: e.new_string }
  })

  if (!ctx.onDocEdit) {
    throw new Error('document editing is not available in this context')
  }

  const result = await ctx.onDocEdit({
    docPath,
    edits: validatedEdits,
    reason: typeof reason === 'string' ? reason : undefined,
  })

  if (!result.ok) throw new Error(result.error)

  const word = result.appliedCount === 1 ? 'edit' : 'edits'
  return `Applied ${result.appliedCount} ${word} to "${result.title}"`
}

async function runBash(args: { command?: unknown }): Promise<string> {
  const command = args.command
  if (typeof command !== 'string') throw new Error('`command` must be a string')
  assertBashCommandAllowed(command)

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
    })
    return JSON.stringify({
      exit_code: 0,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
    })
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string }
    return JSON.stringify({
      exit_code: typeof err.code === 'number' ? err.code : 1,
      stdout: truncate(err.stdout ?? ''),
      stderr: truncate(err.stderr ?? err.message ?? 'command failed'),
    })
  }
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  assertToolAllowed(name, ctx.profileId)
  switch (name) {
    case 'read':
      return runRead(args)
    case 'write':
      return runWrite(args)
    case 'edit':
      return runEdit(args)
    case 'web_search':
      return runWebSearch(args)
    case 'generate_image':
      return runGenerateImage(args, ctx)
    case 'bash':
      return runBash(args)
    case 'edit_doc':
      return runEditDoc(args, ctx)
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}
