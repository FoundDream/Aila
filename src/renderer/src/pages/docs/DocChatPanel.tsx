import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { ActivityTimeline } from '@/pages/chat/ActivityTimeline'
import { Composer } from '@/pages/chat/Composer'
import { Transcript } from '@/pages/chat/Transcript'
import type { ChatStreamsApi } from '@/pages/chat/useChatStreams'
import { useModelSelection } from '@/pages/chat/useModelSelection'
import type { AgentProfileId, ConversationSummary } from '../../../../preload/index'
import type { ProviderId, Settings } from '../../types'
import { useDocConversation } from './useDocConversation'

interface DocChatPanelProps {
  docPath: string
  streams: ChatStreamsApi
  settings: Settings | null
  configuredProviders: ProviderId[]
  onUpdateSettings: (settings: Settings) => Promise<void>
  onOpenSettings: () => void
  onClose: () => void
}

const DOC_WORKBENCH_PROFILE_ID: AgentProfileId = 'coding'

export function DocChatPanel({
  docPath,
  streams,
  settings,
  configuredProviders,
  onUpdateSettings,
  onOpenSettings,
  onClose,
}: DocChatPanelProps): ReactElement {
  const { sessions, activeId, isReady, newSession, selectSession, ensureActiveSession } =
    useDocConversation(docPath)

  const { selection, selectionRef, contextLength, handleSelectionChange } = useModelSelection(
    settings,
    configuredProviders,
    onUpdateSettings,
  )

  // Hydrate the conversation buffer for the active session. useChatStreams
  // routes IPC events by conversationId, so docs and chat tabs can stream
  // concurrently without interfering.
  useEffect(() => {
    if (!activeId) return
    void streams.hydrate(activeId)
  }, [activeId, streams])

  const stream = activeId ? streams.getStream(activeId) : null
  const messages = stream?.messages ?? []
  const isStreaming = stream?.runningMessageId !== null && stream?.runningMessageId !== undefined
  const usage = stream?.usage ?? null
  const events = stream?.events ?? []
  const queuedCount = stream?.queue.length ?? 0
  const lastMessage = messages.at(-1)
  const canRetryLast =
    Boolean(activeId) && !isStreaming && queuedCount === 0 && lastMessage?.role === 'user'

  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return

      const currentSelection = selectionRef.current
      if (!currentSelection) {
        onOpenSettings()
        return
      }
      const id = await ensureActiveSession()
      if (!id) return
      streams.enqueueSend(id, trimmed, currentSelection, DOC_WORKBENCH_PROFILE_ID)
    },
    [streams, onOpenSettings, selectionRef, ensureActiveSession],
  )

  const handleAbort = useCallback(() => {
    if (!activeId) return
    streams.abort(activeId)
  }, [activeId, streams])

  const handleRetryLast = useCallback(() => {
    if (!activeId) return
    const currentSelection = selectionRef.current
    if (!currentSelection) {
      onOpenSettings()
      return
    }
    streams.enqueueRetryLast(activeId, currentSelection, DOC_WORKBENCH_PROFILE_ID)
  }, [activeId, streams, onOpenSettings, selectionRef])

  const activeSession = sessions.find((s) => s.id === activeId) ?? null

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 px-2">
        <SessionPicker
          sessions={sessions}
          active={activeSession}
          onSelect={selectSession}
          onNewSession={newSession}
        />
        <button
          type="button"
          onClick={newSession}
          aria-label="New chat"
          title="New chat"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat panel"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <CloseIcon />
        </button>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        {isReady ? (
          <>
            <Transcript
              messages={messages}
              canRetryLast={canRetryLast}
              onRetryLast={handleRetryLast}
            />
            <ActivityTimeline events={events} />
            <Composer
              isStreaming={isStreaming}
              queuedCount={queuedCount}
              onSubmit={handleSubmit}
              onAbort={handleAbort}
              usage={usage}
              contextLength={contextLength}
              configuredProviders={configuredProviders}
              selection={selection}
              onSelectionChange={handleSelectionChange}
              onOpenSettings={onOpenSettings}
              recentOpenRouterModels={settings?.recentOpenRouterModels ?? []}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-dim)]">
            Loading conversation…
          </div>
        )}
      </main>
    </div>
  )
}

interface SessionPickerProps {
  sessions: ConversationSummary[]
  active: ConversationSummary | null
  onSelect: (id: string) => void
  onNewSession: () => void
}

function SessionPicker({
  sessions,
  active,
  onSelect,
  onNewSession,
}: SessionPickerProps): ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const label = active?.title || 'New chat'

  return (
    <div className="relative min-w-0 flex-1" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 max-w-full items-center gap-1 rounded px-1.5 text-[12.5px] tracking-wide text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-10 w-[240px] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg)] py-1 shadow-md">
          <button
            type="button"
            onClick={() => {
              onNewSession()
              setOpen(false)
            }}
            className="flex h-7 w-full items-center gap-2 px-2 text-[13px] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <span className="flex h-4 w-4 items-center justify-center">
              <PlusIcon />
            </span>
            <span>New chat</span>
          </button>
          {sessions.length > 0 && (
            <>
              <div className="my-1 border-t border-[var(--border)]" />
              <ul className="max-h-[280px] overflow-y-auto">
                {sessions.map((session) => {
                  const isActive = session.id === active?.id
                  return (
                    <li key={session.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(session.id)
                          setOpen(false)
                        }}
                        className={`flex h-7 w-full items-center px-2 text-[13px] ${
                          isActive
                            ? 'bg-[var(--surface-hover)] text-[var(--text)]'
                            : 'text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
                        }`}
                      >
                        <span className="truncate">{session.title || '新对话'}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function PlusIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function CloseIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}
