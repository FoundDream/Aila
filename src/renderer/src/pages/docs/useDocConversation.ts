import { useCallback, useEffect, useState } from 'react'
import type { ConversationSummary } from '../../../../preload/index'

// A doc owns N conversations (all carry docId, which under the vault model is
// the doc's vault-relative path). The chat-tab sidebar filters these out, so
// they only surface here. New sessions are lazy: clicking "New chat" just
// clears activeId; the row is created on the first send so abandoned empties
// don't pile up.
//
// Note: external Finder renames of doc files will silently desync the
// conversation refs (no fs watcher) — affected sidebars will appear empty.
// In-app doc renames cascade-rewrite meta.docId via docs.ts → conversations.ts.
export interface DocConversationApi {
  sessions: ConversationSummary[]
  activeId: string | null
  isReady: boolean
  newSession: () => void
  selectSession: (id: string) => void
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  ensureActiveSession: () => Promise<string | null>
}

export function useDocConversation(docPath: string | null): DocConversationApi {
  const [sessions, setSessions] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    if (!docPath) {
      setSessions([])
      setActiveId(null)
      setIsReady(true)
      return
    }
    let cancelled = false
    setIsReady(false)
    void (async () => {
      try {
        const list = await window.api.conversations.listForDoc(docPath)
        if (cancelled) return
        setSessions(list)
        setActiveId(list[0]?.id ?? null)
      } catch (err) {
        console.error('[useDocConversation] list failed for', docPath, err)
      } finally {
        if (!cancelled) setIsReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [docPath])

  // Stay in sync with title/updatedAt changes (derived after the first user
  // message lands) so the picker reflects the latest state without a refetch.
  useEffect(() => {
    if (!docPath) return
    return window.api.conversations.onUpdated((summary) => {
      if (summary.docId !== docPath) return
      setSessions((prev) => {
        const found = prev.some((s) => s.id === summary.id)
        const next = found
          ? prev.map((s) => (s.id === summary.id ? summary : s))
          : [summary, ...prev]
        next.sort((a, b) => b.updatedAt - a.updatedAt)
        return next
      })
    })
  }, [docPath])

  const newSession = useCallback(() => {
    setActiveId(null)
  }, [])

  const selectSession = useCallback((id: string) => {
    setActiveId(id)
  }, [])

  const renameSession = useCallback(async (id: string, title: string): Promise<void> => {
    const updated = await window.api.conversations.rename(id, title)
    setSessions((prev) => {
      const next = prev.map((session) => (session.id === updated.id ? updated : session))
      next.sort((a, b) => b.updatedAt - a.updatedAt)
      return next
    })
  }, [])

  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      await window.api.conversations.delete(id)
      const next = sessions.filter((session) => session.id !== id)
      setSessions(next)
      if (activeId === id) setActiveId(next[0]?.id ?? null)
    },
    [activeId, sessions],
  )

  const ensureActiveSession = useCallback(async (): Promise<string | null> => {
    if (activeId) return activeId
    if (!docPath) return null
    const fresh = await window.api.conversations.create(docPath)
    setSessions((prev) => [fresh, ...prev])
    setActiveId(fresh.id)
    return fresh.id
  }, [activeId, docPath])

  return {
    sessions,
    activeId,
    isReady,
    newSession,
    selectSession,
    renameSession,
    deleteSession,
    ensureActiveSession,
  }
}
