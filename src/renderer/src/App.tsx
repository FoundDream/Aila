import { PanelLeftCloseIcon, PanelLeftOpenIcon, SettingsIcon } from 'lucide-react'
import {
  type ReactElement,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
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
import { DocList } from '@/pages/docs/DocList'
import { DocsPage } from '@/pages/docs/DocsPage'
import { useDocs } from '@/pages/docs/useDocs'
import {
  createToolApprovalsState,
  mergeToolApprovals,
  resolveToolApproval as resolveToolApprovalState,
  resolveToolApprovalsForConversation,
} from '@/toolApprovalsState'
import type { ProviderId, Settings, SettingsState, ToolApprovalRequestEvent } from './types'

type Tab = 'chat' | 'docs'

interface NavItem {
  id: Tab
  label: string
  icon: ReactElement
}

const navItems: NavItem[] = [
  {
    id: 'chat',
    label: 'Chat',
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    ),
  },
  {
    id: 'docs',
    label: 'Docs',
    icon: (
      <svg
        width="16"
        height="16"
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
        <path d="M9 13h6" />
        <path d="M9 17h6" />
      </svg>
    ),
  },
]

const SIDEBAR_DEFAULT_WIDTH = 260
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
  const [tab, setTab] = useState<Tab>('chat')
  const [collapsed, setCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  // Hover-peek: with the sidebar collapsed, hovering the window's left edge
  // floats it over the content without un-collapsing.
  const [peeking, setPeeking] = useState(false)
  const showPeek = collapsed && peeking
  const docsState = useDocs()
  const conversationsState = useConversations()
  const chatStreams = useChatStreams(
    useMemo(
      () => ({ onConversationUpdated: conversationsState.applyUpdate }),
      [conversationsState.applyUpdate],
    ),
  )
  const [settingsState, setSettingsState] = useState<SettingsState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
            <nav className="flex shrink-0 flex-col gap-px px-2">
              {navItems.map((item) => (
                <SidebarButton
                  key={item.id}
                  active={tab === item.id}
                  onClick={() => setTab(item.id)}
                  label={item.label}
                  icon={item.icon}
                />
              ))}
            </nav>
            <div
              className={tab === 'chat' ? 'mt-5 flex min-h-0 flex-1 flex-col' : 'hidden'}
              aria-hidden={(collapsed && !showPeek) || tab !== 'chat'}
            >
              <ConversationList
                conversations={conversationsState.conversations}
                activeId={conversationsState.activeId}
                busyIds={chatStreams.busyIds}
                pendingApprovalIds={pendingApprovalConversationIds}
                onSelect={conversationsState.select}
                onCreate={() => {
                  void conversationsState.create()
                }}
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
            <div
              className={tab === 'docs' ? 'mt-5 flex min-h-0 flex-1 flex-col' : 'hidden'}
              aria-hidden={(collapsed && !showPeek) || tab !== 'docs'}
            >
              <DocList
                docs={docsState.docs}
                folders={docsState.folders}
                activePath={docsState.activePath}
                onSelect={docsState.select}
                onCreateDoc={docsState.create}
                onDeleteDoc={docsState.remove}
                onMoveDoc={docsState.move}
                onCreateFolder={docsState.createFolder}
                onRenameFolder={docsState.renameFolder}
                onMoveFolder={docsState.moveFolder}
                onDeleteFolder={docsState.deleteFolder}
              />
            </div>
            <div className="flex shrink-0 flex-col px-2 pb-3 pt-1">
              <SidebarButton
                onClick={openSettings}
                label="Settings"
                icon={<SettingsIcon className="size-4" />}
              />
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
              : 'overflow-hidden rounded-tl-xl border-t border-l border-[var(--border)] shadow-[0_1px_4px_rgba(0,0,0,0.03)]'
          }`}
        >
          <div className={tab === 'chat' ? 'h-full' : 'hidden'}>
            <ChatPage
              conversation={conversationsState.activeRecord}
              onCreateConversation={conversationsState.create}
              streams={chatStreams}
              settings={settingsState?.settings ?? null}
              configuredProviders={settingsState?.configuredProviders ?? ([] as ProviderId[])}
              onUpdateSettings={updateSettings}
              onOpenSettings={openSettings}
            />
          </div>
          <div className={tab === 'docs' ? 'h-full' : 'hidden'}>
            <DocsPage
              active={tab === 'docs'}
              state={docsState}
              streams={chatStreams}
              settings={settingsState?.settings ?? null}
              configuredProviders={settingsState?.configuredProviders ?? ([] as ProviderId[])}
              pendingApprovalConversationIds={pendingApprovalConversationIds}
              onClearConversationApprovals={clearConversationApprovals}
              onUpdateSettings={updateSettings}
              onOpenSettings={openSettings}
            />
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
              className="fixed top-[6px] left-[88px] z-50 grid size-7 place-items-center rounded-lg text-[var(--text-dim)] transition-colors [-webkit-app-region:no-drag] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
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
          : 'text-[var(--text-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-dim)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </button>
  )
}
