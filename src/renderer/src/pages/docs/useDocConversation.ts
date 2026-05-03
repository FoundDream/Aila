import { useEffect, useState } from 'react'
import type { ConversationSummary } from '../../../../preload/index'

// Each doc has at most one conversation (lazy-created on first sidebar open).
// Main scans listConversations for `docId` match — there's no in-memory cache,
// so the renderer doesn't need to invalidate anything when docs are deleted.
export function useDocConversation(docId: string | null): {
  summary: ConversationSummary | null
  isReady: boolean
} {
  const [summary, setSummary] = useState<ConversationSummary | null>(null)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    if (!docId) {
      setSummary(null)
      setIsReady(false)
      return
    }
    let cancelled = false
    setIsReady(false)
    void (async () => {
      try {
        const next = await window.api.conversations.getOrCreateForDoc(docId)
        if (!cancelled) {
          setSummary(next)
          setIsReady(true)
        }
      } catch (err) {
        console.error('[useDocConversation] failed for', docId, err)
        if (!cancelled) setIsReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [docId])

  return { summary, isReady }
}
