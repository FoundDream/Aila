import { type ReactElement, useCallback, useEffect, useState } from 'react'
import type {
  AgentProfileId,
  ConversationRecord,
  ConversationSummary,
  ProviderId,
  Settings,
} from '../../types'
import { Composer } from './Composer'
import { Transcript } from './Transcript'
import type { ChatStreamsApi } from './useChatStreams'
import { useModelSelection } from './useModelSelection'

interface ChatPageProps {
  conversation: ConversationRecord | null
  onCreateConversation: () => Promise<ConversationSummary>
  streams: ChatStreamsApi
  settings: Settings | null
  configuredProviders: ProviderId[]
  onUpdateSettings: (settings: Settings) => Promise<void>
  onOpenSettings: () => void
}

const CHAT_PROFILE_STORAGE_KEY = 'chat.agentProfile'

function readStoredProfile(): AgentProfileId {
  if (typeof window === 'undefined') return 'chat'
  const stored = window.localStorage.getItem(CHAT_PROFILE_STORAGE_KEY)
  return stored === 'research' || stored === 'coding' ? stored : 'chat'
}

export function ChatPage({
  conversation,
  onCreateConversation,
  streams,
  settings,
  configuredProviders,
  onUpdateSettings,
  onOpenSettings,
}: ChatPageProps): ReactElement {
  const [profileId, setProfileId] = useState<AgentProfileId>(readStoredProfile)
  const { selection, selectionRef, contextLength, handleSelectionChange } = useModelSelection(
    settings,
    configuredProviders,
    onUpdateSettings,
  )

  const conversationId = conversation?.meta.id ?? null

  // Hydrate on conversation switch. Switching is purely a view change — we do
  // NOT abort the previous conversation's in-flight stream; it keeps running
  // in main and shows up the next time the user navigates back.
  useEffect(() => {
    if (!conversationId) return
    void streams.hydrate(conversationId)
  }, [conversationId, streams])

  useEffect(() => {
    window.localStorage.setItem(CHAT_PROFILE_STORAGE_KEY, profileId)
  }, [profileId])

  const stream = conversationId ? streams.getStream(conversationId) : null
  const messages = stream?.messages ?? []
  const isStreaming = stream?.runningMessageId !== null && stream?.runningMessageId !== undefined
  const usage = stream?.usage ?? null
  const queuedCount = stream?.queue.length ?? 0

  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return

      const currentSelection = selectionRef.current
      if (!currentSelection) {
        onOpenSettings()
        return
      }

      let id = conversationId
      if (!id) {
        const summary = await onCreateConversation()
        id = summary.id
        // We just created it — disk is empty. Mark hydrated synchronously so
        // the deferred hydrate effect doesn't race with our enqueueSend.
        streams.markHydrated(id)
      }

      streams.enqueueSend(id, trimmed, currentSelection, profileId)
    },
    [
      conversationId,
      onCreateConversation,
      streams,
      onOpenSettings,
      profileId,
      selectionRef.current,
    ],
  )

  const handleAbort = useCallback(() => {
    if (!conversationId) return
    streams.abort(conversationId)
  }, [conversationId, streams])

  return (
    <div className="flex h-full flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="flex h-10 shrink-0 items-center justify-center [-webkit-app-region:drag]">
        <span
          className="text-[13px] italic tracking-wide text-[var(--text-dim)]"
          style={{ fontFamily: 'var(--font-serif)' }}
        >
          Aila
        </span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <Transcript messages={messages} />
        <Composer
          isStreaming={isStreaming}
          queuedCount={queuedCount}
          onSubmit={handleSubmit}
          onAbort={handleAbort}
          usage={usage}
          contextLength={contextLength}
          configuredProviders={configuredProviders}
          selection={selection}
          onSelectionChange={handleSelectionChange}
          agentProfileId={profileId}
          onAgentProfileChange={setProfileId}
          onOpenSettings={onOpenSettings}
          recentOpenRouterModels={settings?.recentOpenRouterModels ?? []}
        />
      </main>
    </div>
  )
}
