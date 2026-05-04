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
import { DocPreviewPanel } from './DocPreviewPanel'
import { DocReadView } from './DocReadView'
import { SidePanel } from './SidePanel'
import type { DocRecord } from './types'
import type { DocsState } from './useDocs'

type PanelMode = 'chat' | 'preview' | null
type ViewMode = 'edit' | 'read'

interface DocsPageProps {
  state: DocsState
  streams: ChatStreamsApi
  settings: Settings | null
  configuredProviders: ProviderId[]
  onUpdateSettings: (settings: Settings) => Promise<void>
  onOpenSettings: () => void
}

const SIDE_PANEL_DEFAULT_WIDTH = 360
const SIDE_PANEL_MIN_WIDTH = 280
const SIDE_PANEL_STORAGE_KEY = 'docs.sidePanel.width'

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
  // Panel mode is session-only — intentionally not persisted, so the user
  // starts each session in a "writing first" mode and opts in to chat/preview.
  const [panelMode, setPanelMode] = useState<PanelMode>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('edit')
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  // Live mirror of the editor's title + content, updated synchronously on
  // every keystroke so the preview panel stays in sync without waiting for
  // the autosave debounce. The patch is scoped by docId so a stale entry
  // from a previously-active doc is automatically ignored after switching.
  const [liveState, setLiveState] = useState<{
    docId: string | null
    title?: string
    content?: string
  }>({ docId: null })

  const closePanel = useCallback(() => setPanelMode(null), [])
  const togglePanel = useCallback(
    (mode: Exclude<PanelMode, null>) => setPanelMode((prev) => (prev === mode ? null : mode)),
    [],
  )

  const toggleReadMode = useCallback(() => {
    setViewMode((prev) => {
      if (prev === 'edit') {
        // Entering read mode: close the right-side preview if open, since
        // showing the same content twice (full-width read + narrow preview)
        // is redundant and just eats horizontal space.
        setPanelMode((m) => (m === 'preview' ? null : m))
        return 'read'
      }
      return 'edit'
    })
  }, [])

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

  const handleLiveChange = useCallback((patch: { title?: string; content?: string }) => {
    const docId = activeDocIdRef.current
    if (!docId) return
    setLiveState((prev) => (prev.docId === docId ? { ...prev, ...patch } : { docId, ...patch }))
  }, [])

  // Scroll containers for the editor and preview, captured via callback refs.
  // When both are mounted (preview mode is open), wire up two-way ratio sync.
  const [editorScrollEl, setEditorScrollEl] = useState<HTMLElement | null>(null)
  const [previewScrollEl, setPreviewScrollEl] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!editorScrollEl || !previewScrollEl) return
    let syncing = false
    const sync = (source: HTMLElement, target: HTMLElement) => (): void => {
      if (syncing) return
      const sourceMax = source.scrollHeight - source.clientHeight
      const targetMax = target.scrollHeight - target.clientHeight
      if (sourceMax <= 0 || targetMax <= 0) return
      const ratio = source.scrollTop / sourceMax
      syncing = true
      target.scrollTop = ratio * targetMax
      // Release the lock after the browser dispatches the resulting scroll
      // event so the target's listener doesn't bounce it back.
      requestAnimationFrame(() => {
        syncing = false
      })
    }
    const onEditor = sync(editorScrollEl, previewScrollEl)
    const onPreview = sync(previewScrollEl, editorScrollEl)
    editorScrollEl.addEventListener('scroll', onEditor, { passive: true })
    previewScrollEl.addEventListener('scroll', onPreview, { passive: true })
    // Initial alignment so preview matches the editor's current scroll
    // position when it first opens.
    onEditor()
    return () => {
      editorScrollEl.removeEventListener('scroll', onEditor)
      previewScrollEl.removeEventListener('scroll', onPreview)
    }
  }, [editorScrollEl, previewScrollEl])

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
      <div className="relative flex h-10 shrink-0 items-center justify-end gap-1 pr-3 [-webkit-app-region:drag]">
        {activeDoc && (
          <>
            <PanelToggleButton
              active={viewMode === 'read'}
              onClick={toggleReadMode}
              icon={<BookIcon />}
              label="Read"
            />
            <PanelToggleButton
              active={panelMode === 'preview'}
              onClick={() => togglePanel('preview')}
              icon={<EyeIcon />}
              label="Preview"
            />
            <PanelToggleButton
              active={panelMode === 'chat'}
              onClick={() => togglePanel('chat')}
              icon={<ChatIcon />}
              label="Ask AI"
            />
          </>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {activeDoc ? (
            viewMode === 'read' ? (
              <DocReadView
                key={activeDoc.id}
                title={
                  (liveState.docId === activeDoc.id ? liveState.title : undefined) ??
                  activeDoc.title
                }
                content={
                  (liveState.docId === activeDoc.id ? liveState.content : undefined) ??
                  activeDoc.content
                }
                onScrollContainer={setEditorScrollEl}
              />
            ) : (
              <ActiveEditor
                doc={activeDoc}
                onSave={save}
                onLiveChange={handleLiveChange}
                onCreateView={(view) => handleCreateView(view, activeDoc.id)}
                onScrollContainer={setEditorScrollEl}
              />
            )
          ) : (
            <EmptyState onCreate={create} />
          )}
        </div>
        <SidePanel
          open={Boolean(activeDoc) && panelMode !== null}
          storageKey={SIDE_PANEL_STORAGE_KEY}
          defaultWidth={SIDE_PANEL_DEFAULT_WIDTH}
          minWidth={SIDE_PANEL_MIN_WIDTH}
        >
          {activeDoc && panelMode === 'chat' && (
            <DocChatPanel
              key={activeDoc.id}
              docId={activeDoc.id}
              streams={streams}
              settings={settings}
              configuredProviders={configuredProviders}
              onUpdateSettings={onUpdateSettings}
              onOpenSettings={onOpenSettings}
              onClose={closePanel}
            />
          )}
          {activeDoc && panelMode === 'preview' && (
            <DocPreviewPanel
              title={
                (liveState.docId === activeDoc.id ? liveState.title : undefined) ?? activeDoc.title
              }
              content={
                (liveState.docId === activeDoc.id ? liveState.content : undefined) ??
                activeDoc.content
              }
              onClose={closePanel}
              onScrollContainer={setPreviewScrollEl}
            />
          )}
        </SidePanel>
      </div>
      <AiEditToast message={toastMessage} onDismiss={() => setToastMessage(null)} />
    </div>
  )
}

function ActiveEditor({
  doc,
  onSave,
  onLiveChange,
  onCreateView,
  onScrollContainer,
}: {
  doc: DocRecord
  onSave: DocsState['save']
  onLiveChange: (patch: { title?: string; content?: string }) => void
  onCreateView: (view: EditorView) => void
  onScrollContainer: (el: HTMLDivElement | null) => void
}): ReactElement {
  return (
    <DocEditor
      key={doc.id}
      initialTitle={doc.title}
      initialContent={doc.content}
      onChange={onSave}
      onLiveChange={onLiveChange}
      onCreateView={onCreateView}
      onScrollContainer={onScrollContainer}
    />
  )
}

interface PanelToggleButtonProps {
  active: boolean
  onClick: () => void
  icon: ReactElement
  label: string
}

function PanelToggleButton({ active, onClick, icon, label }: PanelToggleButtonProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${active ? 'Close' : 'Open'} ${label.toLowerCase()} panel`}
      className={`[-webkit-app-region:no-drag] flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] transition ${
        active
          ? 'bg-[var(--surface-hover)] text-[var(--text)]'
          : 'text-[var(--text-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function BookIcon(): ReactElement {
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
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}

function EyeIcon(): ReactElement {
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
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function ChatIcon(): ReactElement {
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
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}
