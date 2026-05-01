import type { ReactElement } from 'react'
import { DocEditor } from './DocEditor'
import { type DocRecord, EMPTY_DOC_CONTENT } from './types'
import type { DocsState } from './useDocs'

interface DocsPageProps {
  state: DocsState
}

function EmptyState({ onCreate }: { onCreate: () => void }): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div
        className="text-[20px] text-[var(--text-soft)]"
        style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
      >
        No document selected
      </div>
      <div className="text-[13px] text-[var(--text-dim)]">
        Pick one from the sidebar, or start a new page.
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="mt-2 rounded-md border border-[var(--border-strong)] px-3 py-1 text-[12px] text-[var(--text-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      >
        + New document
      </button>
    </div>
  )
}

export function DocsPage({ state }: DocsPageProps): ReactElement {
  const { activeDoc, create, save } = state

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="h-10 shrink-0 [-webkit-app-region:drag]" />
      <div className="min-h-0 flex-1">
        {activeDoc ? (
          <ActiveEditor doc={activeDoc} onSave={save} />
        ) : (
          <EmptyState onCreate={create} />
        )}
      </div>
    </div>
  )
}

function ActiveEditor({
  doc,
  onSave,
}: {
  doc: DocRecord
  onSave: DocsState['save']
}): ReactElement {
  return (
    <DocEditor
      key={doc.id}
      initialTitle={doc.title}
      initialContent={
        Array.isArray(doc.content) && doc.content.length > 0 ? doc.content : EMPTY_DOC_CONTENT
      }
      onChange={onSave}
    />
  )
}
