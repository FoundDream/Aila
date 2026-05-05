import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import type { DocSummary, FolderSummary } from './types'

interface DocListProps {
  docs: DocSummary[]
  folders: FolderSummary[]
  activePath: string | null
  onSelect: (path: string) => void
  onCreateDoc: (folderPath: string | null) => void
  onDeleteDoc: (path: string) => void
  onMoveDoc: (path: string, folderPath: string | null) => void
  onCreateFolder: (parentPath: string | null, name: string) => Promise<unknown>
  onRenameFolder: (path: string, newName: string) => Promise<unknown>
  onMoveFolder: (path: string, newParentPath: string | null) => Promise<unknown>
  onDeleteFolder: (path: string) => void
}

type DragPayload = { kind: 'doc'; path: string } | { kind: 'folder'; path: string }

interface FolderNode {
  kind: 'folder'
  path: string
  name: string
  folders: FolderNode[]
  docs: DocSummary[]
}

interface RootTree {
  folders: FolderNode[]
  docs: DocSummary[]
}

const DRAG_MIME = 'application/x-aila-doc-drag'

function PageIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}

function FolderIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={open ? 'currentColor' : 'none'}
      fillOpacity={open ? 0.18 : undefined}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

function PlusIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function FolderPlusIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  )
}

function TrashIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  )
}

function PencilIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}

function buildTree(folders: FolderSummary[], docs: DocSummary[]): RootTree {
  // Index folders by path so we can attach children in O(N).
  const nodeByPath = new Map<string, FolderNode>()
  for (const folder of folders) {
    nodeByPath.set(folder.path, {
      kind: 'folder',
      path: folder.path,
      name: folder.name,
      folders: [],
      docs: [],
    })
  }

  const root: RootTree = { folders: [], docs: [] }

  for (const folder of folders) {
    const node = nodeByPath.get(folder.path)
    if (!node) continue
    if (folder.parentPath) {
      nodeByPath.get(folder.parentPath)?.folders.push(node)
    } else {
      root.folders.push(node)
    }
  }

  for (const doc of docs) {
    if (doc.folderPath) {
      nodeByPath.get(doc.folderPath)?.docs.push(doc)
    } else {
      root.docs.push(doc)
    }
  }

  const sortNode = (node: { folders: FolderNode[]; docs: DocSummary[] }): void => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name))
    node.docs.sort((a, b) => b.updatedAt - a.updatedAt)
    for (const child of node.folders) sortNode(child)
  }
  sortNode(root)
  return root
}

// Auto-expand the chain of folders containing the active doc so the user can
// see where they are. Walks the folder path segment by segment ('A/B/C' →
// ['A', 'A/B', 'A/B/C']).
function ancestorsOf(folderPath: string | null): string[] {
  if (!folderPath) return []
  const parts = folderPath.split('/')
  const out: string[] = []
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

export function DocList({
  docs,
  folders,
  activePath,
  onSelect,
  onCreateDoc,
  onDeleteDoc,
  onMoveDoc,
  onCreateFolder,
  onRenameFolder,
  onMoveFolder,
  onDeleteFolder,
}: DocListProps): ReactElement {
  const tree = useMemo(() => buildTree(folders, docs), [folders, docs])
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [drag, setDrag] = useState<DragPayload | null>(null)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null) // path or '' for root
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  // Folders that should jump straight into rename-mode after creation. Tracked
  // separately so the ancestor-expansion effect doesn't fight with the rename
  // flow.
  const justCreatedRef = useRef<string | null>(null)

  useEffect(() => {
    const activeDoc = docs.find((d) => d.path === activePath)
    if (!activeDoc) return
    const chain = ancestorsOf(activeDoc.folderPath)
    if (chain.length === 0) return
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      for (const p of chain) next.add(p)
      return next
    })
  }, [activePath, docs])

  useEffect(() => {
    const newly = justCreatedRef.current
    if (!newly) return
    if (folders.some((f) => f.path === newly)) {
      justCreatedRef.current = null
      setRenamingPath(newly)
    }
  }, [folders])

  const toggleExpanded = (path: string): void => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const finishDrag = (): void => {
    setDrag(null)
    setDropTargetPath(null)
  }

  const canDropOn = (targetPath: string | null): boolean => {
    if (!drag) return false
    if (drag.kind === 'doc') return true
    // Folder being dragged: cannot drop onto self or any descendant. Equality
    // and prefix check work because we use posix paths everywhere.
    if (targetPath === null) return drag.path !== '' // moving to root only meaningful if not already there
    if (targetPath === drag.path) return false
    if (targetPath.startsWith(`${drag.path}/`)) return false
    return true
  }

  const performDrop = async (targetPath: string | null): Promise<void> => {
    if (!drag) return
    if (drag.kind === 'doc') {
      onMoveDoc(drag.path, targetPath)
    } else {
      await onMoveFolder(drag.path, targetPath)
    }
  }

  const dropTargetForRender = (path: string | null): boolean => {
    if (!drag) return false
    const key = path === null ? '' : path
    return dropTargetPath === key
  }

  const renderFolder = (node: FolderNode, depth: number): ReactElement => {
    const isExpanded = expandedPaths.has(node.path)
    const isRenaming = renamingPath === node.path
    const isDropTarget = dropTargetForRender(node.path)
    const hasChildren = node.folders.length > 0 || node.docs.length > 0

    return (
      <li key={`folder:${node.path}`}>
        <div
          draggable={!isRenaming}
          onDragStart={(event) => {
            if (isRenaming) return
            event.stopPropagation()
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData(
              DRAG_MIME,
              JSON.stringify({ kind: 'folder', path: node.path }),
            )
            setDrag({ kind: 'folder', path: node.path })
          }}
          onDragEnd={finishDrag}
          onDragOver={(event) => {
            event.stopPropagation()
            if (!canDropOn(node.path)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDropTargetPath(node.path)
          }}
          onDrop={async (event) => {
            event.preventDefault()
            event.stopPropagation()
            if (!canDropOn(node.path)) return
            await performDrop(node.path)
            setExpandedPaths((prev) => new Set(prev).add(node.path))
            finishDrag()
          }}
          className={`group flex h-7 cursor-grab items-center rounded-md transition active:cursor-grabbing ${
            isDropTarget
              ? 'bg-[color-mix(in_srgb,var(--surface-hover)_82%,var(--accent)_18%)] ring-1 ring-[var(--border-strong)]'
              : 'hover:bg-[var(--surface-hover)]'
          } ${drag?.kind === 'folder' && drag.path === node.path ? 'opacity-45' : ''}`}
          style={{ paddingLeft: `${Math.min(depth, 5) * 14}px` }}
        >
          <span className="ml-2 flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-dim)]">
            <FolderIcon open={isExpanded && hasChildren} />
          </span>
          {isRenaming ? (
            <FolderRenameInput
              initialName={node.name}
              onSubmit={async (name) => {
                setRenamingPath(null)
                if (!name || name === node.name) return
                try {
                  await onRenameFolder(node.path, name)
                } catch (err) {
                  console.error('Failed to rename folder', err)
                }
              }}
              onCancel={() => setRenamingPath(null)}
            />
          ) : (
            <button
              type="button"
              onClick={() => toggleExpanded(node.path)}
              onDoubleClick={() => setRenamingPath(node.path)}
              className="flex min-w-0 flex-1 cursor-pointer items-center px-2 text-left"
              draggable={false}
            >
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--text-soft)]">
                {node.name}
              </span>
            </button>
          )}
          {!isRenaming && (
            <>
              <button
                type="button"
                onClick={() => {
                  setExpandedPaths((prev) => new Set(prev).add(node.path))
                  onCreateDoc(node.path)
                }}
                aria-label="New document in folder"
                title="New document"
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--text-soft)]"
                draggable={false}
              >
                <PlusIcon />
              </button>
              <button
                type="button"
                onClick={async () => {
                  setExpandedPaths((prev) => new Set(prev).add(node.path))
                  try {
                    const folder = await onCreateFolder(node.path, '新文件夹')
                    if (folder && typeof folder === 'object' && 'path' in folder) {
                      justCreatedRef.current = (folder as FolderSummary).path
                    }
                  } catch (err) {
                    console.error('Failed to create folder', err)
                  }
                }}
                aria-label="New nested folder"
                title="New folder"
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--text-soft)]"
                draggable={false}
              >
                <FolderPlusIcon />
              </button>
              <button
                type="button"
                onClick={() => setRenamingPath(node.path)}
                aria-label="Rename folder"
                title="Rename"
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--text-soft)]"
                draggable={false}
              >
                <PencilIcon />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Delete folder "${node.name}" and everything inside it?`)) {
                    onDeleteFolder(node.path)
                  }
                }}
                aria-label="Delete folder"
                title="Delete"
                className="mr-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--error)]"
                draggable={false}
              >
                <TrashIcon />
              </button>
            </>
          )}
        </div>
        {hasChildren && isExpanded && (
          <ul className="flex flex-col gap-px">
            {node.folders.map((child) => renderFolder(child, depth + 1))}
            {node.docs.map((doc) => renderDoc(doc, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  const renderDoc = (doc: DocSummary, depth: number): ReactElement => {
    const isActive = doc.path === activePath
    const isDragging = drag?.kind === 'doc' && drag.path === doc.path
    const title = doc.title || '无标题文档'
    return (
      <li key={`doc:${doc.path}`}>
        <div
          draggable
          onDragStart={(event) => {
            event.stopPropagation()
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: 'doc', path: doc.path }))
            setDrag({ kind: 'doc', path: doc.path })
          }}
          onDragEnd={finishDrag}
          className={`group flex h-7 cursor-grab items-center rounded-md transition active:cursor-grabbing ${
            isActive ? 'bg-[var(--surface-hover)]' : 'hover:bg-[var(--surface-hover)]'
          } ${isDragging ? 'opacity-45' : ''}`}
          style={{ paddingLeft: `${Math.min(depth, 5) * 14}px` }}
        >
          <span
            className={`ml-2 flex h-4 w-4 shrink-0 items-center justify-center ${
              isActive ? 'text-[var(--text-soft)]' : 'text-[var(--text-dim)]'
            }`}
          >
            <PageIcon />
          </span>
          <button
            type="button"
            onClick={() => onSelect(doc.path)}
            className="flex min-w-0 flex-1 cursor-pointer items-center px-2 text-left"
            draggable={false}
          >
            <span
              className={`min-w-0 flex-1 truncate text-[13.5px] ${
                isActive ? 'text-[var(--text)]' : 'text-[var(--text-soft)]'
              }`}
            >
              {title}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Delete "${title}"?`)) {
                onDeleteDoc(doc.path)
              }
            }}
            aria-label="Delete document"
            title="Delete"
            className="mr-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--error)]"
            draggable={false}
          >
            <TrashIcon />
          </button>
        </div>
      </li>
    )
  }

  const isRootDropTarget = drag !== null && dropTargetPath === ''

  return (
    <div className="flex h-full flex-col">
      <div className="group/header flex h-7 shrink-0 items-center px-2">
        <span className="flex-1 px-2 text-[11px] font-medium tracking-wide text-[var(--text-dim)]">
          Documents
        </span>
        <button
          type="button"
          onClick={async () => {
            try {
              const folder = await onCreateFolder(null, '新文件夹')
              if (folder && typeof folder === 'object' && 'path' in folder) {
                justCreatedRef.current = (folder as FolderSummary).path
              }
            } catch (err) {
              console.error('Failed to create folder', err)
            }
          }}
          aria-label="New folder"
          title="New folder"
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover/header:opacity-100 hover:bg-[var(--surface-hover)] hover:text-[var(--text-soft)]"
        >
          <FolderPlusIcon />
        </button>
        <button
          type="button"
          onClick={() => onCreateDoc(null)}
          aria-label="New document"
          title="New document"
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover/header:opacity-100 hover:bg-[var(--surface-hover)] hover:text-[var(--text-soft)]"
        >
          <PlusIcon />
        </button>
      </div>

      <div
        className={`min-h-0 flex-1 overflow-y-auto px-2 transition ${
          isRootDropTarget ? 'bg-[color-mix(in_srgb,var(--surface-hover)_72%,transparent)]' : ''
        }`}
        onDragOver={(event) => {
          if (!canDropOn(null)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropTargetPath('')
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDropTargetPath(null)
        }}
        onDrop={async (event) => {
          event.preventDefault()
          if (!canDropOn(null)) return
          await performDrop(null)
          finishDrag()
        }}
      >
        {tree.folders.length === 0 && tree.docs.length === 0 ? (
          <div className="flex flex-col gap-px">
            <button
              type="button"
              onClick={() => onCreateDoc(null)}
              className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-soft)]"
            >
              <span className="flex h-4 w-4 items-center justify-center">
                <PlusIcon />
              </span>
              <span>Add a page</span>
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-px">
            {tree.folders.map((node) => renderFolder(node, 0))}
            {tree.docs.map((doc) => renderDoc(doc, 0))}
            <li>
              <button
                type="button"
                onClick={() => onCreateDoc(null)}
                className="mt-0.5 flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-[var(--text-dim)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-soft)]"
              >
                <span className="flex h-4 w-4 items-center justify-center">
                  <PlusIcon />
                </span>
                <span>New page</span>
              </button>
            </li>
          </ul>
        )}
      </div>
    </div>
  )
}

function FolderRenameInput({
  initialName,
  onSubmit,
  onCancel,
}: {
  initialName: string
  onSubmit: (name: string) => void
  onCancel: () => void
}): ReactElement {
  const [value, setValue] = useState(initialName)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <input
      ref={inputRef}
      value={value}
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
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 bg-transparent px-2 text-[13.5px] text-[var(--text)] outline-none"
      draggable={false}
    />
  )
}
