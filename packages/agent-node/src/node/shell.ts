import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolShellRequest, ToolShellResult } from '@aila/agent'

const execAsync = promisify(exec)

export async function runNodeShell(request: ToolShellRequest): Promise<ToolShellResult> {
  try {
    const { stdout, stderr } = await execAsync(request.command, {
      cwd: request.cwd ?? process.cwd(),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: request.timeoutMs,
      maxBuffer: request.maxBufferBytes,
      signal: request.signal,
    })
    return { exitCode: 0, stdout, stderr }
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string }
    return {
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? 'command failed',
    }
  }
}
