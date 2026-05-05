import { useCallback, useEffect, useState } from 'react'
import type { DocContent, DocRecord, DocSummary, FolderSummary } from './types'

export interface DocsState {
  docs: DocSummary[]
  folders: FolderSummary[]
  activePath: string | null
  activeDoc: DocRecord | null
  select: (path: string) => void
  create: (folderPath?: string | null) => Promise<void>
  remove: (path: string) => Promise<void>
  move: (path: string, folderPath: string | null) => Promise<void>
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
  const [activePath, setActivePath] = useState<string | null>(null)
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
      if (result.docs.length > 0) setActivePath(result.docs[0].path)
    })()
  }, [refreshList])

  useEffect(() => {
    if (!activePath) {
      setActiveDoc(null)
      return
    }
    let cancelled = false
    void (async () => {
      const doc = (await window.api.docs.get(activePath)) as DocRecord
      if (!cancelled) setActiveDoc(doc)
    })()
    return () => {
      cancelled = true
    }
  }, [activePath])

  const create = useCallback(
    async (folderPath: string | null = null) => {
      const doc = (await window.api.docs.create(folderPath)) as DocRecord
      await refreshList()
      setActivePath(doc.path)
    },
    [refreshList],
  )

  const remove = useCallback(
    async (path: string) => {
      await window.api.docs.delete(path)
      const result = await refreshList()
      if (activePath && !result.docs.some((doc) => doc.path === activePath)) {
        setActivePath(result.docs.length > 0 ? result.docs[0].path : null)
      }
    },
    [activePath, refreshList],
  )

  // After a full refresh, the doc the user was editing may have a NEW path
  // (rename) or be gone. Reconcile activePath against fresh data and fall
  // back to the first doc if the active one disappeared.
  const reconcileActiveAfterUpdate = useCallback(
    (updated: DocRecord, prevActive: string | null): string | null => {
      if (prevActive === updated.path) return updated.path
      // If activePath no longer matches anything in the list, the rename moved
      // the doc — adopt the new path.
      return updated.path
    },
    [],
  )

  const move = useCallback(
    async (path: string, folderPath: string | null) => {
      const updated = (await window.api.docs.update(path, { folderPath })) as DocRecord
      await refreshList()
      if (activePath === path) setActivePath(reconcileActiveAfterUpdate(updated, activePath))
    },
    [activePath, refreshList, reconcileActiveAfterUpdate],
  )

  const save = useCallback(
    async (patch: { folderPath?: string | null; title?: string; content?: DocContent }) => {
      if (!activePath) return
      const updated = (await window.api.docs.update(activePath, patch)) as DocRecord
      // A title or folderPath patch may have renamed the file on disk. Refresh
      // the list and adopt the new path so subsequent saves target the right
      // file. Content-only patches keep the same path — refresh is still cheap
      // and keeps mtime sort accurate.
      await refreshList()
      if (updated.path !== activePath) {
        setActivePath(updated.path)
      } else {
        setActiveDoc(updated)
      }
    },
    [activePath, refreshList],
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
      // Folder rename changes child doc paths — refresh and re-target activePath
      // if it was inside the renamed folder.
      const result = await refreshList()
      if (activePath?.startsWith(`${path}/`)) {
        const remapped = `${folder.path}${activePath.slice(path.length)}`
        if (result.docs.some((d) => d.path === remapped)) {
          setActivePath(remapped)
        } else if (result.docs.length > 0) {
          setActivePath(result.docs[0].path)
        } else {
          setActivePath(null)
        }
      }
      return folder
    },
    [activePath, refreshList],
  )

  const moveFolderAction = useCallback(
    async (path: string, newParentPath: string | null) => {
      const folder = (await window.api.folders.move(path, newParentPath)) as FolderSummary
      const result = await refreshList()
      if (activePath?.startsWith(`${path}/`)) {
        const remapped = `${folder.path}${activePath.slice(path.length)}`
        if (result.docs.some((d) => d.path === remapped)) {
          setActivePath(remapped)
        }
      }
      return folder
    },
    [activePath, refreshList],
  )

  const deleteFolderAction = useCallback(
    async (path: string) => {
      await window.api.folders.delete(path)
      const result = await refreshList()
      if (activePath && !result.docs.some((doc) => doc.path === activePath)) {
        setActivePath(result.docs.length > 0 ? result.docs[0].path : null)
      }
    },
    [activePath, refreshList],
  )

  return {
    docs,
    folders,
    activePath,
    activeDoc,
    select: setActivePath,
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
