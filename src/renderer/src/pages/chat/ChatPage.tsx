import type { ReactElement } from 'react'

import { useAgentChat } from '@/hooks/useAgentChat'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import { ChatComposer } from '@/pages/chat/components/ChatComposer'
import { ChatTranscript } from '@/pages/chat/components/ChatTranscript'
import { HeaderBar } from '@/pages/chat/components/HeaderBar'
import { SessionList } from '@/pages/chat/components/SessionList'
import { SetupRequiredState } from '@/pages/chat/components/SetupRequiredState'

export function ChatPage({ onOpenSettings }: { onOpenSettings: () => void }): ReactElement | null {
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
  const scrollRef = useAutoScroll([messages])

  if (!config) {
    return null
  }

  return (
    <div className="relative flex h-full bg-[var(--term-bg)] text-[var(--term-text)]">
      <aside className="h-full w-[236px] shrink-0 overflow-hidden border-r border-[var(--term-border)] bg-[var(--term-panel)]">
        <SessionList
          onNewSession={handleNewSession}
          onSettingsClick={onOpenSettings}
          onOpen={handleOpenSession}
          onDelete={handleDeleteSession}
          activeSessionId={activeSessionId}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-[var(--term-bg)]">
        <HeaderBar />

        {!config.hasApiKey ? (
          <SetupRequiredState onSettingsClick={onOpenSettings} />
        ) : (
          <>
            <ChatTranscript isStreaming={isStreaming} messages={messages} scrollRef={scrollRef} />
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
  )
}
