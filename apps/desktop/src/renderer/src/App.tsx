import { PanelLeftCloseIcon, PanelLeftOpenIcon, SettingsIcon } from 'lucide-react'
import { lazy, type ReactElement, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
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

const SIDEBAR_EXPANDED_STORAGE_KEY = 'app.sidebar.expanded'

function readSidebarExpanded(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

export default function App(): ReactElement {
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
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        conversationsState.deselect()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [conversationsState.deselect])

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

  return (
    <TooltipProvider delayDuration={220}>
      <div className="aila-shell flex h-full overflow-hidden text-[var(--text)]">
        <aside
          className={`aila-sidebar flex shrink-0 flex-col overflow-hidden transition-[width] duration-200 ease-out ${
            sidebarIsExpanded ? 'w-[260px]' : 'w-0'
          }`}
        >
          <div className="h-[42px] shrink-0 [-webkit-app-region:drag]" />

          {sidebarIsExpanded && (
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
          )}

          {sidebarIsExpanded && (
            <div className="shrink-0 px-1.5 pb-2">
              <div className="space-y-1 border-t border-[var(--border)] px-1 pt-2">
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[12px] text-[var(--sidebar-text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                >
                  <SettingsIcon className="size-4 text-[var(--sidebar-text-dim)]" />
                  Settings
                </button>
              </div>
            </div>
          )}
        </aside>

        <main className={`min-w-0 flex-1 p-2 ${sidebarIsExpanded ? 'pl-0' : ''}`}>
          <div className="aila-main-panel flex h-full min-h-0 flex-col overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg)]">
            <header className="relative flex h-[34px] shrink-0 items-center [-webkit-app-region:drag]">
              <div
                className={`flex min-w-0 translate-y-0.5 items-center gap-2.5 transition-[padding] duration-200 ${
                  sidebarIsExpanded ? 'px-5' : 'pl-[128px] pr-5'
                }`}
              >
                {conversationsState.activeRecord && (
                  <>
                    <span className="min-w-0 truncate text-[13.5px] font-semibold">
                      {conversationsState.activeRecord.meta.title || 'New session'}
                    </span>
                    {conversationsState.activeRecord.meta.workspace?.label && (
                      <span className="hidden truncate rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-0.5 text-[10.5px] text-[var(--text-dim)] xl:inline">
                        {conversationsState.activeRecord.meta.workspace.label}
                      </span>
                    )}
                  </>
                )}
              </div>
            </header>
            <div className="min-h-0 flex-1">
              <ChatPage
                conversation={conversationsState.activeRecord}
                onCreateConversation={conversationsState.create}
                streams={chatStreams}
                settings={settingsState?.settings ?? null}
                configuredProviders={settingsState?.configuredProviders ?? ([] as ProviderId[])}
                onUpdateSettings={updateSettings}
                onOpenSettings={() => setSettingsOpen(true)}
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
              className="fixed left-[96px] top-[13px] z-20 grid size-7 place-items-center rounded-lg text-[var(--sidebar-text-dim)] transition-colors [-webkit-app-region:no-drag] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
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
