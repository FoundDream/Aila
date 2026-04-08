import { spawn } from 'node:child_process'
import { type Static, Type } from '@sinclair/typebox'
import type { Tool, ToolExecContext, ToolExecResult } from '../../agent-core/types'

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
const MAX_TIMEOUT_MS = 10 * 60 * 1000
const MAX_OUTPUT_BYTES = 30_000

const schema = Type.Object({
  command: Type.String({
    description: 'The shell command to execute. Runs via /bin/bash -lc.',
  }),
  description: Type.Optional(
    Type.String({
      description:
        'One-line human-readable description of what the command does. Shown in the UI only, not passed to the shell.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        'Timeout in milliseconds before the command is killed. Default 120000, max 600000.',
    }),
  ),
})

type Params = Static<typeof schema>

interface BashResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  output: string
  truncated: boolean
  timedOut: boolean
  aborted: boolean
}

async function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BashResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    const chunks: Buffer[] = []
    let totalBytes = 0
    let truncated = false
    let timedOut = false
    let aborted = false

    const appendChunk = (chunk: Buffer) => {
      if (truncated) return
      const remaining = MAX_OUTPUT_BYTES - totalBytes
      if (remaining <= 0) {
        truncated = true
        return
      }
      if (chunk.length <= remaining) {
        chunks.push(chunk)
        totalBytes += chunk.length
      } else {
        chunks.push(chunk.subarray(0, remaining))
        totalBytes += remaining
        truncated = true
      }
    }

    child.stdout.on('data', (data: Buffer) => appendChunk(data))
    child.stderr.on('data', (data: Buffer) => appendChunk(data))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 2000)
    }, timeoutMs)

    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 2000)
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (err) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({
        exitCode: null,
        signal: null,
        output: `bash: failed to spawn: ${err.message}`,
        truncated: false,
        timedOut,
        aborted,
      })
    })

    child.on('close', (code, sig) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({
        exitCode: code,
        signal: sig,
        output: Buffer.concat(chunks).toString('utf8'),
        truncated,
        timedOut,
        aborted,
      })
    })
  })
}

function formatResult(params: Params, result: BashResult): ToolExecResult {
  const lines: string[] = []

  if (params.description) {
    lines.push(`$ ${params.description}`)
  }
  lines.push(`$ ${params.command}`)

  if (result.output) {
    lines.push(result.output.trimEnd())
  }

  if (result.truncated) {
    lines.push(`[output truncated at ${MAX_OUTPUT_BYTES} bytes]`)
  }

  if (result.aborted) {
    lines.push('[command aborted by user]')
  } else if (result.timedOut) {
    lines.push('[command timed out]')
  }

  if (!result.aborted && result.exitCode !== null && result.exitCode !== 0) {
    lines.push(`[exit code ${result.exitCode}]`)
  } else if (result.signal) {
    lines.push(`[terminated by ${result.signal}]`)
  }

  const isError =
    result.aborted ||
    result.timedOut ||
    (result.exitCode !== null && result.exitCode !== 0) ||
    result.signal !== null

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError,
    details: {
      command: params.command,
      exitCode: result.exitCode,
      signal: result.signal,
      truncated: result.truncated,
      timedOut: result.timedOut,
      aborted: result.aborted,
    },
  }
}

export function createBashTool(cwd: string): Tool<typeof schema> {
  return {
    name: 'bash',
    label: 'Bash',
    description:
      'Run a shell command in the current working directory via /bin/bash -lc and return its combined stdout/stderr. Non-zero exit codes return an error result.',
    parameters: schema,
    promptSnippet:
      'Run shell commands when you need to inspect the environment, install packages, run tests, or perform file operations outside the built-in read/write tools.',
    promptGuidelines: [
      'Prefer the dedicated read/edit/write tools over shell invocations like cat/sed/echo for file manipulation',
      'Keep commands fast; the default timeout is 2 minutes and the hard cap is 10 minutes',
      'Use relative paths to the current working directory or absolute paths',
      'Do not rely on an interactive shell; commands run with -lc and no TTY',
    ],
    async execute(params: Params, ctx: ToolExecContext) {
      const timeoutMs = Math.min(
        Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1),
        MAX_TIMEOUT_MS,
      )
      const result = await runBash(params.command, cwd, timeoutMs, ctx.signal)
      return formatResult(params, result)
    },
  }
}
