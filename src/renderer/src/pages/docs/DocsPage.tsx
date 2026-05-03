import { type ReactElement, useState } from 'react'
import type { ChatStreamsApi } from '@/pages/chat/useChatStreams'
import type { ProviderId, Settings } from '../../types'
import { DocChatPanel } from './DocChatPanel'
import { DocEditor } from './DocEditor'
import type { DocRecord } from './types'
import type { DocsState } from './useDocs'

interface DocsPageProps {
  state: DocsState
  streams: ChatStreamsApi
  settings: Settings | null
  configuredProviders: ProviderId[]
  onUpdateSettings: (settings: Settings) => Promise<void>
  onOpenSettings: () => void
}

const PANEL_WIDTH = 360

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

export function DocsPage({
  state,
  streams,
  settings,
  configuredProviders,
  onUpdateSettings,
  onOpenSettings,
}: DocsPageProps): ReactElement {
  const { activeDoc, create, save } = state
  // Panel open state is session-only — intentionally not persisted, so the
  // user starts each session in a "writing first" mode and opts in to chat.
  const [panelOpen, setPanelOpen] = useState(false)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex h-10 shrink-0 items-center justify-end pr-3 [-webkit-app-region:drag]">
        {activeDoc && (
          <button
            type="button"
            onClick={() => setPanelOpen((v) => !v)}
            aria-label={panelOpen ? 'Close chat panel' : 'Open chat panel'}
            className="[-webkit-app-region:no-drag] flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] text-[var(--text-soft)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
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
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>{panelOpen ? 'Hide chat' : 'Ask AI'}</span>
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {activeDoc ? (
            <ActiveEditor doc={activeDoc} onSave={save} />
          ) : (
            <EmptyState onCreate={create} />
          )}
        </div>
        {activeDoc && panelOpen && (
          <div
            className="shrink-0"
            style={{ width: `${PANEL_WIDTH}px` }}
          >
            <DocChatPanel
              key={activeDoc.id}
              docId={activeDoc.id}
              streams={streams}
              settings={settings}
              configuredProviders={configuredProviders}
              onUpdateSettings={onUpdateSettings}
              onOpenSettings={onOpenSettings}
              onClose={() => setPanelOpen(false)}
            />
          </div>
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
      initialContent={doc.content}
      onChange={onSave}
    />
  )
}
