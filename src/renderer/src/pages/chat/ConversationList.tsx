import { type ReactElement, useEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '../../../../preload/index'
import { type ConversationStatusTone, getConversationStatus } from './conversationStatus'

interface ConversationListProps {
  conversations: ConversationSummary[]
  activeId: string | null
  busyIds: Set<string>
  pendingApprovalIds: Set<string>
  onSelect: (id: string) => void
  onCreate: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}

function PlusIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function TrashIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
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

function PencilIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
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

function statusClassName(tone: ConversationStatusTone): string {
  if (tone === 'approval') return 'bg-amber-50 text-amber-600'
  if (tone === 'failed') return 'bg-red-50 text-red-600'
  if (tone === 'cancelled') return 'bg-zinc-100 text-zinc-500'
  if (tone === 'interrupted') return 'bg-amber-50 text-amber-600'
  return 'bg-blue-50 text-blue-600'
}

export function ConversationList({
  conversations,
  activeId,
  busyIds,
  pendingApprovalIds,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: ConversationListProps): ReactElement {
  const [renamingId, setRenamingId] = useState<string | null>(null)

  return (
    <div className="flex h-full flex-col">
      <div className="group/header flex h-7 shrink-0 items-center px-2">
        <span className="flex-1 px-2 text-[11px] font-medium tracking-wide text-[var(--text-dim)]">
          Conversations
        </span>
        <button
          type="button"
          onClick={onCreate}
          aria-label="New conversation"
          title="New conversation"
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover/header:opacity-100 hover:bg-[var(--surface-hover)] hover:text-[var(--text-soft)]"
        >
          <PlusIcon />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {conversations.length === 0 ? (
          <button
            type="button"
            onClick={onCreate}
            className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-soft)]"
          >
            <span className="flex h-4 w-4 items-center justify-center">
              <PlusIcon />
            </span>
            <span>New chat</span>
          </button>
        ) : (
          <ul className="flex flex-col gap-px">
            {conversations.map((conversation) => {
              const isActive = conversation.id === activeId
              const isBusy = busyIds.has(conversation.id)
              const status = getConversationStatus(conversation, {
                isBusy,
                needsApproval: pendingApprovalIds.has(conversation.id),
              })
              const title = conversation.title || '新对话'
              const isRenaming = conversation.id === renamingId
              return (
                <li
                  key={conversation.id}
                  className={`group flex h-7 items-center rounded-lg transition ${
                    isActive ? 'bg-[var(--surface-hover)]' : 'hover:bg-[var(--surface-hover)]'
                  }`}
                >
                  {isRenaming ? (
                    <ConversationRenameInput
                      initialTitle={conversation.title || ''}
                      onSubmit={(next) => {
                        setRenamingId(null)
                        if (next && next !== conversation.title) onRename(conversation.id, next)
                      }}
                      onCancel={() => setRenamingId(null)}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onSelect(conversation.id)}
                        onDoubleClick={() => setRenamingId(conversation.id)}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 text-left"
                      >
                        <span
                          className={`min-w-0 flex-1 truncate text-[13px] ${
                            isActive ? 'text-[var(--text)]' : 'text-[var(--text-soft)]'
                          }`}
                        >
                          {title}
                        </span>
                        {status && (
                          <span
                            role="status"
                            aria-label={status.ariaLabel}
                            title={status.title}
                            className={`mr-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none ${statusClassName(
                              status.tone,
                            )}`}
                          >
                            {status.label}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenamingId(conversation.id)}
                        aria-label="Rename conversation"
                        title="Rename"
                        className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--text)]"
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Delete "${title}"?`)) {
                            onDelete(conversation.id)
                          }
                        }}
                        aria-label="Delete conversation"
                        title="Delete"
                        className="mr-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--error)]"
                      >
                        <TrashIcon />
                      </button>
                    </>
                  )}
                </li>
              )
            })}
            <li>
              <button
                type="button"
                onClick={onCreate}
                className="mt-0.5 flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] text-[var(--text-dim)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-soft)]"
              >
                <span className="flex h-4 w-4 items-center justify-center">
                  <PlusIcon />
                </span>
                <span>New chat</span>
              </button>
            </li>
          </ul>
        )}
      </div>
    </div>
  )
}

function ConversationRenameInput({
  initialTitle,
  onSubmit,
  onCancel,
}: {
  initialTitle: string
  onSubmit: (title: string) => void
  onCancel: () => void
}): ReactElement {
  const [value, setValue] = useState(initialTitle)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <input
      ref={inputRef}
      value={value}
      placeholder="新对话"
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onSubmit(value.trim())
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
      onBlur={() => onSubmit(value.trim())}
      className="h-7 min-w-0 flex-1 rounded-lg bg-transparent px-2.5 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
    />
  )
}
