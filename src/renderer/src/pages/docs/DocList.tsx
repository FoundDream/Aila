import type { ReactElement } from 'react'
import type { DocSummary } from './types'

interface DocListProps {
  docs: DocSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
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

export function DocList({
  docs,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: DocListProps): ReactElement {
  return (
    <div className="flex h-full flex-col">
      <div className="group/header flex h-7 shrink-0 items-center px-2">
        <span className="flex-1 px-2 text-[11px] font-medium tracking-wide text-[var(--text-dim)]">
          Documents
        </span>
        <button
          type="button"
          onClick={onCreate}
          aria-label="New document"
          title="New document"
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover/header:opacity-100 hover:bg-[var(--surface-hover)] hover:text-[var(--text-soft)]"
        >
          <PlusIcon />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {docs.length === 0 ? (
          <button
            type="button"
            onClick={onCreate}
            className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-soft)]"
          >
            <span className="flex h-4 w-4 items-center justify-center">
              <PlusIcon />
            </span>
            <span>Add a page</span>
          </button>
        ) : (
          <ul className="flex flex-col gap-px">
            {docs.map((doc) => {
              const isActive = doc.id === activeId
              const title = doc.title || '无标题文档'
              return (
                <li
                  key={doc.id}
                  className={`group flex h-7 items-center rounded-md transition ${
                    isActive
                      ? 'bg-[var(--surface-hover)]'
                      : 'hover:bg-[var(--surface-hover)]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(doc.id)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left"
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
                      if (window.confirm(`Delete "${title}"?`)) {
                        onDelete(doc.id)
                      }
                    }}
                    aria-label="Delete document"
                    title="Delete"
                    className="mr-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--error)]"
                  >
                    <TrashIcon />
                  </button>
                </li>
              )
            })}
            <li>
              <button
                type="button"
                onClick={onCreate}
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
