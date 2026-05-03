import type { EditorView } from '@codemirror/view'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ChatStreamsApi } from '@/pages/chat/useChatStreams'
import type {
  DocEditFindReplace,
  DocEditRequestEvent,
  DocEditResult,
} from '../../../../preload/index'
import type { ProviderId, Settings } from '../../types'
import { AiEditToast } from './AiEditToast'
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

// Validate every old_string against the live view content before dispatching
// any change. Same uniqueness contract as src/main/find-replace.ts —
// duplicated here because the live source is the EditorView, not the disk.
function planChanges(
  body: string,
  edits: DocEditFindReplace[],
):
  | { ok: true; changes: { from: number; to: number; insert: string }[] }
  | { ok: false; error: string } {
  const changes: { from: number; to: number; insert: string }[] = []
  for (let i = 0; i < edits.length; i++) {
    const { old_string, new_string } = edits[i]
    if (typeof old_string !== 'string' || old_string.length === 0) {
      return { ok: false, error: `edit #${i}: \`old_string\` must be a non-empty string` }
    }
    if (typeof new_string !== 'string') {
      return { ok: false, error: `edit #${i}: \`new_string\` must be a string` }
    }
    let count = 0
    let from = 0
    let firstIdx = -1
    while (true) {
      const idx = body.indexOf(old_string, from)
      if (idx === -1) break
      if (firstIdx === -1) firstIdx = idx
      count++
      from = idx + old_string.length
    }
    if (count === 0) {
      return {
        ok: false,
        error: `edit #${i}: \`old_string\` not found (must match byte-for-byte, including whitespace)`,
      }
    }
    if (count > 1) {
      return {
        ok: false,
        error: `edit #${i}: \`old_string\` matches ${count} times — include more surrounding context to be unique`,
      }
    }
    changes.push({
      from: firstIdx,
      to: firstIdx + old_string.length,
      insert: new_string,
    })
  }
  // Sort changes by `from` ascending — CodeMirror requires monotonically
  // non-decreasing positions in a single transaction.
  changes.sort((a, b) => a.from - b.from)
  return { ok: true, changes }
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
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  // Ref to the active doc's CodeMirror EditorView, captured from MarkdownEditor
  // via onCreateView. Used to apply AI-driven edits as a single transaction
  // (one undo step) without going through disk first.
  const viewRef = useRef<EditorView | null>(null)
  // Track which doc the captured view belongs to, since onCreateView fires
  // independently of the activeDoc prop.
  const viewDocIdRef = useRef<string | null>(null)
  // Mirror activeDoc.id in a ref so the IPC handler closure sees the latest
  // value without re-subscribing.
  const activeDocIdRef = useRef<string | null>(null)
  activeDocIdRef.current = activeDoc?.id ?? null

  const handleCreateView = useCallback((view: EditorView, docId: string) => {
    viewRef.current = view
    viewDocIdRef.current = docId
  }, [])

  useEffect(() => {
    const off = window.api.docs.onEditRequest(async (req: DocEditRequestEvent) => {
      const result = await applyEditRequest(req)
      window.api.docs.sendEditResponse({ requestId: req.requestId, ...result })
      if (result.ok) {
        const isLive = req.docId === activeDocIdRef.current && viewDocIdRef.current === req.docId
        setToastMessage(isLive ? 'Edited by AI' : `Edited "${result.title}"`)
      }
    })
    return off
  }, [])

  const applyEditRequest = useCallback(
    async (req: DocEditRequestEvent): Promise<DocEditResult> => {
      // Live path: target doc is currently mounted in the editor. Apply via
      // CodeMirror transaction so the change participates in undo history and
      // the existing autosave debounce naturally writes it to disk.
      if (
        req.docId === activeDocIdRef.current &&
        viewRef.current &&
        viewDocIdRef.current === req.docId
      ) {
        const view = viewRef.current
        const body = view.state.doc.toString()
        const planned = planChanges(body, req.edits)
        if (!planned.ok) return { ok: false, error: planned.error }
        view.dispatch({
          changes: planned.changes,
          userEvent: 'input.ai-edit',
        })
        return {
          ok: true,
          title: activeDoc?.title ?? '',
          appliedCount: planned.changes.length,
        }
      }
      // Inactive doc: fall back to main's disk-only path.
      return window.api.docs.applyEditDirect(req.docId, req.edits)
    },
    [activeDoc?.title],
  )

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
            <ActiveEditor
              doc={activeDoc}
              onSave={save}
              onCreateView={(view) => handleCreateView(view, activeDoc.id)}
            />
          ) : (
            <EmptyState onCreate={create} />
          )}
        </div>
        {activeDoc && panelOpen && (
          <div className="shrink-0" style={{ width: `${PANEL_WIDTH}px` }}>
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
      <AiEditToast message={toastMessage} onDismiss={() => setToastMessage(null)} />
    </div>
  )
}

function ActiveEditor({
  doc,
  onSave,
  onCreateView,
}: {
  doc: DocRecord
  onSave: DocsState['save']
  onCreateView: (view: EditorView) => void
}): ReactElement {
  return (
    <DocEditor
      key={doc.id}
      initialTitle={doc.title}
      initialContent={doc.content}
      onChange={onSave}
      onCreateView={onCreateView}
    />
  )
}
