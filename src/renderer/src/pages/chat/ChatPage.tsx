import type { ReactElement } from 'react'
import { useState } from 'react'

import { useAgentChat } from '@/hooks/useAgentChat'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import { ChatComposer } from '@/pages/chat/components/ChatComposer'
import { ChatTranscript } from '@/pages/chat/components/ChatTranscript'
import { HeaderBar } from '@/pages/chat/components/HeaderBar'
import { SessionList } from '@/pages/chat/components/SessionList'
import { SetupRequiredState } from '@/pages/chat/components/SetupRequiredState'
import { SettingsPanel } from '@/pages/chat/components/settings/SettingsPanel'

export function ChatPage(): ReactElement | null {
  const {
    config,
    currentSessionPath,
    handleAbort,
    handleDeleteSession,
    handleEditQueuedPrompt,
    handleInputKeyDown,
    handleNewSession,
    handleRemoveQueuedPrompt,
    handleResumeSession,
    handleSubmit,
    input,
    isStreaming,
    messages,
    queuedCount,
    queuedPrompts,
    setInput,
  } = useAgentChat()
  const scrollRef = useAutoScroll([messages])
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (!config) {
    return null
  }

  return (
    <div className="relative flex h-full bg-[var(--term-bg)] text-[var(--term-text)]">
      <aside className="h-full w-[236px] shrink-0 overflow-hidden border-r border-[var(--term-border)] bg-[var(--term-panel)]">
        <SessionList
          variant="panel"
          onNewSession={() => void handleNewSession()}
          onSettingsClick={() => setSettingsOpen(true)}
          onResume={(path) => void handleResumeSession(path)}
          onDelete={(path) => void handleDeleteSession(path)}
          currentSessionPath={currentSessionPath}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-[var(--term-bg)]">
        <HeaderBar />

        {!config.hasApiKey ? (
          <SetupRequiredState onSettingsClick={() => setSettingsOpen(true)} />
        ) : (
          <>
            <ChatTranscript isStreaming={isStreaming} messages={messages} scrollRef={scrollRef} />
            <ChatComposer
              input={input}
              isStreaming={isStreaming}
              queuedCount={queuedCount}
              queuedPrompts={queuedPrompts}
              onAbort={() => void handleAbort()}
              onChange={setInput}
              onEditQueuedPrompt={handleEditQueuedPrompt}
              onKeyDown={handleInputKeyDown}
              onRemoveQueuedPrompt={handleRemoveQueuedPrompt}
              onSettingsClick={() => setSettingsOpen(true)}
              onSubmit={() => void handleSubmit()}
            />
          </>
        )}
      </div>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
