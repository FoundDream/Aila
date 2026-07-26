import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ConversationRecord,
  ConversationSummary,
  ConversationWorkspaceRef,
} from '../../../../preload/index'

export interface ConversationsState {
  conversations: ConversationSummary[]
  activeId: string | null
  activeRecord: ConversationRecord | null
  isReady: boolean
  select: (id: string) => void
  deselect: () => void
  create: (workspace?: ConversationWorkspaceRef | null) => Promise<ConversationSummary>
  createWorkspaceChat: () => Promise<ConversationSummary | null>
  remove: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  applyUpdate: (summary: ConversationSummary) => void
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
  if (removedIds.has(summary.id) || summary.docId) {
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
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeRecord, setActiveRecord] = useState<ConversationRecord | null>(null)
  const [isReady, setIsReady] = useState(false)
  const removedConversationIdsRef = useRef<Set<string>>(new Set())

  const refreshList = useCallback(async (): Promise<ConversationSummary[]> => {
    const list = visibleConversationSummaries(
      await window.api.runtime.conversations.list(),
      removedConversationIdsRef.current,
    )
    setConversations(list)
    return list
  }, [])

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
    // Active conversation disappeared (deleted / moved to a doc) — back to the
    // empty state rather than jumping to another session.
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
      await refreshList()
      setActiveId(summary.id)
      setActiveRecord({ meta: summary, messages: [] })
      return summary
    },
    [refreshList],
  )

  const createWorkspaceChat = useCallback(async (): Promise<ConversationSummary | null> => {
    const workspace = await window.api.workspaces.pickDirectory()
    if (!workspace) return null
    return create(workspace)
  }, [create])

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
  // Doc-bound conversations are filtered out — they belong to the docs sidebar.
  const applyUpdate = useCallback((summary: ConversationSummary) => {
    const removed = removedConversationIdsRef.current
    if (removed.has(summary.id) || summary.docId) {
      setConversations((prev) => mergeConversationSummaryUpdate(prev, summary, removed))
      setActiveRecord((current) => (current?.meta.id === summary.id ? null : current))
      setActiveId((current) => (current === summary.id ? null : current))
      return
    }
    setConversations((prev) => mergeConversationSummaryUpdate(prev, summary, removed))
    setActiveRecord((current) =>
      current?.meta.id === summary.id ? { ...current, meta: summary } : current,
    )
  }, [])

  const deselect = useCallback(() => setActiveId(null), [])

  return {
    conversations,
    activeId,
    activeRecord,
    isReady,
    select: setActiveId,
    deselect,
    create,
    createWorkspaceChat,
    remove,
    rename,
    applyUpdate,
  }
}
