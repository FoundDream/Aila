import { randomUUID } from 'node:crypto'
import { chmod, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { IpcMain } from 'electron'
import * as pty from 'node-pty'

export interface TerminalCreateRequest {
  cwd?: string | null
  cols?: number
  rows?: number
}

export interface TerminalSessionCreated {
  id: string
  cwd: string
  shell: string
  pid: number
}

export interface TerminalWriteRequest {
  id: string
  data: string
}

export interface TerminalResizeRequest {
  id: string
  cols: number
  rows: number
}

export interface TerminalDataEvent {
  id: string
  data: string
}

export interface TerminalExitEvent {
  id: string
  exitCode: number
  signal?: number
}

type TerminalEmitter = (channel: string, data?: unknown) => void
const require = createRequire(import.meta.url)

export interface TerminalSessionManager {
  create(request: TerminalCreateRequest): Promise<TerminalSessionCreated>
  write(request: TerminalWriteRequest): void
  resize(request: TerminalResizeRequest): void
  close(id: string): void
  shutdown(): void
}

interface ShellCommand {
  file: string
  args: string[]
}

export function createTerminalSessionManager(emit: TerminalEmitter): TerminalSessionManager {
  const sessions = new Map<string, pty.IPty>()

  return {
    async create(request) {
      const cwd = await resolveTerminalDirectory(request.cwd)
      await ensureNodePtyHelperExecutable()
      const shell = getDefaultShell()
      const cols = terminalDimension(request.cols, 80, 20, 500)
      const rows = terminalDimension(request.rows, 24, 5, 200)
      const term = pty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: terminalEnv(),
      })
      const id = randomUUID()

      sessions.set(id, term)
      term.onData((data) => emit('terminal:data', { id, data } satisfies TerminalDataEvent))
      term.onExit(({ exitCode, signal }) => {
        sessions.delete(id)
        emit('terminal:exit', {
          id,
          exitCode,
          ...(typeof signal === 'number' ? { signal } : {}),
        } satisfies TerminalExitEvent)
      })

      return {
        id,
        cwd,
        shell: [shell.file, ...shell.args].join(' '),
        pid: term.pid,
      }
    },
    write(request) {
      const term = sessions.get(request.id)
      if (!term) return
      term.write(request.data)
    },
    resize(request) {
      const term = sessions.get(request.id)
      if (!term) return
      const cols = terminalDimension(request.cols, 80, 20, 500)
      const rows = terminalDimension(request.rows, 24, 5, 200)
      term.resize(cols, rows)
    },
    close(id) {
      const term = sessions.get(id)
      if (!term) return
      sessions.delete(id)
      term.kill()
    },
    shutdown() {
      for (const [id, term] of sessions) {
        sessions.delete(id)
        term.kill()
      }
    },
  }
}

export function registerTerminalIpcHandlers(
  ipc: Pick<IpcMain, 'handle' | 'on'>,
  manager: TerminalSessionManager,
): void {
  ipc.handle('terminal:create', (_event, request: TerminalCreateRequest) => manager.create(request))
  ipc.on('terminal:write', (_event, request: TerminalWriteRequest) => {
    manager.write(request)
  })
  ipc.handle('terminal:resize', (_event, request: TerminalResizeRequest) => {
    manager.resize(request)
  })
  ipc.handle('terminal:close', (_event, id: string) => {
    manager.close(id)
  })
}

async function resolveTerminalDirectory(directory?: string | null): Promise<string> {
  const cwd = resolve(directory?.trim() || homedir())
  const info = await stat(cwd)
  if (!info.isDirectory()) {
    throw new Error(`Terminal path is not a directory: ${cwd}`)
  }
  return cwd
}

async function ensureNodePtyHelperExecutable(): Promise<void> {
  if (process.platform === 'win32') return

  try {
    const packageRoot = dirname(require.resolve('node-pty/package.json'))
    const helperPath = join(
      packageRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    )
    await chmod(helperPath, 0o755)
  } catch {
    // node-pty will surface a useful spawn error if the helper is still unavailable.
  }
}

function getDefaultShell(): ShellCommand {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: [] }
  }

  return {
    file: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
    args: [],
  }
}

function terminalDimension(value: number | undefined, fallback: number, min: number, max: number) {
  const normalized = Math.floor(Number(value))
  if (!Number.isFinite(normalized)) return fallback
  return Math.min(max, Math.max(min, normalized))
}

function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}
