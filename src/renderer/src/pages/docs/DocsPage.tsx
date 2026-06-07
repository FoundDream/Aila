import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ChatStreamsApi } from '@/pages/chat/useChatStreams'
import type { ProviderId, Settings } from '../../types'
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
  active: boolean
  state: DocsState
  streams: ChatStreamsApi
  settings: Settings | null
  configuredProviders: ProviderId[]
  pendingApprovalConversationIds: Set<string>
  onClearConversationApprovals: (conversationId: string) => void
  onUpdateSettings: (settings: Settings) => Promise<void>
  onOpenSettings: () => void
}

const SIDE_PANEL_DEFAULT_WIDTH = 360
const SIDE_PANEL_MIN_WIDTH = 280
const SIDE_PANEL_STORAGE_KEY = 'docs.sidePanel.width'

function EmptyState({ onCreate }: { onCreate: () => void }): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-[18px] font-medium text-[var(--text)]">No document selected</div>
      <div className="text-[13px] text-[var(--text-dim)]">
        Pick one from the sidebar, or start a new page.
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="mt-2 rounded-full border border-[var(--border)] px-3.5 py-1 text-[12.5px] text-[var(--text-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      >
        + New document
      </button>
    </div>
  )
}

export function DocsPage({
  active,
  state,
  streams,
  settings,
  configuredProviders,
  pendingApprovalConversationIds,
  onClearConversationApprovals,
  onUpdateSettings,
  onOpenSettings,
}: DocsPageProps): ReactElement {
  const { activeDoc, create, save } = state
  // Panel mode is session-only — intentionally not persisted, so the user
  // starts each session in a "writing first" mode and opts in to chat/preview.
  const [panelMode, setPanelMode] = useState<PanelMode>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('edit')
  const [tocCollapsed, setTocCollapsed] = useState(true)
  // Live mirror of the editor's title + content, updated synchronously on
  // every keystroke so the preview panel stays in sync without waiting for
  // the autosave debounce. The patch is scoped by docPath so a stale entry
  // from a previously-active doc is automatically ignored after switching.
  const [liveState, setLiveState] = useState<{
    docPath: string | null
    title?: string
    content?: string
  }>({ docPath: null })

  const closePanel = useCallback(() => setPanelMode(null), [])
  const togglePanel = useCallback(
    (mode: Exclude<PanelMode, null>) => setPanelMode((prev) => (prev === mode ? null : mode)),
    [],
  )
  const toggleToc = useCallback(() => setTocCollapsed((prev) => !prev), [])

  // Read/edit swap different scroll containers. Preserve relative position so
  // toggling read mode doesn't jump back to the top of the document.
  const pendingMainScrollRatioRef = useRef<number | null>(null)
  const [editorScrollEl, setEditorScrollEl] = useState<HTMLElement | null>(null)
  const [previewScrollEl, setPreviewScrollEl] = useState<HTMLElement | null>(null)

  const rememberMainScrollPosition = useCallback(() => {
    if (!editorScrollEl) return
    const max = editorScrollEl.scrollHeight - editorScrollEl.clientHeight
    pendingMainScrollRatioRef.current = max > 0 ? editorScrollEl.scrollTop / max : 0
  }, [editorScrollEl])

  const handleMainScrollContainer = useCallback((el: HTMLElement | null) => {
    setEditorScrollEl(el)
    if (!el || pendingMainScrollRatioRef.current === null) return

    const ratio = pendingMainScrollRatioRef.current
    pendingMainScrollRatioRef.current = null
    requestAnimationFrame(() => {
      const max = el.scrollHeight - el.clientHeight
      el.scrollTop = max > 0 ? ratio * max : 0
    })
  }, [])

  const toggleReadMode = useCallback(() => {
    rememberMainScrollPosition()
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
  }, [rememberMainScrollPosition])

  useEffect(() => {
    if (!active || !activeDoc) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return

      if (event.key === '1') {
        event.preventDefault()
        toggleReadMode()
        return
      }

      if (event.key === '2') {
        event.preventDefault()
        setPanelMode((prev) => (prev === 'preview' ? null : 'preview'))
        return
      }

      if (event.key === '3') {
        event.preventDefault()
        setPanelMode((prev) => (prev === 'chat' ? null : 'chat'))
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, activeDoc, toggleReadMode])

  const handleLiveChange = useCallback(
    (patch: { title?: string; content?: string }) => {
      const docPath = activeDoc?.path ?? null
      if (!docPath) return
      setLiveState((prev) =>
        prev.docPath === docPath ? { ...prev, ...patch } : { docPath, ...patch },
      )
    },
    [activeDoc?.path],
  )

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
              shortcut="⌘1"
            />
            <PanelToggleButton
              active={panelMode === 'preview'}
              onClick={() => togglePanel('preview')}
              icon={<EyeIcon />}
              label="Preview"
              shortcut="⌘2"
            />
            <PanelToggleButton
              active={panelMode === 'chat'}
              onClick={() => togglePanel('chat')}
              icon={<ChatIcon />}
              label="Ask AI"
              shortcut="⌘3"
            />
          </>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {activeDoc ? (
            viewMode === 'read' ? (
              <DocReadView
                key={activeDoc.path}
                title={
                  (liveState.docPath === activeDoc.path ? liveState.title : undefined) ??
                  activeDoc.title
                }
                content={
                  (liveState.docPath === activeDoc.path ? liveState.content : undefined) ??
                  activeDoc.content
                }
                tocCollapsed={tocCollapsed}
                onToggleToc={toggleToc}
                onScrollContainer={handleMainScrollContainer}
              />
            ) : (
              <ActiveEditor
                doc={activeDoc}
                onSave={save}
                onLiveChange={handleLiveChange}
                onScrollContainer={handleMainScrollContainer}
                tocCollapsed={tocCollapsed}
                onToggleToc={toggleToc}
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
              key={activeDoc.path}
              docPath={activeDoc.path}
              streams={streams}
              settings={settings}
              configuredProviders={configuredProviders}
              pendingApprovalConversationIds={pendingApprovalConversationIds}
              onClearConversationApprovals={onClearConversationApprovals}
              onUpdateSettings={onUpdateSettings}
              onOpenSettings={onOpenSettings}
              onClose={closePanel}
            />
          )}
          {activeDoc && panelMode === 'preview' && (
            <DocPreviewPanel
              title={
                (liveState.docPath === activeDoc.path ? liveState.title : undefined) ??
                activeDoc.title
              }
              content={
                (liveState.docPath === activeDoc.path ? liveState.content : undefined) ??
                activeDoc.content
              }
              onClose={closePanel}
              onScrollContainer={setPreviewScrollEl}
            />
          )}
        </SidePanel>
      </div>
    </div>
  )
}

function ActiveEditor({
  doc,
  onSave,
  onLiveChange,
  onScrollContainer,
  tocCollapsed,
  onToggleToc,
}: {
  doc: DocRecord
  onSave: DocsState['save']
  onLiveChange: (patch: { title?: string; content?: string }) => void
  onScrollContainer: (el: HTMLDivElement | null) => void
  tocCollapsed: boolean
  onToggleToc: () => void
}): ReactElement {
  return (
    <DocEditor
      key={doc.path}
      initialTitle={doc.title}
      initialContent={doc.content}
      onChange={onSave}
      onLiveChange={onLiveChange}
      onScrollContainer={onScrollContainer}
      tocCollapsed={tocCollapsed}
      onToggleToc={onToggleToc}
    />
  )
}

interface PanelToggleButtonProps {
  active: boolean
  onClick: () => void
  icon: ReactElement
  label: string
  shortcut?: string
}

function PanelToggleButton({
  active,
  onClick,
  icon,
  label,
  shortcut,
}: PanelToggleButtonProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${active ? 'Close' : 'Open'} ${label.toLowerCase()} panel`}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={`[-webkit-app-region:no-drag] flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] transition ${
        active
          ? 'bg-[var(--surface-hover)] text-[var(--text)]'
          : 'text-[var(--text-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
      }`}
    >
      {icon}
      <span>{label}</span>
      {shortcut && <span className="text-[10.5px] text-[var(--text-dim)]">{shortcut}</span>}
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
