import {
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  PencilIcon,
  PlusIcon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSummary, ConversationWorkspaceRef } from '../../../../preload/index'
import { type ConversationStatusTone, getConversationStatus } from './conversationStatus'

interface ConversationListProps {
  conversations: ConversationSummary[]
  activeId: string | null
  busyIds: Set<string>
  pendingApprovalIds: Set<string>
  onSelect: (id: string) => void
  onCreate: (workspace?: ConversationWorkspaceRef | null) => void
  onCreateWorkspaceChat: () => void
  onOpenTerminal: (workspace: ConversationWorkspaceRef) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}

const GENERAL_GROUP_ID = '__general__'
const PROJECT_SESSION_PREVIEW_LIMIT = 5

export interface ConversationWorkspaceGroup {
  id: string
  label: string
  path?: string
  workspace: ConversationWorkspaceRef | null
  conversations: ConversationSummary[]
  updatedAt: number
}

export interface ConversationSidebarSections {
  projects: ConversationWorkspaceGroup[]
  chats: ConversationSummary[]
}

function workspaceLabel(workspace: ConversationWorkspaceRef): string {
  return workspace.label?.trim() || workspace.path || workspace.id
}

export function groupConversationsByWorkspace(
  conversations: ConversationSummary[],
): ConversationWorkspaceGroup[] {
  const groups = new Map<string, ConversationWorkspaceGroup>()
  for (const conversation of conversations) {
    const workspace = conversation.workspace ?? null
    const id = workspace?.id ?? GENERAL_GROUP_ID
    const existing = groups.get(id)
    if (existing) {
      existing.conversations.push(conversation)
      existing.updatedAt = Math.max(existing.updatedAt, conversation.updatedAt)
      continue
    }
    groups.set(id, {
      id,
      label: workspace ? workspaceLabel(workspace) : 'General',
      ...(workspace?.path ? { path: workspace.path } : {}),
      workspace,
      conversations: [conversation],
      updatedAt: conversation.updatedAt,
    })
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      conversations: [...group.conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => {
      if (a.workspace === null && b.workspace !== null) return 1
      if (a.workspace !== null && b.workspace === null) return -1
      return b.updatedAt - a.updatedAt
    })
}

export function buildConversationSidebarSections(
  conversations: ConversationSummary[],
): ConversationSidebarSections {
  const groups = groupConversationsByWorkspace(conversations)
  return {
    projects: groups.filter((group) => group.workspace !== null),
    chats: groups.find((group) => group.workspace === null)?.conversations ?? [],
  }
}

function statusClassName(tone: ConversationStatusTone): string {
  if (tone === 'approval') return 'bg-amber-50 text-amber-600'
  if (tone === 'failed') return 'bg-red-50 text-red-600'
  if (tone === 'cancelled') return 'bg-zinc-100 text-zinc-500'
  if (tone === 'interrupted') return 'bg-amber-50 text-amber-600'
  return 'bg-blue-50 text-blue-600'
}

export function formatConversationListRelativeTime(updatedAt: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - updatedAt)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day

  if (diffMs < minute) return 'now'
  if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))}m`
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h`
  if (diffMs < week) return `${Math.floor(diffMs / day)}d`
  if (diffMs < 5 * week) return `${Math.floor(diffMs / week)}w`

  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function ConversationList({
  conversations,
  activeId,
  busyIds,
  pendingApprovalIds,
  onSelect,
  onCreate,
  onCreateWorkspaceChat,
  onOpenTerminal,
  onRename,
  onDelete,
}: ConversationListProps): ReactElement {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set())
  const [fullyShownProjectIds, setFullyShownProjectIds] = useState<Set<string>>(() => new Set())
  const initializedProjectExpansionRef = useRef(false)
  const { projects, chats } = useMemo(
    () => buildConversationSidebarSections(conversations),
    [conversations],
  )
  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [activeId, conversations],
  )
  const activeWorkspaceId = activeConversation?.workspace?.id ?? null

  useEffect(() => {
    if (activeWorkspaceId) {
      setExpandedProjectIds((current) => {
        if (current.has(activeWorkspaceId)) return current
        const next = new Set(current)
        next.add(activeWorkspaceId)
        return next
      })
    }
  }, [activeWorkspaceId])

  useEffect(() => {
    if (initializedProjectExpansionRef.current || projects.length === 0) return
    initializedProjectExpansionRef.current = true
    setExpandedProjectIds((current) => {
      if (current.size > 0) return current
      return new Set([projects[0].id])
    })
  }, [projects])

  useEffect(() => {
    const projectIds = new Set(projects.map((project) => project.id))
    setExpandedProjectIds((current) => {
      const next = new Set(Array.from(current).filter((id) => projectIds.has(id)))
      if (next.size === current.size && Array.from(next).every((id) => current.has(id))) {
        return current
      }
      return next
    })
  }, [projects])

  const toggleProjectExpanded = (projectId: string): void => {
    setExpandedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  return (
    <div className="flex h-full flex-col text-[var(--text)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <section className="mb-6">
          <SectionHeader
            label="Projects"
            actionLabel="New workspace chat"
            onAction={onCreateWorkspaceChat}
          />
          {projects.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {projects.map((project) => {
                const isExpanded = expandedProjectIds.has(project.id)
                const showAll = fullyShownProjectIds.has(project.id)
                const workspace = project.workspace
                const visibleConversations = showAll
                  ? project.conversations
                  : project.conversations.slice(0, PROJECT_SESSION_PREVIEW_LIMIT)
                const hiddenCount = project.conversations.length - visibleConversations.length

                return (
                  <li key={project.id}>
                    <div className="group/project flex h-8 items-center rounded-xl transition-colors hover:bg-[var(--surface-hover)]">
                      <button
                        type="button"
                        onClick={() => toggleProjectExpanded(project.id)}
                        title={project.path ?? project.label}
                        aria-expanded={isExpanded}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left"
                      >
                        <span
                          className={`grid size-4 shrink-0 place-items-center text-[var(--sidebar-text-dim)] transition-transform ${
                            isExpanded ? 'rotate-90' : ''
                          }`}
                        >
                          <ChevronRightIcon className="size-3.5" />
                        </span>
                        <span className="grid size-5 shrink-0 place-items-center text-[var(--sidebar-text-soft)]">
                          <FolderIcon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--sidebar-text-soft)]">
                          {project.label}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (workspace) onOpenTerminal(workspace)
                        }}
                        aria-label={`Open Terminal in ${project.label}`}
                        title="Open Terminal"
                        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-[var(--sidebar-text-dim)] opacity-0 transition group-hover/project:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--text)]"
                      >
                        <TerminalIcon className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onCreate(workspace)}
                        aria-label={`New chat in ${project.label}`}
                        title={`New chat in ${project.label}`}
                        className="mr-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-[var(--sidebar-text-dim)] opacity-0 transition group-hover/project:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--text)]"
                      >
                        <PlusIcon className="size-3.5" />
                      </button>
                    </div>
                    {isExpanded && (
                      <ul className="mt-0.5 flex flex-col gap-0.5">
                        {visibleConversations.map((conversation) => (
                          <ConversationRow
                            key={conversation.id}
                            conversation={conversation}
                            activeId={activeId}
                            busyIds={busyIds}
                            pendingApprovalIds={pendingApprovalIds}
                            renamingId={renamingId}
                            onSelect={onSelect}
                            onRename={onRename}
                            onDelete={onDelete}
                            onStartRename={setRenamingId}
                            onStopRename={() => setRenamingId(null)}
                            indented
                          />
                        ))}
                        {hiddenCount > 0 && (
                          <li>
                            <button
                              type="button"
                              onClick={() =>
                                setFullyShownProjectIds((current) => {
                                  const next = new Set(current)
                                  next.add(project.id)
                                  return next
                                })
                              }
                              className="ml-11 flex h-8 cursor-pointer items-center rounded-xl px-2.5 text-[14px] text-[var(--sidebar-text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--sidebar-text-soft)]"
                            >
                              Show more
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <SectionHeader label="Chats" />
          {chats.length === 0 ? (
            <button
              type="button"
              onClick={() => onCreate(null)}
              className="flex h-8 w-full cursor-pointer items-center rounded-xl px-2.5 text-left text-[14px] text-[var(--sidebar-text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--sidebar-text-soft)]"
            >
              New chat
            </button>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {chats.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  activeId={activeId}
                  busyIds={busyIds}
                  pendingApprovalIds={pendingApprovalIds}
                  renamingId={renamingId}
                  onSelect={onSelect}
                  onRename={onRename}
                  onDelete={onDelete}
                  onStartRename={setRenamingId}
                  onStopRename={() => setRenamingId(null)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function SectionHeader({
  label,
  actionLabel,
  onAction,
}: {
  label: string
  actionLabel?: string
  onAction?: () => void
}): ReactElement {
  return (
    <div className="group/section mb-2 flex h-7 items-center px-2.5">
      <h2 className="min-w-0 flex-1 truncate text-[14px] font-normal text-[var(--sidebar-text-dim)]">
        {label}
      </h2>
      {onAction && actionLabel && (
        <button
          type="button"
          onClick={onAction}
          aria-label={actionLabel}
          title={actionLabel}
          className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-[var(--sidebar-text-dim)] opacity-60 transition group-hover/section:opacity-100 hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <FolderPlusIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function ConversationRow({
  conversation,
  activeId,
  busyIds,
  pendingApprovalIds,
  renamingId,
  onSelect,
  onRename,
  onDelete,
  onStartRename,
  onStopRename,
  indented = false,
}: {
  conversation: ConversationSummary
  activeId: string | null
  busyIds: Set<string>
  pendingApprovalIds: Set<string>
  renamingId: string | null
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onStartRename: (id: string) => void
  onStopRename: () => void
  indented?: boolean
}): ReactElement {
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
      className={`group flex h-8 items-center rounded-xl transition-colors ${
        isActive ? 'bg-[var(--surface-hover)]' : 'hover:bg-[var(--surface-hover)]'
      }`}
    >
      {isRenaming ? (
        <ConversationRenameInput
          initialTitle={conversation.title || ''}
          indented={indented}
          onSubmit={(next) => {
            onStopRename()
            if (next && next !== conversation.title) {
              onRename(conversation.id, next)
            }
          }}
          onCancel={onStopRename}
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => onSelect(conversation.id)}
            onDoubleClick={() => onStartRename(conversation.id)}
            className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left ${
              indented ? 'pl-14 pr-2' : 'px-2.5'
            }`}
          >
            <span
              className={`min-w-0 flex-1 truncate text-[14px] ${
                isActive ? 'font-medium text-[var(--text)]' : 'text-[var(--sidebar-text-soft)]'
              }`}
            >
              {title}
            </span>
            {status && (
              <span
                role="status"
                aria-label={status.ariaLabel}
                title={status.title}
                className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none ${statusClassName(
                  status.tone,
                )}`}
              >
                {status.label}
              </span>
            )}
          </button>
          <span className="w-9 shrink-0 pr-2 text-right text-[13px] tabular-nums text-[var(--sidebar-text-dim)] group-hover:hidden">
            {formatConversationListRelativeTime(conversation.updatedAt)}
          </span>
          <div className="mr-1 hidden shrink-0 items-center gap-0.5 group-hover:flex">
            <button
              type="button"
              onClick={() => onStartRename(conversation.id)}
              aria-label="Rename conversation"
              title="Rename"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--sidebar-text-dim)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
            >
              <PencilIcon className="size-3.5" />
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
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--sidebar-text-dim)] hover:bg-[var(--surface)] hover:text-[var(--error)]"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </div>
        </>
      )}
    </li>
  )
}

function ConversationRenameInput({
  initialTitle,
  indented = false,
  onSubmit,
  onCancel,
}: {
  initialTitle: string
  indented?: boolean
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
      className={`h-8 min-w-0 flex-1 rounded-xl bg-transparent pr-2.5 text-[14px] text-[var(--text)] outline-none placeholder:text-[var(--sidebar-text-dim)] ${
        indented ? 'pl-14' : 'pl-2.5'
      }`}
    />
  )
}
