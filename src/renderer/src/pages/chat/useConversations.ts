import { useCallback, useEffect, useState } from 'react'
import type { ConversationRecord, ConversationSummary } from '../../../../preload/index'

export interface ConversationsState {
  conversations: ConversationSummary[]
  activeId: string | null
  activeRecord: ConversationRecord | null
  isReady: boolean
  select: (id: string) => void
  create: () => Promise<ConversationSummary>
  remove: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  applyUpdate: (summary: ConversationSummary) => void
}

export function useConversations(): ConversationsState {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeRecord, setActiveRecord] = useState<ConversationRecord | null>(null)
  const [isReady, setIsReady] = useState(false)

  const refreshList = useCallback(async (): Promise<ConversationSummary[]> => {
    const list = await window.api.conversations.list()
    // Doc-bound conversations live in the docs sidebar, not the chat tab.
    const chatList = list.filter((c) => !c.docId)
    setConversations(chatList)
    return chatList
  }, [])

  useEffect(() => {
    void (async () => {
      const list = await refreshList()
      if (list.length > 0) setActiveId(list[0].id)
      setIsReady(true)
    })()
  }, [refreshList])

  useEffect(() => {
    if (!activeId) {
      setActiveRecord(null)
      return
    }
    let cancelled = false
    void (async () => {
      const record = await window.api.conversations.get(activeId)
      if (!cancelled) setActiveRecord(record)
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  const create = useCallback(async (): Promise<ConversationSummary> => {
    const summary = await window.api.conversations.create()
    await refreshList()
    setActiveId(summary.id)
    setActiveRecord({ meta: summary, messages: [] })
    return summary
  }, [refreshList])

  const remove = useCallback(
    async (id: string) => {
      await window.api.conversations.delete(id)
      const list = await refreshList()
      if (activeId === id) {
        setActiveId(list.length > 0 ? list[0].id : null)
      }
    },
    [activeId, refreshList],
  )

  const rename = useCallback(async (id: string, title: string) => {
    const updated = await window.api.conversations.rename(id, title)
    setConversations((prev) => {
      const next = prev.map((c) => (c.id === updated.id ? updated : c))
      next.sort((a, b) => b.updatedAt - a.updatedAt)
      return next
    })
  }, [])

  // Reconciles a single ConversationSummary update from main (fired after every
  // appendMessage / setUsage). Keeps the sidebar in sync without a full refetch.
  // Doc-bound conversations are filtered out — they belong to the docs sidebar.
  const applyUpdate = useCallback((summary: ConversationSummary) => {
    if (summary.docId) return
    setConversations((prev) => {
      const found = prev.some((c) => c.id === summary.id)
      const next = found ? prev.map((c) => (c.id === summary.id ? summary : c)) : [...prev, summary]
      next.sort((a, b) => b.updatedAt - a.updatedAt)
      return next
    })
  }, [])

  return {
    conversations,
    activeId,
    activeRecord,
    isReady,
    select: setActiveId,
    create,
    remove,
    rename,
    applyUpdate,
  }
}
