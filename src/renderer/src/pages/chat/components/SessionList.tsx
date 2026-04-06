import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/Button'
import type { SessionSummary } from '@/types/chat'

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
  onOpen,
  onDelete,
  activeSessionId,
  onNewSession,
  onSettingsClick,
}: {
  onOpen: (session: SessionSummary) => void | Promise<void>
  onDelete: (session: SessionSummary) => void | Promise<void>
  activeSessionId: string | null
  onNewSession?: () => void | Promise<void>
  onSettingsClick?: () => void
}): ReactElement {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)

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
    void loadSessions()
  }, [loadSessions])

  useEffect(() => {
    return window.api.onSessionsChanged(() => {
      void loadSessions()
    })
  }, [loadSessions])

  const listContent = (
    <>
      {loading && (
        <div className="px-3 py-4 text-center text-[11px] text-[var(--term-dim)]">Loading...</div>
      )}

      {!loading && sessions.length === 0 && (
        <div className="px-3 py-4 text-center text-[11px] text-[var(--term-dim)]">
          No sessions yet
        </div>
      )}

      {!loading &&
        sessions.map((s) => {
          const isCurrent = s.runtimeId !== null && s.runtimeId === activeSessionId
          const statusText =
            s.status === 'running'
              ? s.queuedCount > 0
                ? `running · ${s.queuedCount} queued`
                : 'running'
              : s.status === 'error'
                ? 'error'
                : isCurrent
                  ? 'active'
                  : null
          return (
            <div
              key={s.id}
              className={`group flex items-center gap-1 transition ${
                isCurrent ? 'bg-[var(--term-accent-soft)]' : 'hover:bg-[var(--term-surface-soft)]'
              }`}
            >
              <button
                type="button"
                disabled={isCurrent}
                onClick={() => {
                  void onOpen(s)
                }}
                className={`flex min-w-0 flex-1 flex-col gap-1 px-3 py-3 text-left ${
                  isCurrent ? 'text-[var(--term-blue)]' : 'text-[var(--term-text)]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-medium">
                    {s.name || s.firstMessage || `Session ${s.id}`}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--term-dim)]">
                    {formatRelativeTime(s.modified)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-[var(--term-dim)]">
                  <span>{s.messageCount} msgs</span>
                  {statusText && (
                    <span
                      className={
                        s.status === 'error'
                          ? 'text-[var(--term-red)]'
                          : isCurrent
                            ? 'text-[var(--term-blue)]'
                            : 'text-[var(--term-blue)]'
                      }
                    >
                      {statusText}
                    </span>
                  )}
                </div>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void onDelete(s)
                }}
                className="mr-2 shrink-0 rounded p-1 text-[var(--term-dim)] transition hover:bg-[var(--term-surface-hover)] hover:text-[var(--term-red)] opacity-100"
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--term-panel)]">
      <div className="px-4 pb-4 pt-3 [-webkit-app-region:no-drag]">
        {onNewSession && (
          <Button onClick={() => void onNewSession()} variant="secondary" size="md" fullWidth>
            + new session
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">{listContent}</div>

      <div className="mt-auto p-3 pt-2">
        <button
          type="button"
          onClick={onSettingsClick}
          className="flex h-10 w-full items-center gap-3 rounded px-3 text-[var(--term-dim)] transition hover:bg-[var(--term-surface)] hover:text-[var(--term-text)]"
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
