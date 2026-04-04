import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

interface SessionSummary {
  path: string
  id: string
  name?: string
  modified: string
  messageCount: number
  firstMessage: string
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString)
  const now = Date.now()
  const diffMs = now - date.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString()
}

export function SessionList({
  onResume,
  onDelete,
  currentSessionPath,
  variant = 'dropdown',
  onNewSession,
  onSettingsClick,
}: {
  onResume: (sessionPath: string) => void | Promise<void>
  onDelete: (sessionPath: string) => void | Promise<void>
  currentSessionPath: string | null
  variant?: 'dropdown' | 'panel'
  onNewSession?: () => void | Promise<void>
  onSettingsClick?: () => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.listSessions()
      setSessions(list)
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (variant === 'panel' || open) void loadSessions()
  }, [currentSessionPath, open, loadSessions, variant])

  // Close on outside click
  useEffect(() => {
    if (!open || variant !== 'dropdown') return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, variant])

  const listContent = (
    <>
      {loading && <div className="px-3 py-4 text-center text-[11px] text-[#666]">Loading...</div>}

      {!loading && sessions.length === 0 && (
        <div className="px-3 py-4 text-center text-[11px] text-[#666]">No sessions yet</div>
      )}

      {!loading &&
        sessions.map((s) => {
          const isCurrent = s.path === currentSessionPath
          return (
            <div
              key={s.id}
              className={`group flex items-center gap-1 transition ${
                isCurrent ? 'bg-[#162218]' : 'hover:bg-[#1a1a1a]'
              }`}
            >
              <button
                type="button"
                disabled={isCurrent}
                onClick={() => {
                  void onResume(s.path)
                  if (variant === 'dropdown') {
                    setOpen(false)
                  }
                }}
                className={`flex min-w-0 flex-1 flex-col gap-1 px-3 py-3 text-left ${
                  isCurrent ? 'text-[#4af626]' : 'text-[#ccc]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-medium">
                    {s.name || s.firstMessage || `Session ${s.id}`}
                  </span>
                  <span className="shrink-0 text-[10px] text-[#666]">
                    {formatRelativeTime(s.modified)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-[#666]">
                  <span>{s.messageCount} msgs</span>
                  {isCurrent && <span className="text-[#4af626]">current</span>}
                </div>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void onDelete(s.path)
                  setSessions((prev) => prev.filter((x) => x.path !== s.path))
                }}
                className={`mr-2 shrink-0 rounded p-1 text-[#666] transition hover:bg-[#2a2a2a] hover:text-[#f66] ${
                  variant === 'panel' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                title="Delete session"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              </button>
            </div>
          )
        })}
    </>
  )

  if (variant === 'panel') {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[#111111]">
        <div
          className="px-4 pb-4 pt-5
        "
        >
          {onNewSession && (
            <button
              type="button"
              onClick={() => void onNewSession()}
              className="mt-4 flex h-10 w-full items-center justify-center rounded bg-[#1c1c1c] text-[12px] text-[#888] transition hover:bg-[#252525] hover:text-[#ccc]"
            >
              + new session
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">{listContent}</div>

        <div className="mt-auto p-3 pt-2">
          <button
            type="button"
            onClick={onSettingsClick}
            className="flex h-10 w-full items-center gap-3 rounded px-3 text-[#666] transition hover:bg-[#202020] hover:text-[#ccc]"
            title="Settings"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span className="text-[12px]">Settings</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded p-1.5 text-[#666] transition hover:bg-[#1e1e1e] hover:text-[#ccc]"
        title="Session history"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg bg-[#161616] shadow-xl">
          <div className="bg-[#1d1d1d] px-3 py-2 text-[11px] font-medium text-[#888]">
            Recent Sessions
          </div>

          <div className="max-h-64 overflow-y-auto">{listContent}</div>
        </div>
      )}
    </div>
  )
}
