import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { RotateCcwIcon, TerminalIcon, XIcon } from 'lucide-react'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationWorkspaceRef, TerminalSessionCreated } from '@/types'

interface WorkspaceTerminalPanelProps {
  workspace: ConversationWorkspaceRef
  onClose: () => void
}

type TerminalStatus = 'starting' | 'running' | 'exited' | 'error'

function workspaceLabel(workspace: ConversationWorkspaceRef): string {
  return workspace.label?.trim() || workspace.path || workspace.id
}

function statusLabel(status: TerminalStatus): string {
  if (status === 'starting') return 'Starting'
  if (status === 'running') return 'Running'
  if (status === 'exited') return 'Exited'
  return 'Error'
}

function terminalTheme(dark: boolean) {
  return dark
    ? {
        background: '#14171c',
        foreground: '#d7dbe3',
        cursor: '#86aaf4',
        selectionBackground: '#33415a',
        black: '#171a20',
        brightBlack: '#727b8b',
        red: '#e9827d',
        brightRed: '#f29a95',
        green: '#6bc395',
        brightGreen: '#8bd4ac',
        yellow: '#d9b36a',
        brightYellow: '#e6c582',
        blue: '#7da1ed',
        brightBlue: '#9bb8f3',
        magenta: '#b49ad0',
        brightMagenta: '#c7b1dc',
        cyan: '#71b7bd',
        brightCyan: '#90c9ce',
        white: '#cfd4dd',
        brightWhite: '#eef0f4',
      }
    : {
        background: '#f1f3f6',
        foreground: '#292e38',
        cursor: '#2864dc',
        selectionBackground: '#cedaf1',
        black: '#292e38',
        brightBlack: '#737b89',
        red: '#b74d50',
        brightRed: '#ca686a',
        green: '#44795d',
        brightGreen: '#5e9274',
        yellow: '#8b6b31',
        brightYellow: '#a27f43',
        blue: '#4d6f9f',
        brightBlue: '#6688b7',
        magenta: '#7b648e',
        brightMagenta: '#9279a5',
        cyan: '#477a7e',
        brightCyan: '#609196',
        white: '#d6d9df',
        brightWhite: '#f9fafb',
      }
}

export function WorkspaceTerminalPanel({
  workspace,
  onClose,
}: WorkspaceTerminalPanelProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('starting')
  const [session, setSession] = useState<TerminalSessionCreated | null>(null)
  const [restartKey, setRestartKey] = useState(0)
  const label = workspaceLabel(workspace)

  const restart = useCallback(() => {
    setRestartKey((current) => current + 1)
  }, [])

  useEffect(() => {
    void restartKey
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let receivedFirstData = false
    setStatus('starting')
    setSession(null)
    const darkMode = window.matchMedia('(prefers-color-scheme: dark)')

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: terminalTheme(darkMode.matches),
    })
    const onThemeChange = (event: MediaQueryListEvent): void => {
      terminal.options.theme = terminalTheme(event.matches)
    }
    darkMode.addEventListener('change', onThemeChange)
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminal.writeln('Starting shell...')

    const resizeToContainer = (): void => {
      try {
        fitAddon.fit()
        const id = sessionIdRef.current
        if (id) void window.api.terminal.resize(id, terminal.cols, terminal.rows)
      } catch (error) {
        console.warn('[terminal] resize failed:', error)
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(resizeToContainer)
    })
    resizeObserver.observe(container)

    const inputDisposable = terminal.onData((data) => {
      const id = sessionIdRef.current
      if (id) window.api.terminal.write(id, data)
    })
    const stopData = window.api.terminal.onData((event) => {
      if (event.id !== sessionIdRef.current) return
      if (!receivedFirstData) {
        receivedFirstData = true
        setStatus('running')
        terminal.clear()
      }
      terminal.write(event.data)
    })
    const stopExit = window.api.terminal.onExit((event) => {
      if (event.id !== sessionIdRef.current) return
      sessionIdRef.current = null
      setStatus('exited')
      terminal.writeln('')
      terminal.writeln(`[process exited with code ${event.exitCode}]`)
    })

    window.requestAnimationFrame(() => {
      resizeToContainer()
      void window.api.terminal
        .create({ cwd: workspace.path, cols: terminal.cols, rows: terminal.rows })
        .then((created) => {
          if (disposed) {
            void window.api.terminal.close(created.id)
            return
          }
          sessionIdRef.current = created.id
          setSession(created)
          terminal.focus()
          resizeToContainer()
        })
        .catch((error) => {
          if (disposed) return
          const message = error instanceof Error ? error.message : String(error)
          setStatus('error')
          terminal.writeln(`Failed to start terminal: ${message}`)
        })
    })

    return () => {
      disposed = true
      resizeObserver.disconnect()
      darkMode.removeEventListener('change', onThemeChange)
      inputDisposable.dispose()
      stopData()
      stopExit()
      const id = sessionIdRef.current
      sessionIdRef.current = null
      if (id) void window.api.terminal.close(id)
      terminal.dispose()
    }
  }, [workspace.path, restartKey])

  return (
    <section className="flex h-[min(34vh,340px)] min-h-[220px] shrink-0 flex-col border-t border-[var(--border)] bg-[var(--surface)] text-[var(--text)]">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 text-[12px]">
        <TerminalIcon className="size-3.5 shrink-0 text-[var(--text-dim)]" />
        <span className="font-medium text-[var(--text)]">Terminal</span>
        <span className="min-w-0 flex-1 truncate text-[var(--text-dim)]" title={workspace.path}>
          {label}
        </span>
        <span className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--text-soft)]">
          {statusLabel(status)}
        </span>
        {session && (
          <span className="hidden shrink-0 text-[10px] text-[var(--text-dim)] sm:inline">
            pid {session.pid}
          </span>
        )}
        <button
          type="button"
          onClick={restart}
          aria-label="Restart terminal"
          title="Restart terminal"
          className="grid size-6 shrink-0 place-items-center rounded-md text-[var(--text-dim)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <RotateCcwIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close terminal"
          title="Close terminal"
          className="grid size-6 shrink-0 place-items-center rounded-md text-[var(--text-dim)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <XIcon className="size-3.5" />
        </button>
      </header>
      <div
        ref={containerRef}
        className="aila-terminal min-h-0 flex-1 overflow-hidden bg-[var(--terminal-bg)] px-2 py-2"
      />
    </section>
  )
}
