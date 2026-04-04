import type { ReactElement } from 'react'
import { useState } from 'react'

import { ChatComposer } from '@/components/chat/ChatComposer'
import { ChatTranscript } from '@/components/chat/ChatTranscript'
import { HeaderBar } from '@/components/chat/HeaderBar'
import { SessionList } from '@/components/chat/SessionList'
import { SetupRequiredState } from '@/components/chat/SetupRequiredState'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { useAgentChat } from '@/hooks/useAgentChat'
import { useAutoScroll } from '@/hooks/useAutoScroll'

export default function App(): ReactElement | null {
  const {
    config,
    currentSessionPath,
    handleAbort,
    handleDeleteSession,
    handleInputKeyDown,
    handleNewSession,
    handleResumeSession,
    handleSubmit,
    input,
    isStreaming,
    messages,
    queuedCount,
    setInput,
  } = useAgentChat()
  const scrollRef = useAutoScroll([messages])
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (!config) {
    return null
  }

  return (
    <div className="relative flex h-full bg-[#0c0c0c]">
      <aside className="h-full w-[236px] shrink-0 overflow-hidden bg-[#111111]">
        <SessionList
          variant="panel"
          onNewSession={() => void handleNewSession()}
          onSettingsClick={() => setSettingsOpen(true)}
          onResume={(path) => void handleResumeSession(path)}
          onDelete={(path) => void handleDeleteSession(path)}
          currentSessionPath={currentSessionPath}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-[#0c0c0c]">
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
              onAbort={() => void handleAbort()}
              onChange={setInput}
              onKeyDown={handleInputKeyDown}
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
