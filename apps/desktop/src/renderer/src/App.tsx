import {
  MessageSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  SettingsIcon,
  TerminalIcon,
} from 'lucide-react'
import { lazy, type ReactElement, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { SettingsModal } from '@/components/SettingsModal'
import { ToolApprovalDialog } from '@/components/ToolApprovalDialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ChatPage, type WorkbenchDisplayMode } from '@/pages/chat/ChatPage'
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

const SIDEBAR_EXPANDED_STORAGE_KEY = 'app.sidebar.expanded'

function readSidebarExpanded(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

export default function App(): ReactElement {
  const [displayMode, setDisplayMode] = useState<WorkbenchDisplayMode>('agent')
  const [sidebarExpanded, setSidebarExpanded] = useState(readSidebarExpanded)
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

  const sidebarIsExpanded = sidebarExpanded
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

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, String(sidebarExpanded))
    } catch {
      // Storage is an enhancement; private windows may reject it.
    }
  }, [sidebarExpanded])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
        event.preventDefault()
        setSidebarExpanded((expanded) => !expanded)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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

  const updateSettings = useCallback(async (next: Settings) => {
    const saved = await window.api.settings.set(next)
    setSettingsState(saved)
  }, [])

  const openWorkspaceTerminal = useCallback((workspace: ConversationWorkspaceRef) => {
    setTerminalWorkspace(workspace)
  }, [])

  const resolveToolApproval = useCallback((requestId: string, approved: boolean): void => {
    window.api.tools.sendApprovalResponse({ requestId, approved })
    setToolApprovalsState((current) => resolveToolApprovalState(current, requestId))
  }, [])

  const clearConversationApprovals = useCallback((conversationId: string): void => {
    setToolApprovalsState((current) => resolveToolApprovalsForConversation(current, conversationId))
  }, [])

  const handleDisplayModeChange = useCallback((mode: WorkbenchDisplayMode): void => {
    setDisplayMode(mode)
  }, [])

  const activeWorkspace = conversationsState.activeRecord?.meta.workspace ?? null

  return (
    <TooltipProvider delayDuration={220}>
      <div className="aila-shell flex h-full overflow-hidden text-[var(--text)]">
        <aside
          className={`aila-sidebar flex shrink-0 flex-col border-r border-[var(--border)] transition-[width] duration-200 ease-out ${
            sidebarIsExpanded ? 'w-[240px]' : 'w-12'
          }`}
        >
          <div className="h-10 shrink-0 [-webkit-app-region:drag]" />

          {sidebarIsExpanded ? (
            <>
              <div className="flex h-10 shrink-0 items-center justify-between px-3">
                <button
                  type="button"
                  onClick={() => conversationsState.deselect()}
                  className="flex min-w-0 items-center gap-2.5 text-left"
                >
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[var(--signal)] font-mono text-[10px] font-bold text-white">
                    A
                  </span>
                  <span className="truncate text-[13px] font-medium">Aila</span>
                </button>
                <button
                  type="button"
                  onClick={() => conversationsState.deselect()}
                  aria-label="New task"
                  title="New task"
                  className="grid size-7 place-items-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                >
                  <PlusIcon className="size-3.5" />
                </button>
              </div>
              <div className="mx-3 my-1.5 h-px bg-[var(--border)]" />
              <div className="min-h-0 flex-1">
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
            </>
          ) : (
            <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 px-1.5 pt-3">
              <RailButton
                active
                label="Tasks"
                icon={<MessageSquareIcon className="size-[17px]" />}
                onClick={() => {
                  setDisplayMode('agent')
                  setSidebarExpanded(true)
                }}
              />
              <RailButton
                label="New task"
                icon={<PlusIcon className="size-[17px]" />}
                onClick={() => {
                  conversationsState.deselect()
                  setDisplayMode('agent')
                  setSidebarExpanded(true)
                }}
              />
              <RailButton
                label="Terminal"
                disabled={!activeWorkspace}
                icon={<TerminalIcon className="size-[17px]" />}
                onClick={() => {
                  if (activeWorkspace) openWorkspaceTerminal(activeWorkspace)
                }}
              />
            </nav>
          )}

          <div className="shrink-0 px-1.5 pb-2">
            {sidebarIsExpanded ? (
              <div className="space-y-1 border-t border-[var(--border)] px-1 pt-2">
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[12px] text-[var(--sidebar-text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                >
                  <SettingsIcon className="size-4 text-[var(--sidebar-text-dim)]" />
                  Settings
                </button>
              </div>
            ) : (
              <RailButton
                label="Settings"
                icon={<SettingsIcon className="size-[17px]" />}
                onClick={() => setSettingsOpen(true)}
              />
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1 bg-[var(--bg)]">
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <ChatPage
                conversation={conversationsState.activeRecord}
                onCreateConversation={conversationsState.create}
                streams={chatStreams}
                settings={settingsState?.settings ?? null}
                configuredProviders={settingsState?.configuredProviders ?? ([] as ProviderId[])}
                onUpdateSettings={updateSettings}
                onOpenSettings={() => setSettingsOpen(true)}
                displayMode={displayMode}
                onDisplayModeChange={handleDisplayModeChange}
              />
            </div>
            {terminalWorkspace && (
              <Suspense
                fallback={
                  <section className="flex h-[min(34vh,340px)] min-h-[220px] shrink-0 flex-col border-t border-[var(--border)] bg-[var(--surface)]">
                    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 text-[12px]">
                      <span className="font-medium">Terminal</span>
                      <span className="text-[var(--text-dim)]">Loading…</span>
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

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setSidebarExpanded((expanded) => !expanded)}
              aria-label={sidebarIsExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
              className={`fixed top-[7px] z-50 grid size-7 place-items-center rounded-md text-[var(--sidebar-text-dim)] transition-colors [-webkit-app-region:no-drag] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] ${
                sidebarIsExpanded ? 'left-[202px]' : 'left-[10px]'
              }`}
            >
              {sidebarIsExpanded ? (
                <PanelLeftCloseIcon className="size-3.5" />
              ) : (
                <PanelLeftOpenIcon className="size-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {sidebarIsExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
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

function RailButton({
  active = false,
  disabled = false,
  label,
  icon,
  onClick,
}: {
  active?: boolean
  disabled?: boolean
  label: string
  icon: ReactElement
  onClick: () => void
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
          className={`grid size-9 place-items-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-25 ${
            active
              ? 'border-[var(--signal-border)] bg-[var(--signal-soft)] text-[var(--signal)]'
              : 'border-transparent text-[var(--sidebar-text-dim)] hover:border-[var(--border)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
          }`}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}
