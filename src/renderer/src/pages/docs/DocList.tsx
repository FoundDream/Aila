import { type ReactElement, useEffect, useMemo, useState } from 'react'
import type { DocSummary } from './types'

interface DocListProps {
  docs: DocSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: (parentId?: string | null) => void
  onDelete: (id: string) => void
  onMove: (id: string, parentId: string | null) => void
}

interface DocTreeNode {
  doc: DocSummary
  children: DocTreeNode[]
}

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

function ChevronIcon({ open }: { open: boolean }): ReactElement {
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
      className={`transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function ChildPageIcon(): ReactElement {
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
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M12 12v6M9 15h6" />
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

function buildTree(docs: DocSummary[]): DocTreeNode[] {
  const nodes = new Map<string, DocTreeNode>()
  const roots: DocTreeNode[] = []

  for (const doc of docs) {
    nodes.set(doc.id, { doc, children: [] })
  }

  for (const node of nodes.values()) {
    const parent = node.doc.parentId ? nodes.get(node.doc.parentId) : null
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sortNodes = (items: DocTreeNode[]): void => {
    items.sort((a, b) => b.doc.updatedAt - a.doc.updatedAt)
    for (const item of items) sortNodes(item.children)
  }

  sortNodes(roots)
  return roots
}

function findAncestorIds(docs: DocSummary[], id: string | null): string[] {
  if (!id) return []

  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  const ancestors: string[] = []
  let current = byId.get(id)

  while (current?.parentId) {
    ancestors.push(current.parentId)
    current = byId.get(current.parentId)
  }

  return ancestors
}

function hasDescendant(docs: DocSummary[], id: string, descendantId: string): boolean {
  const childrenByParent = new Map<string, string[]>()

  for (const doc of docs) {
    if (!doc.parentId) continue
    const children = childrenByParent.get(doc.parentId) ?? []
    children.push(doc.id)
    childrenByParent.set(doc.parentId, children)
  }

  const pending = [...(childrenByParent.get(id) ?? [])]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    if (current === descendantId) return true
    pending.push(...(childrenByParent.get(current) ?? []))
  }

  return false
}

export function DocList({
  docs,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onMove,
}: DocListProps): ReactElement {
  const tree = useMemo(() => buildTree(docs), [docs])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [isRootDropTarget, setIsRootDropTarget] = useState(false)

  useEffect(() => {
    const ancestors = findAncestorIds(docs, activeId)
    if (ancestors.length === 0) return

    setExpandedIds((prev) => {
      const next = new Set(prev)
      for (const id of ancestors) next.add(id)
      return next
    })
  }, [activeId, docs])

  const toggleExpanded = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const canDropOn = (targetId: string): boolean => {
    if (!draggedId || draggedId === targetId) return false
    return !hasDescendant(docs, draggedId, targetId)
  }

  const finishDrag = (): void => {
    setDraggedId(null)
    setDropTargetId(null)
    setIsRootDropTarget(false)
  }

  const renderNode = (node: DocTreeNode, depth: number): ReactElement => {
    const { doc, children } = node
    const isActive = doc.id === activeId
    const isExpanded = expandedIds.has(doc.id)
    const title = doc.title || '无标题文档'

    return (
      <li key={doc.id}>
        <div
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', doc.id)
            setDraggedId(doc.id)
          }}
          onDragEnd={finishDrag}
          onDragOver={(event) => {
            event.stopPropagation()
            if (!canDropOn(doc.id)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDropTargetId(doc.id)
            setIsRootDropTarget(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (!canDropOn(doc.id) || !draggedId) return
            onMove(draggedId, doc.id)
            setExpandedIds((prev) => new Set(prev).add(doc.id))
            finishDrag()
          }}
          className={`group flex h-7 cursor-grab items-center rounded-md transition active:cursor-grabbing ${
            dropTargetId === doc.id
              ? 'bg-[color-mix(in_srgb,var(--surface-hover)_82%,var(--accent)_18%)] ring-1 ring-[var(--border-strong)]'
              : isActive
                ? 'bg-[var(--surface-hover)]'
                : 'hover:bg-[var(--surface-hover)]'
          } ${draggedId === doc.id ? 'opacity-45' : ''}`}
          style={{ paddingLeft: `${Math.min(depth, 5) * 14}px` }}
        >
          {children.length > 0 ? (
            <button
              type="button"
              onClick={() => toggleExpanded(doc.id)}
              aria-label={isExpanded ? 'Collapse document' : 'Expand document'}
              title={isExpanded ? 'Collapse' : 'Expand'}
              className="ml-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] hover:bg-[var(--surface)] hover:text-[var(--text-soft)]"
              draggable={false}
            >
              <ChevronIcon open={isExpanded} />
            </button>
          ) : (
            <span className="ml-1 h-5 w-5 shrink-0" />
          )}
          <button
            type="button"
            onClick={() => onSelect(doc.id)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1 text-left"
            draggable={false}
          >
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center ${
                isActive ? 'text-[var(--text-soft)]' : 'text-[var(--text-dim)]'
              }`}
            >
              <PageIcon />
            </span>
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
              setExpandedIds((prev) => new Set(prev).add(doc.id))
              onCreate(doc.id)
            }}
            aria-label="New nested document"
            title="New nested document"
            className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--text-soft)]"
            draggable={false}
          >
            <ChildPageIcon />
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Delete "${title}" and its nested documents?`)) {
                onDelete(doc.id)
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
        {children.length > 0 && isExpanded && (
          <ul className="flex flex-col gap-px">
            {children.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="group/header flex h-7 shrink-0 items-center px-2">
        <span className="flex-1 px-2 text-[11px] font-medium tracking-wide text-[var(--text-dim)]">
          Documents
        </span>
        <button
          type="button"
          onClick={() => onCreate()}
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
          if (!draggedId) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropTargetId(null)
          setIsRootDropTarget(true)
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setIsRootDropTarget(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (!draggedId) return
          onMove(draggedId, null)
          finishDrag()
        }}
      >
        {docs.length === 0 ? (
          <button
            type="button"
            onClick={() => onCreate()}
            className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-soft)]"
          >
            <span className="flex h-4 w-4 items-center justify-center">
              <PlusIcon />
            </span>
            <span>Add a page</span>
          </button>
        ) : (
          <ul className="flex flex-col gap-px">
            {tree.map((node) => renderNode(node, 0))}
            <li>
              <button
                type="button"
                onClick={() => onCreate()}
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
