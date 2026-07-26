import { useCallback, useEffect, useRef, useState } from 'react'
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

function visibleDocConversationSummaries(
  sessions: ConversationSummary[],
  removedIds: ReadonlySet<string>,
): ConversationSummary[] {
  if (removedIds.size === 0) return sessions
  return sessions.filter((session) => !removedIds.has(session.id))
}

export function mergeDocConversationSummaryUpdate(
  sessions: ConversationSummary[],
  summary: ConversationSummary,
  docPath: string,
  removedIds: ReadonlySet<string>,
): ConversationSummary[] {
  if (removedIds.has(summary.id) || summary.docId !== docPath) {
    return sessions.filter((session) => session.id !== summary.id)
  }
  const found = sessions.some((session) => session.id === summary.id)
  const next = found
    ? sessions.map((session) => (session.id === summary.id ? summary : session))
    : [summary, ...sessions]
  next.sort((a, b) => b.updatedAt - a.updatedAt)
  return next
}

export function useDocConversation(docPath: string | null): DocConversationApi {
  const [sessions, setSessions] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)
  const sessionsRef = useRef<ConversationSummary[]>([])
  const removedSessionIdsRef = useRef<Set<string>>(new Set())
  sessionsRef.current = sessions

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
        const list = visibleDocConversationSummaries(
          await window.api.runtime.conversations.listForDoc(docPath),
          removedSessionIdsRef.current,
        )
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
    return window.api.runtime.conversations.onUpdated((summary) => {
      setSessions((prev) =>
        mergeDocConversationSummaryUpdate(prev, summary, docPath, removedSessionIdsRef.current),
      )
      if (removedSessionIdsRef.current.has(summary.id) || summary.docId !== docPath) {
        setActiveId((current) => (current === summary.id ? null : current))
      }
    })
  }, [docPath])

  const newSession = useCallback(() => {
    setActiveId(null)
  }, [])

  const selectSession = useCallback((id: string) => {
    setActiveId(id)
  }, [])

  const renameSession = useCallback(async (id: string, title: string): Promise<void> => {
    const updated = await window.api.runtime.conversations.rename(id, title)
    setSessions((prev) => {
      const next = prev.map((session) => (session.id === updated.id ? updated : session))
      next.sort((a, b) => b.updatedAt - a.updatedAt)
      return next
    })
  }, [])

  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      removedSessionIdsRef.current.add(id)
      const next = sessionsRef.current.filter((session) => session.id !== id)
      setSessions(next)
      setActiveId((current) => (current === id ? (next[0]?.id ?? null) : current))

      try {
        await window.api.runtime.conversations.delete(id)
      } catch (error) {
        removedSessionIdsRef.current.delete(id)
        if (docPath) {
          const list = visibleDocConversationSummaries(
            await window.api.runtime.conversations.listForDoc(docPath),
            removedSessionIdsRef.current,
          )
          setSessions(list)
          setActiveId((current) => current ?? list[0]?.id ?? null)
        }
        throw error
      }
    },
    [docPath],
  )

  const ensureActiveSession = useCallback(async (): Promise<string | null> => {
    if (activeId) return activeId
    if (!docPath) return null
    const fresh = await window.api.runtime.conversations.create(docPath)
    removedSessionIdsRef.current.delete(fresh.id)
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
