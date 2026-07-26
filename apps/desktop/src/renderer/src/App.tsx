import {
  CommandIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  SettingsIcon,
} from 'lucide-react'
import {
  lazy,
  type ReactElement,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { SettingsModal } from '@/components/SettingsModal'
import { ToolApprovalDialog } from '@/components/ToolApprovalDialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ChatPage } from '@/pages/chat/ChatPage'
import { ConversationList } from '@/pages/chat/ConversationList'
import { useChatStreams } from '@/pages/chat/useChatStreams'
import { useConversations } from '@/pages/chat/useConversations'
import {
  createToolApprovalsState,
  mergeToolApprovals,
  resolveToolApproval as resolveToolApprovalState,
  resolveToolApprovalsForConversation,
} from '@/toolApprovalsState'
import type {
  ConversationWorkspaceRef,
  ProviderId,
  Settings,
  SettingsState,
  ToolApprovalRequestEvent,
} from './types'

const WorkspaceTerminalPanel = lazy(() =>
  import('@/components/terminal/WorkspaceTerminalPanel').then((module) => ({
    default: module.WorkspaceTerminalPanel,
  })),
)

const SIDEBAR_DEFAULT_WIDTH = 240
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 320
// Dragging the handle below this raw width snaps the sidebar closed.
const SIDEBAR_COLLAPSE_THRESHOLD = 120
const SIDEBAR_WIDTH_STORAGE_KEY = 'app.sidebar.width'

function readStoredSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (raw === null) return SIDEBAR_DEFAULT_WIDTH
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed))
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

export default function App(): ReactElement {
  const [collapsed, setCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  // Hover-peek: with the sidebar collapsed, hovering the window's left edge
  // floats it over the content without un-collapsing.
  const [peeking, setPeeking] = useState(false)
  const showPeek = collapsed && peeking
  const conversationsState = useConversations()
  const chatStreams = useChatStreams(
    useMemo(
      () => ({ onConversationUpdated: conversationsState.applyUpdate }),
      [conversationsState.applyUpdate],
    ),
  )
  const [settingsState, setSettingsState] = useState<SettingsState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [terminalWorkspace, setTerminalWorkspace] = useState<ConversationWorkspaceRef | null>(null)
  const [toolApprovalsState, setToolApprovalsState] = useState(createToolApprovalsState)
  const toolApprovals = toolApprovalsState.pending
  const pendingApprovalConversationIds = useMemo(
    () =>
      new Set(
        toolApprovals
          .map((request) => request.conversationId)
          .filter((id): id is string => Boolean(id)),
      ),
    [toolApprovals],
  )

  useEffect(() => {
    void window.api.settings.get().then((state) => {
      setSettingsState(state)
      if (state.configuredProviders.length === 0) setSettingsOpen(true)
    })
  }, [])

  const updateSettings = useCallback(async (next: Settings) => {
    const saved = await window.api.settings.set(next)
    setSettingsState(saved)
  }, [])

  const openSettings = useCallback(() => setSettingsOpen(true), [])

  const openWorkspaceTerminal = useCallback((workspace: ConversationWorkspaceRef) => {
    setTerminalWorkspace(workspace)
  }, [])

  const handleRunInspectorOpen = useCallback((): void => {
    setPeeking(false)
    setCollapsed(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.tools
      .listPendingApprovals()
      .then((requests) => {
        if (!cancelled) {
          setToolApprovalsState((current) => mergeToolApprovals(current, requests))
        }
      })
      .catch((error) => {
        console.warn('[approvals] pending hydration failed:', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const cleanups = [
      window.api.tools.onApprovalRequest((request: ToolApprovalRequestEvent) => {
        setToolApprovalsState((current) => mergeToolApprovals(current, [request]))
      }),
      window.api.tools.onApprovalResolved((event) => {
        setToolApprovalsState((current) => resolveToolApprovalState(current, event.requestId))
      }),
    ]
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [])

  const resolveToolApproval = useCallback((requestId: string, approved: boolean): void => {
    window.api.tools.sendApprovalResponse({ requestId, approved })
    setToolApprovalsState((current) => resolveToolApprovalState(current, requestId))
  }, [])

  const clearConversationApprovals = useCallback((conversationId: string): void => {
    setToolApprovalsState((current) => resolveToolApprovalsForConversation(current, conversationId))
  }, [])

  // Leaving the peeked sidebar (or expanding it for real) ends the peek.
  useEffect(() => {
    if (!collapsed) setPeeking(false)
  }, [collapsed])

  // Persist width as it changes. Drag emits many updates; localStorage writes
  // are cheap enough that debouncing isn't worth the complexity.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(sidebarWidth)))
    } catch {
      // ignore quota / privacy-mode errors
    }
  }, [sidebarWidth])

  const onSidebarResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = sidebarWidth
      setResizingSidebar(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: PointerEvent): void => {
        const next = startWidth + (ev.clientX - startX)
        if (next < SIDEBAR_COLLAPSE_THRESHOLD) {
          // Dragged far enough in: snap closed. Dragging back out within the
          // same gesture re-opens at the minimum width.
          setCollapsed(true)
          return
        }
        setCollapsed(false)
        setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next)))
      }

      const onUp = (): void => {
        setResizingSidebar(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [sidebarWidth],
  )

  // ⌘\ toggles the sidebar. preventDefault so a stray backslash doesn't reach
  // a focused input/editor.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setCollapsed((c) => !c)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full bg-transparent text-[var(--text)]">
        <aside
          className={`flex shrink-0 flex-col overflow-hidden ${
            resizingSidebar ? '' : 'transition-[width] duration-200 ease-out'
          }`}
          style={{ width: collapsed ? 0 : sidebarWidth }}
        >
          {/* Full-width inner wrapper so collapsing clips the sidebar instead
              of squashing its content. While peeking, the same element floats
              over the content as a fixed overlay (position: fixed escapes the
              aside's overflow-hidden), so scroll state is preserved. */}
          <div
            className={`flex flex-col ${
              showPeek
                ? 'fixed inset-y-0 left-0 z-40 border-r border-[var(--border)] bg-[var(--surface)] shadow-xl animate-in fade-in-0 slide-in-from-left-2 duration-150'
                : 'h-full'
            }`}
            style={{ width: sidebarWidth }}
            onMouseLeave={showPeek ? () => setPeeking(false) : undefined}
          >
            {/* Keep the h-11 spacer in peek mode too so content clears the
                traffic lights; drag region only when docked. */}
            <div className={`h-11 shrink-0 ${showPeek ? '' : '[-webkit-app-region:drag]'}`} />
            <div className="flex shrink-0 items-center justify-between px-4 pb-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[var(--signal)] font-mono text-[10px] font-bold text-white shadow-[0_3px_12px_var(--signal-glow)]">
                  A
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold tracking-[-0.02em] text-[var(--text)]">
                    Aila
                  </div>
                  <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-[var(--sidebar-text-dim)]">
                    Agent workbench
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => conversationsState.deselect()}
                aria-label="New thread"
                title="New thread"
                className="grid size-7 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-soft)] shadow-[0_1px_1px_rgba(0,0,0,0.04)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
              >
                <PlusIcon className="size-3.5" />
              </button>
            </div>
            <div className="mx-3 mb-3 h-px bg-[var(--border)]" />
            <div className="flex min-h-0 flex-1 flex-col" aria-hidden={collapsed && !showPeek}>
              <ConversationList
                conversations={conversationsState.conversations}
                activeId={conversationsState.activeId}
                busyIds={chatStreams.busyIds}
                pendingApprovalIds={pendingApprovalConversationIds}
                onSelect={conversationsState.select}
                onCreate={(workspace) => {
                  void conversationsState.create(workspace)
                }}
                onCreateWorkspaceChat={() => {
                  void conversationsState.createWorkspaceChat()
                }}
                onOpenTerminal={openWorkspaceTerminal}
                onRename={(id, title) => {
                  void conversationsState.rename(id, title)
                }}
                onDelete={(id) => {
                  void (async () => {
                    try {
                      await conversationsState.remove(id)
                      clearConversationApprovals(id)
                      chatStreams.drop(id)
                    } catch (error) {
                      console.warn('[conversations] delete failed:', error)
                    }
                  })()
                }}
              />
            </div>
            <div className="mx-3 mt-2 h-px bg-[var(--border)]" />
            <div className="flex shrink-0 flex-col gap-1 px-2 pb-3 pt-2">
              <SidebarButton
                onClick={openSettings}
                label="Settings"
                icon={<SettingsIcon className="size-4" />}
              />
              <div className="flex h-7 items-center gap-2 px-2 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--sidebar-text-dim)]">
                <CommandIcon className="size-3" />
                <span>⌘ \ toggles rail</span>
              </div>
            </div>
          </div>
        </aside>
        {collapsed && !resizingSidebar && (
          // Invisible strip along the left edge that triggers the hover-peek.
          // Skipped below the title bar so the traffic lights stay clear, and
          // while resizing so a collapse-drag doesn't immediately pop it open.
          <div
            aria-hidden="true"
            onMouseEnter={() => setPeeking(true)}
            className="fixed bottom-0 left-0 top-11 z-30 w-2"
          />
        )}
        {!collapsed && (
          <div className="relative z-40 w-0 shrink-0">
            <div
              aria-hidden="true"
              title="Drag to resize"
              onPointerDown={onSidebarResizeStart}
              className="group absolute inset-y-0 -left-[2px] w-1 cursor-col-resize [-webkit-app-region:no-drag]"
            >
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-[var(--border-strong)] group-active:bg-[var(--border-strong)]" />
            </div>
          </div>
        )}
        <main
          className={`min-w-0 flex-1 bg-[var(--bg)] ${
            collapsed
              ? ''
              : 'overflow-hidden rounded-tl-[18px] border-t border-l border-[var(--border)] shadow-[-8px_0_28px_rgba(36,31,22,0.035)]'
          }`}
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <div className="h-full">
                <ChatPage
                  conversation={conversationsState.activeRecord}
                  onCreateConversation={conversationsState.create}
                  streams={chatStreams}
                  settings={settingsState?.settings ?? null}
                  configuredProviders={settingsState?.configuredProviders ?? ([] as ProviderId[])}
                  onUpdateSettings={updateSettings}
                  onOpenSettings={openSettings}
                  onRunInspectorOpen={handleRunInspectorOpen}
                />
              </div>
            </div>
            {terminalWorkspace && (
              <Suspense
                fallback={
                  <section className="flex h-[min(34vh,340px)] min-h-[220px] shrink-0 flex-col border-t border-[var(--border)] bg-[var(--surface)]">
                    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 text-[12px]">
                      <span className="font-medium text-[var(--text)]">Terminal</span>
                      <span className="text-[var(--text-dim)]">Loading...</span>
                    </header>
                    <div className="min-h-0 flex-1 bg-[var(--bg-soft)]" />
                  </section>
                }
              >
                <WorkspaceTerminalPanel
                  key={terminalWorkspace.id}
                  workspace={terminalWorkspace}
                  onClose={() => setTerminalWorkspace(null)}
                />
              </Suspense>
            )}
          </div>
        </main>
        {/* Rendered last on purpose: Electron folds -webkit-app-region rects
            into the draggable region in document order, so this button's
            no-drag carve-out must come after the drag strips it overlaps —
            otherwise clicks on it get treated as window drags. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="fixed top-[6px] left-[88px] z-50 grid size-7 place-items-center rounded-lg text-[var(--sidebar-text-dim)] transition-colors [-webkit-app-region:no-drag] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              {collapsed ? (
                <PanelLeftOpenIcon className="size-4" />
              ) : (
                <PanelLeftCloseIcon className="size-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            <span>{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</span>
            <span className="ml-2 opacity-60">{'⌘\\'}</span>
          </TooltipContent>
        </Tooltip>
        {settingsState && (
          <SettingsModal
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            settings={settingsState.settings}
            onSave={updateSettings}
          />
        )}
        <ToolApprovalDialog
          request={toolApprovals[0] ?? null}
          pendingCount={toolApprovals.length}
          onResolve={resolveToolApproval}
        />
      </div>
    </TooltipProvider>
  )
}

interface SidebarButtonProps {
  active?: boolean
  onClick: () => void
  label: string
  icon: ReactNode
}

function SidebarButton({ active = false, onClick, label, icon }: SidebarButtonProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`flex h-7 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] transition-colors ${
        active
          ? 'bg-[var(--surface-hover)] text-[var(--text)]'
          : 'text-[var(--sidebar-text-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--sidebar-text-dim)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </button>
  )
}
