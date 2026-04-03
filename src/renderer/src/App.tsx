import type { ReactElement } from 'react'
import { useState } from 'react'

import { ChatComposer } from '@/components/chat/ChatComposer'
import { ChatTranscript } from '@/components/chat/ChatTranscript'
import { HeaderBar } from '@/components/chat/HeaderBar'
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

  if (!config.hasApiKey) {
    return (
      <>
        <SetupRequiredState onSettingsClick={() => setSettingsOpen(true)} />
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[#0c0c0c]">
      <HeaderBar
        onNewSession={() => void handleNewSession()}
        onSettingsClick={() => setSettingsOpen(true)}
        onResumeSession={(path) => void handleResumeSession(path)}
        onDeleteSession={(path) => void handleDeleteSession(path)}
        currentSessionPath={currentSessionPath}
      />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
    </div>
  )
}
