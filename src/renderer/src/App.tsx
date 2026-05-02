import { SettingsIcon } from 'lucide-react'
import { type ReactElement, useCallback, useEffect, useState } from 'react'
import { SettingsModal } from '@/components/SettingsModal'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ChatPage } from '@/pages/chat/ChatPage'
import { ConversationList } from '@/pages/chat/ConversationList'
import { useConversations } from '@/pages/chat/useConversations'
import { DocList } from '@/pages/docs/DocList'
import { DocsPage } from '@/pages/docs/DocsPage'
import { useDocs } from '@/pages/docs/useDocs'
import type { ProviderId, Settings, SettingsState } from './types'

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
  const docsState = useDocs()
  const conversationsState = useConversations()
  const [settingsState, setSettingsState] = useState<SettingsState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

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

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full bg-[var(--bg-soft)] text-[var(--text)]">
        <aside className="flex w-[260px] shrink-0 flex-col">
          <div className="h-11 shrink-0 [-webkit-app-region:drag]" />
          <nav className="flex shrink-0 flex-col gap-px px-2">
            {navItems.map((item) => {
              const isActive = tab === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[13.5px] transition ${
                    isActive
                      ? 'bg-[var(--surface-hover)] text-[var(--text)]'
                      : 'text-[var(--text-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
                  }`}
                >
                  <span className="flex h-4 w-4 items-center justify-center text-[var(--text-dim)]">
                    {item.icon}
                  </span>
                  <span className="flex-1 text-left">{item.label}</span>
                </button>
              )
            })}
            <button
              type="button"
              onClick={openSettings}
              className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[13.5px] text-[var(--text-soft)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              <span className="flex h-4 w-4 items-center justify-center text-[var(--text-dim)]">
                <SettingsIcon className="size-4" />
              </span>
              <span className="flex-1 text-left">Settings</span>
            </button>
          </nav>
          {tab === 'chat' && (
            <div className="mt-5 flex min-h-0 flex-1 flex-col">
              <ConversationList
                conversations={conversationsState.conversations}
                activeId={conversationsState.activeId}
                onSelect={conversationsState.select}
                onCreate={() => {
                  void conversationsState.create()
                }}
                onDelete={(id) => {
                  void conversationsState.remove(id)
                }}
              />
            </div>
          )}
          {tab === 'docs' && (
            <div className="mt-5 flex min-h-0 flex-1 flex-col">
              <DocList
                docs={docsState.docs}
                activeId={docsState.activeId}
                onSelect={docsState.select}
                onCreate={docsState.create}
                onDelete={docsState.remove}
              />
            </div>
          )}
        </aside>
        <main className="min-w-0 flex-1 rounded-tl-lg border-t border-l border-[var(--border)] bg-[var(--bg)] shadow-[0_0_0_0.5px_rgba(0,0,0,0.02)]">
          {tab === 'chat' ? (
            <ChatPage
              conversation={conversationsState.activeRecord}
              onCreateConversation={conversationsState.create}
              onAppendMessage={conversationsState.appendMessage}
              settings={settingsState?.settings ?? null}
              configuredProviders={settingsState?.configuredProviders ?? ([] as ProviderId[])}
              onUpdateSettings={updateSettings}
              onOpenSettings={openSettings}
            />
          ) : (
            <DocsPage state={docsState} />
          )}
        </main>
        {settingsState && (
          <SettingsModal
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            settings={settingsState.settings}
            onSave={updateSettings}
          />
        )}
      </div>
    </TooltipProvider>
  )
}
