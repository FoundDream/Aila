import { PanelLeftCloseIcon, PanelLeftOpenIcon, SettingsIcon } from 'lucide-react'
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
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

export default function App(): ReactElement {
  const [tab, setTab] = useState<Tab>('chat')
  const [collapsed, setCollapsed] = useState(false)
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
  const [toolApprovals, setToolApprovals] = useState<ToolApprovalRequestEvent[]>([])

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
    return window.api.tools.onApprovalRequest((request) => {
      setToolApprovals((current) => [...current, request])
    })
  }, [])

  const resolveToolApproval = useCallback((requestId: string, approved: boolean): void => {
    window.api.tools.sendApprovalResponse({ requestId, approved })
    setToolApprovals((current) => current.filter((request) => request.requestId !== requestId))
  }, [])

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
      <div className="flex h-full bg-[var(--bg-soft)] text-[var(--text)]">
        <aside
          className={`flex shrink-0 flex-col overflow-hidden transition-[width] duration-200 ease-out ${
            collapsed ? 'w-[80px]' : 'w-[260px]'
          }`}
        >
          <div className="h-11 shrink-0 [-webkit-app-region:drag]" />
          <nav className="flex shrink-0 flex-col gap-px px-2">
            <SidebarButton
              collapsed={collapsed}
              onClick={() => setCollapsed((c) => !c)}
              label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              shortcut="⌘\\"
              icon={
                collapsed ? (
                  <PanelLeftOpenIcon className="size-4" />
                ) : (
                  <PanelLeftCloseIcon className="size-4" />
                )
              }
            />
            {navItems.map((item) => (
              <SidebarButton
                key={item.id}
                collapsed={collapsed}
                active={tab === item.id}
                onClick={() => setTab(item.id)}
                label={item.label}
                icon={item.icon}
              />
            ))}
            <SidebarButton
              collapsed={collapsed}
              onClick={openSettings}
              label="Settings"
              icon={<SettingsIcon className="size-4" />}
            />
          </nav>
          <div
            className={
              tab === 'chat'
                ? `mt-5 flex min-h-0 flex-1 flex-col transition-opacity duration-150 ${
                    collapsed ? 'pointer-events-none opacity-0' : 'opacity-100'
                  }`
                : 'hidden'
            }
            aria-hidden={collapsed || tab !== 'chat'}
          >
            <ConversationList
              conversations={conversationsState.conversations}
              activeId={conversationsState.activeId}
              busyIds={chatStreams.busyIds}
              onSelect={conversationsState.select}
              onCreate={() => {
                void conversationsState.create()
              }}
              onDelete={(id) => {
                chatStreams.drop(id)
                void conversationsState.remove(id)
              }}
            />
          </div>
          <div
            className={
              tab === 'docs'
                ? `mt-5 flex min-h-0 flex-1 flex-col transition-opacity duration-150 ${
                    collapsed ? 'pointer-events-none opacity-0' : 'opacity-100'
                  }`
                : 'hidden'
            }
            aria-hidden={collapsed || tab !== 'docs'}
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
        </aside>
        <main className="min-w-0 flex-1 rounded-tl-lg border-t border-l border-[var(--border)] bg-[var(--bg)] shadow-[0_0_0_0.5px_rgba(0,0,0,0.02)]">
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
              onUpdateSettings={updateSettings}
              onOpenSettings={openSettings}
            />
          </div>
        </main>
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
  collapsed: boolean
  active?: boolean
  onClick: () => void
  label: string
  shortcut?: string
  icon: ReactNode
}

function SidebarButton({
  collapsed,
  active = false,
  onClick,
  label,
  shortcut,
  icon,
}: SidebarButtonProps): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <Tooltip open={collapsed && open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={`flex h-7 cursor-pointer items-center rounded-md text-[13.5px] transition-[padding,gap,background-color,color] duration-200 ease-out ${
            collapsed ? 'gap-0 pr-6 pl-6' : 'gap-2 pr-2 pl-2'
          } ${
            active
              ? 'bg-[var(--surface-hover)] text-[var(--text)]'
              : 'text-[var(--text-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
          }`}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-dim)]">
            {icon}
          </span>
          <span
            className={`min-w-0 flex-1 truncate text-left transition-opacity duration-100 ${
              collapsed ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {label}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        <span>{label}</span>
        {shortcut && <span className="ml-2 opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
