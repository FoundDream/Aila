import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationRecord, ConversationSummary, ConversationWorkspaceRef } from '../../types'

export interface ConversationsState {
  conversations: ConversationSummary[]
  workspaces: ConversationWorkspaceRef[]
  activeId: string | null
  activeRecord: ConversationRecord | null
  draftWorkspace: ConversationWorkspaceRef | null
  isReady: boolean
  select: (id: string) => void
  deselect: () => void
  startSession: (workspace?: ConversationWorkspaceRef | null) => void
  create: (workspace?: ConversationWorkspaceRef | null) => Promise<ConversationSummary>
  createWorkspaceChat: () => Promise<ConversationWorkspaceRef | null>
  remove: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  applyUpdate: (summary: ConversationSummary) => void
}

const WORKSPACES_STORAGE_KEY = 'app.workspaces'

function readStoredWorkspaces(): ConversationWorkspaceRef[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WORKSPACES_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter(
      (workspace): workspace is ConversationWorkspaceRef =>
        typeof workspace === 'object' &&
        workspace !== null &&
        typeof workspace.id === 'string' &&
        typeof workspace.path === 'string' &&
        (workspace.label === undefined || typeof workspace.label === 'string'),
    )
  } catch {
    return []
  }
}

function persistWorkspaces(workspaces: ConversationWorkspaceRef[]): void {
  try {
    localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces))
  } catch {
    // Persistence is an enhancement; restricted renderer storage may reject it.
  }
}

function mergeWorkspaceRefs(
  current: ConversationWorkspaceRef[],
  incoming: ConversationWorkspaceRef[],
  prepend = false,
): ConversationWorkspaceRef[] {
  const ordered = prepend ? [...incoming, ...current] : [...current, ...incoming]
  const seen = new Set<string>()
  return ordered.filter((workspace) => {
    if (seen.has(workspace.id)) return false
    seen.add(workspace.id)
    return true
  })
}

function visibleConversationSummaries(
  conversations: ConversationSummary[],
  removedIds: ReadonlySet<string>,
): ConversationSummary[] {
  if (removedIds.size === 0) return conversations
  return conversations.filter((conversation) => !removedIds.has(conversation.id))
}

export function mergeConversationSummaryUpdate(
  conversations: ConversationSummary[],
  summary: ConversationSummary,
  removedIds: ReadonlySet<string>,
): ConversationSummary[] {
  if (removedIds.has(summary.id)) {
    return conversations.filter((conversation) => conversation.id !== summary.id)
  }
  const found = conversations.some((conversation) => conversation.id === summary.id)
  const next = found
    ? conversations.map((conversation) => (conversation.id === summary.id ? summary : conversation))
    : [...conversations, summary]
  next.sort((a, b) => b.updatedAt - a.updatedAt)
  return next
}

export function useConversations(): ConversationsState {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [workspaces, setWorkspaces] = useState<ConversationWorkspaceRef[]>(readStoredWorkspaces)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeRecord, setActiveRecord] = useState<ConversationRecord | null>(null)
  const [draftWorkspace, setDraftWorkspace] = useState<ConversationWorkspaceRef | null>(null)
  const [isReady, setIsReady] = useState(false)
  const removedConversationIdsRef = useRef<Set<string>>(new Set())

  const rememberWorkspaces = useCallback(
    (incoming: ConversationWorkspaceRef[], prepend = false): void => {
      if (incoming.length === 0) return
      setWorkspaces((current) => {
        const next = mergeWorkspaceRefs(current, incoming, prepend)
        persistWorkspaces(next)
        return next
      })
    },
    [],
  )

  const refreshList = useCallback(async (): Promise<ConversationSummary[]> => {
    const list = visibleConversationSummaries(
      await window.api.runtime.conversations.list(),
      removedConversationIdsRef.current,
    )
    setConversations(list)
    rememberWorkspaces(
      list.flatMap((conversation) => (conversation.workspace ? [conversation.workspace] : [])),
    )
    return list
  }, [rememberWorkspaces])

  // No auto-select: the chat tab opens on the new-chat empty state until the
  // user explicitly picks a conversation from the list.
  useEffect(() => {
    void (async () => {
      await refreshList()
      setIsReady(true)
    })()
  }, [refreshList])

  useEffect(() => {
    if (!isReady || !activeId) return
    if (conversations.some((conversation) => conversation.id === activeId)) return
    // Active conversation disappeared — return to the empty state rather than
    // jumping to another thread.
    setActiveId(null)
  }, [activeId, conversations, isReady])

  useEffect(() => {
    if (!activeId) {
      setActiveRecord(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const record = await window.api.runtime.conversations.get(activeId)
        if (!cancelled) setActiveRecord(record)
      } catch (error) {
        console.warn('[conversations] failed to hydrate active conversation:', error)
        const list = await refreshList()
        if (!cancelled) {
          setActiveRecord(null)
          setActiveId(list[0]?.id ?? null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeId, refreshList])

  const create = useCallback(
    async (workspace?: ConversationWorkspaceRef | null): Promise<ConversationSummary> => {
      const summary = workspace
        ? await window.api.runtime.conversations.createForWorkspace(workspace)
        : await window.api.runtime.conversations.create()
      if (workspace) rememberWorkspaces([workspace], true)
      await refreshList()
      setDraftWorkspace(null)
      setActiveId(summary.id)
      setActiveRecord({ meta: summary, messages: [] })
      return summary
    },
    [refreshList, rememberWorkspaces],
  )

  const startSession = useCallback(
    (workspace?: ConversationWorkspaceRef | null): void => {
      const nextWorkspace = workspace ?? null
      if (nextWorkspace) rememberWorkspaces([nextWorkspace], true)
      setDraftWorkspace(nextWorkspace)
      setActiveId(null)
      setActiveRecord(null)
    },
    [rememberWorkspaces],
  )

  const createWorkspaceChat = useCallback(async (): Promise<ConversationWorkspaceRef | null> => {
    const workspace = await window.api.workspaces.pickDirectory()
    if (!workspace) return null
    startSession(workspace)
    return workspace
  }, [startSession])

  const remove = useCallback(
    async (id: string) => {
      removedConversationIdsRef.current.add(id)
      setConversations((prev) => prev.filter((conversation) => conversation.id !== id))
      setActiveId((current) => (current === id ? null : current))
      setActiveRecord((current) => (current?.meta.id === id ? null : current))

      try {
        await window.api.runtime.conversations.delete(id)
        await refreshList()
      } catch (error) {
        removedConversationIdsRef.current.delete(id)
        await refreshList()
        throw error
      }
    },
    [refreshList],
  )

  const rename = useCallback(async (id: string, title: string) => {
    const updated = await window.api.runtime.conversations.rename(id, title)
    setConversations((prev) => {
      const next = prev.map((c) => (c.id === updated.id ? updated : c))
      next.sort((a, b) => b.updatedAt - a.updatedAt)
      return next
    })
    setActiveRecord((current) =>
      current?.meta.id === updated.id ? { ...current, meta: updated } : current,
    )
  }, [])

  // Reconciles a single ConversationSummary update from main (fired after every
  // appendMessage / setUsage). Keeps the sidebar in sync without a full refetch.
  const applyUpdate = useCallback(
    (summary: ConversationSummary) => {
      if (summary.workspace) rememberWorkspaces([summary.workspace])
      const removed = removedConversationIdsRef.current
      if (removed.has(summary.id)) {
        setConversations((prev) => mergeConversationSummaryUpdate(prev, summary, removed))
        setActiveRecord((current) => (current?.meta.id === summary.id ? null : current))
        setActiveId((current) => (current === summary.id ? null : current))
        return
      }
      setConversations((prev) => mergeConversationSummaryUpdate(prev, summary, removed))
      setActiveRecord((current) =>
        current?.meta.id === summary.id ? { ...current, meta: summary } : current,
      )
    },
    [rememberWorkspaces],
  )

  const select = useCallback((id: string): void => {
    setDraftWorkspace(null)
    setActiveId(id)
  }, [])

  const deselect = useCallback(() => startSession(null), [startSession])

  return {
    conversations,
    workspaces,
    activeId,
    activeRecord,
    draftWorkspace,
    isReady,
    select,
    deselect,
    startSession,
    create,
    createWorkspaceChat,
    remove,
    rename,
    applyUpdate,
  }
}
