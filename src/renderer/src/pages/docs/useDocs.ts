import { useCallback, useEffect, useState } from 'react'
import type { DocContent, DocRecord, DocSummary } from './types'

export interface DocsState {
  docs: DocSummary[]
  activeId: string | null
  activeDoc: DocRecord | null
  select: (id: string) => void
  create: () => Promise<void>
  remove: (id: string) => Promise<void>
  save: (patch: { title?: string; content?: DocContent }) => Promise<void>
}

export function useDocs(): DocsState {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeDoc, setActiveDoc] = useState<DocRecord | null>(null)

  const refreshList = useCallback(async () => {
    const list = (await window.api.docs.list()) as DocSummary[]
    setDocs(list)
    return list
  }, [])

  useEffect(() => {
    void (async () => {
      const list = await refreshList()
      if (list.length > 0) setActiveId(list[0].id)
    })()
  }, [refreshList])

  useEffect(() => {
    if (!activeId) {
      setActiveDoc(null)
      return
    }
    let cancelled = false
    void (async () => {
      const doc = (await window.api.docs.get(activeId)) as DocRecord
      if (!cancelled) setActiveDoc(doc)
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  const create = useCallback(async () => {
    const doc = (await window.api.docs.create()) as DocRecord
    await refreshList()
    setActiveId(doc.id)
  }, [refreshList])

  const remove = useCallback(
    async (id: string) => {
      await window.api.docs.delete(id)
      const list = await refreshList()
      if (activeId === id) {
        setActiveId(list.length > 0 ? list[0].id : null)
      }
    },
    [activeId, refreshList],
  )

  const save = useCallback(
    async (patch: { title?: string; content?: DocContent }) => {
      if (!activeId) return
      const updated = (await window.api.docs.update(activeId, patch)) as DocRecord
      setDocs((prev) => {
        const next = prev.map((doc) =>
          doc.id === updated.id
            ? {
                id: updated.id,
                title: updated.title,
                createdAt: updated.createdAt,
                updatedAt: updated.updatedAt,
              }
            : doc,
        )
        next.sort((a, b) => b.updatedAt - a.updatedAt)
        return next
      })
    },
    [activeId],
  )

  return {
    docs,
    activeId,
    activeDoc,
    select: setActiveId,
    create,
    remove,
    save,
  }
}
