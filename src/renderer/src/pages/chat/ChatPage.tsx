import type { ReactElement } from 'react'
import { useState } from 'react'

import { DragRegion } from '@/components/DragRegion'
import { useAgentChat } from '@/hooks/useAgentChat'
import { ChatComposer } from '@/pages/chat/components/ChatComposer'
import { ChatTranscript } from '@/pages/chat/components/ChatTranscript'
import { SessionList } from '@/pages/chat/components/SessionList'
import { SetupRequiredState } from '@/pages/chat/components/SetupRequiredState'

const SIDEBAR_WIDTH = 236
const TRAFFIC_LIGHT_SPACER_WIDTH = 80

function CollapseSidebarIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

function ExpandSidebarIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function SidebarToggleButton({
  isCollapsed,
  onToggle,
}: {
  isCollapsed: boolean
  onToggle: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="flex h-6 w-6 items-center justify-center text-[var(--term-dim)] transition-colors hover:text-[var(--term-text)] focus:outline-none focus:text-[var(--term-text)] [-webkit-app-region:no-drag]"
    >
      {isCollapsed ? <ExpandSidebarIcon /> : <CollapseSidebarIcon />}
    </button>
  )
}

export function ChatPage({ onOpenSettings }: { onOpenSettings: () => void }): ReactElement | null {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const {
    activeSessionId,
    config,
    handleAbort,
    handleDeleteSession,
    handleEditQueuedPrompt,
    handleNewSession,
    handleOpenSession,
    handleRemoveQueuedPrompt,
    handleSubmitPrompt,
    isStreaming,
    messages,
    queuedCount,
    queuedPrompts,
  } = useAgentChat()

  if (!config) {
    return null
  }

  const handleToggleSidebar = (): void => {
    setIsSidebarCollapsed((current) => !current)
  }

  return (
    <div className="flex h-full flex-col bg-[var(--term-bg)] text-[var(--term-text)]">
      <div className="flex h-8 shrink-0">
        <div
          className={`flex shrink-0 items-center ${isSidebarCollapsed ? 'bg-transparent' : 'bg-[var(--term-panel)]'}`}
          style={{ width: `${SIDEBAR_WIDTH}px` }}
        >
          <div
            className="h-full shrink-0 [-webkit-app-region:drag]"
            style={{ width: `${TRAFFIC_LIGHT_SPACER_WIDTH}px` }}
          />
          <div className="flex h-full items-center [-webkit-app-region:no-drag]">
            <SidebarToggleButton isCollapsed={isSidebarCollapsed} onToggle={handleToggleSidebar} />
          </div>
          <div className="min-w-0 flex-1 [-webkit-app-region:drag]" />
        </div>

        <DragRegion className="min-w-0 flex-1 bg-[var(--term-bg)] pl-0" />
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          aria-hidden={isSidebarCollapsed}
          className={`h-full shrink-0 overflow-hidden bg-[var(--term-panel)] transition-[width,opacity,border-color] duration-200 ease-out ${
            isSidebarCollapsed
              ? 'pointer-events-none border-r border-transparent opacity-0'
              : 'border-r border-[var(--term-border)] opacity-100'
          }`}
          style={{ width: isSidebarCollapsed ? 0 : SIDEBAR_WIDTH }}
        >
          <SessionList
            onNewSession={handleNewSession}
            onSettingsClick={onOpenSettings}
            onOpen={handleOpenSession}
            onDelete={handleDeleteSession}
            activeSessionId={activeSessionId}
          />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col bg-[var(--term-bg)]">
          {!config.hasApiKey ? (
            <SetupRequiredState onSettingsClick={onOpenSettings} />
          ) : (
            <>
              <ChatTranscript isStreaming={isStreaming} messages={messages} />
              <ChatComposer
                key={activeSessionId ?? 'new-session'}
                isStreaming={isStreaming}
                queuedCount={queuedCount}
                queuedPrompts={queuedPrompts}
                onAbort={handleAbort}
                onEditQueuedPrompt={handleEditQueuedPrompt}
                onRemoveQueuedPrompt={handleRemoveQueuedPrompt}
                onSettingsClick={onOpenSettings}
                onSubmit={handleSubmitPrompt}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
