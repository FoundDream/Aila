import { useCallback, useEffect, useState } from 'react'
import type { DocContent, DocRecord, DocSummary, FolderSummary } from './types'

export interface DocsState {
  docs: DocSummary[]
  folders: FolderSummary[]
  activeId: string | null
  activeDoc: DocRecord | null
  select: (id: string) => void
  create: (folderPath?: string | null) => Promise<void>
  remove: (id: string) => Promise<void>
  move: (id: string, folderPath: string | null) => Promise<void>
  save: (patch: {
    folderPath?: string | null
    title?: string
    content?: DocContent
  }) => Promise<void>
  createFolder: (parentPath: string | null, name: string) => Promise<FolderSummary>
  renameFolder: (path: string, newName: string) => Promise<FolderSummary>
  moveFolder: (path: string, newParentPath: string | null) => Promise<FolderSummary>
  deleteFolder: (path: string) => Promise<void>
}

export function useDocs(): DocsState {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [folders, setFolders] = useState<FolderSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeDoc, setActiveDoc] = useState<DocRecord | null>(null)

  const refreshList = useCallback(async () => {
    const result = await window.api.docs.list()
    setDocs(result.docs as DocSummary[])
    setFolders(result.folders as FolderSummary[])
    return result
  }, [])

  useEffect(() => {
    void (async () => {
      const result = await refreshList()
      if (result.docs.length > 0) setActiveId(result.docs[0].id)
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

  const create = useCallback(
    async (folderPath: string | null = null) => {
      const doc = (await window.api.docs.create(folderPath)) as DocRecord
      await refreshList()
      setActiveId(doc.id)
    },
    [refreshList],
  )

  const remove = useCallback(
    async (id: string) => {
      await window.api.docs.delete(id)
      const result = await refreshList()
      if (activeId && !result.docs.some((doc) => doc.id === activeId)) {
        setActiveId(result.docs.length > 0 ? result.docs[0].id : null)
      }
    },
    [activeId, refreshList],
  )

  const applyUpdated = useCallback((updated: DocRecord) => {
    setDocs((prev) => {
      const next = prev.map((doc) =>
        doc.id === updated.id
          ? {
              id: updated.id,
              folderPath: updated.folderPath,
              title: updated.title,
              createdAt: updated.createdAt,
              updatedAt: updated.updatedAt,
            }
          : doc,
      )
      next.sort((a, b) => b.updatedAt - a.updatedAt)
      return next
    })
    setActiveDoc((prev) => (prev && prev.id === updated.id ? updated : prev))
  }, [])

  const move = useCallback(
    async (id: string, folderPath: string | null) => {
      const updated = (await window.api.docs.update(id, { folderPath })) as DocRecord
      applyUpdated(updated)
    },
    [applyUpdated],
  )

  const save = useCallback(
    async (patch: { folderPath?: string | null; title?: string; content?: DocContent }) => {
      if (!activeId) return
      const updated = (await window.api.docs.update(activeId, patch)) as DocRecord
      applyUpdated(updated)
    },
    [activeId, applyUpdated],
  )

  const createFolder = useCallback(
    async (parentPath: string | null, name: string) => {
      const folder = (await window.api.folders.create(parentPath, name)) as FolderSummary
      await refreshList()
      return folder
    },
    [refreshList],
  )

  const renameFolder = useCallback(
    async (path: string, newName: string) => {
      const folder = (await window.api.folders.rename(path, newName)) as FolderSummary
      // Folder rename changes child doc folderPaths — refresh both lists.
      await refreshList()
      return folder
    },
    [refreshList],
  )

  const moveFolderAction = useCallback(
    async (path: string, newParentPath: string | null) => {
      const folder = (await window.api.folders.move(path, newParentPath)) as FolderSummary
      await refreshList()
      return folder
    },
    [refreshList],
  )

  const deleteFolderAction = useCallback(
    async (path: string) => {
      await window.api.folders.delete(path)
      const result = await refreshList()
      if (activeId && !result.docs.some((doc) => doc.id === activeId)) {
        setActiveId(result.docs.length > 0 ? result.docs[0].id : null)
      }
    },
    [activeId, refreshList],
  )

  return {
    docs,
    folders,
    activeId,
    activeDoc,
    select: setActiveId,
    create,
    remove,
    move,
    save,
    createFolder,
    renameFolder,
    moveFolder: moveFolderAction,
    deleteFolder: deleteFolderAction,
  }
}
