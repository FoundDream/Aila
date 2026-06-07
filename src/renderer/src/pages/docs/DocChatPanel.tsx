import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { ActivityTimeline } from '@/pages/chat/ActivityTimeline'
import { Composer } from '@/pages/chat/Composer'
import { type ConversationStatusTone, getConversationStatus } from '@/pages/chat/conversationStatus'
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
  pendingApprovalConversationIds: Set<string>
  onClearConversationApprovals: (conversationId: string) => void
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
  pendingApprovalConversationIds,
  onClearConversationApprovals,
  onUpdateSettings,
  onOpenSettings,
  onClose,
}: DocChatPanelProps): ReactElement {
  const {
    sessions,
    activeId,
    isReady,
    newSession,
    selectSession,
    renameSession,
    deleteSession,
    ensureActiveSession,
  } = useDocConversation(docPath)

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
  const hasRetryableLastTurn =
    lastMessage?.role === 'user' ||
    (lastMessage?.role === 'assistant' && lastMessage.status === 'error')
  const canRetryLast =
    Boolean(activeId) && !isStreaming && queuedCount === 0 && hasRetryableLastTurn

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

  const handleRenameSession = useCallback(
    (id: string, title: string) => {
      void renameSession(id, title)
    },
    [renameSession],
  )

  const handleDeleteSession = useCallback(
    (id: string) => {
      onClearConversationApprovals(id)
      streams.drop(id)
      void deleteSession(id)
    },
    [deleteSession, onClearConversationApprovals, streams],
  )

  const activeSession = sessions.find((s) => s.id === activeId) ?? null

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 px-2">
        <SessionPicker
          sessions={sessions}
          active={activeSession}
          pendingApprovalConversationIds={pendingApprovalConversationIds}
          busyIds={streams.busyIds}
          onSelect={selectSession}
          onNewSession={newSession}
          onRenameSession={handleRenameSession}
          onDeleteSession={handleDeleteSession}
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
  pendingApprovalConversationIds: Set<string>
  busyIds: Set<string>
  onSelect: (id: string) => void
  onNewSession: () => void
  onRenameSession: (id: string, title: string) => void
  onDeleteSession: (id: string) => void
}

function SessionPicker({
  sessions,
  active,
  pendingApprovalConversationIds,
  busyIds,
  onSelect,
  onNewSession,
  onRenameSession,
  onDeleteSession,
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
  const activeStatus = active
    ? getConversationStatus(active, {
        isBusy: busyIds.has(active.id),
        needsApproval: pendingApprovalConversationIds.has(active.id),
      })
    : null

  return (
    <div className="relative min-w-0 flex-1" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 max-w-full items-center gap-1 rounded px-1.5 text-[12.5px] tracking-wide text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
      >
        <span className="truncate">{label}</span>
        {activeStatus && (
          <span
            role="status"
            aria-label={activeStatus.ariaLabel}
            title={activeStatus.title}
            className={`ml-1 shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none ${statusClassName(
              activeStatus.tone,
            )}`}
          >
            {activeStatus.label}
          </span>
        )}
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
                  const status = getConversationStatus(session, {
                    isBusy: busyIds.has(session.id),
                    needsApproval: pendingApprovalConversationIds.has(session.id),
                  })
                  return (
                    <li
                      key={session.id}
                      className={`group flex h-7 items-center ${
                        isActive
                          ? 'bg-[var(--surface-hover)] text-[var(--text)]'
                          : 'text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(session.id)
                          setOpen(false)
                        }}
                        className="flex h-7 min-w-0 flex-1 items-center px-2 text-[13px]"
                      >
                        <span className="truncate">{session.title || '新对话'}</span>
                        {status && (
                          <span
                            role="status"
                            aria-label={status.ariaLabel}
                            title={status.title}
                            className={`ml-2 shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none ${statusClassName(
                              status.tone,
                            )}`}
                          >
                            {status.label}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          const title = window.prompt('Rename chat', session.title || '新对话')
                          if (title !== null) onRenameSession(session.id, title)
                        }}
                        aria-label="Rename chat"
                        title="Rename"
                        className="flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-dim)] opacity-0 hover:text-[var(--text)] group-hover:opacity-100"
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          if (window.confirm(`Delete "${session.title || '新对话'}"?`)) {
                            onDeleteSession(session.id)
                          }
                        }}
                        aria-label="Delete chat"
                        title="Delete"
                        className="flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-dim)] opacity-0 hover:text-[var(--error)] group-hover:opacity-100"
                      >
                        <TrashIcon />
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

function statusClassName(tone: ConversationStatusTone): string {
  if (tone === 'approval') return 'bg-amber-100 text-amber-700'
  if (tone === 'failed') return 'bg-red-100 text-red-700'
  if (tone === 'cancelled') return 'bg-zinc-100 text-zinc-600'
  if (tone === 'interrupted') return 'bg-amber-100 text-amber-700'
  return 'bg-blue-100 text-blue-700'
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

function PencilIcon(): ReactElement {
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
      <path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  )
}

function TrashIcon(): ReactElement {
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
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  )
}
