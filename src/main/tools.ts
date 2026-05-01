/**
 * Tool definitions and local executor for the agent loop.
 *
 * Tools are passed to OpenRouter using the OpenAI-compatible function-calling
 * schema. When the model emits a tool_call, the agent loop invokes the matching
 * handler here and feeds the result back as a `role: "tool"` message.
 */

import { exec } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
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
  },
]

const MAX_OUTPUT_BYTES = 64 * 1024
const BASH_TIMEOUT_MS = 30_000

function truncate(text: string): string {
  if (Buffer.byteLength(text, 'utf-8') <= MAX_OUTPUT_BYTES) return text
  const buf = Buffer.from(text, 'utf-8').subarray(0, MAX_OUTPUT_BYTES)
  return `${buf.toString('utf-8')}\n…[truncated]`
}

async function runRead(args: { path?: unknown }): Promise<string> {
  const path = args.path
  if (typeof path !== 'string') throw new Error('`path` must be a string')
  if (!isAbsolute(path)) throw new Error('`path` must be absolute')
  const content = await readFile(path, 'utf-8')
  return truncate(content)
}

async function runWrite(args: { path?: unknown; content?: unknown }): Promise<string> {
  const path = args.path
  const content = args.content
  if (typeof path !== 'string') throw new Error('`path` must be a string')
  if (!isAbsolute(path)) throw new Error('`path` must be absolute')
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
  const path = args.path
  const oldText = args.oldText
  const newText = args.newText
  const replaceAll = args.replaceAll === true
  if (typeof path !== 'string') throw new Error('`path` must be a string')
  if (!isAbsolute(path)) throw new Error('`path` must be absolute')
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

async function runBash(args: { command?: unknown }): Promise<string> {
  const command = args.command
  if (typeof command !== 'string') throw new Error('`command` must be a string')

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
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

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'read':
      return runRead(args)
    case 'write':
      return runWrite(args)
    case 'edit':
      return runEdit(args)
    case 'web_search':
      return runWebSearch(args)
    case 'bash':
      return runBash(args)
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}
