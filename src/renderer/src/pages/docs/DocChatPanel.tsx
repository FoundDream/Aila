import { type ReactElement, useCallback, useEffect } from 'react'
import { Composer } from '@/pages/chat/Composer'
import { Transcript } from '@/pages/chat/Transcript'
import type { ChatStreamsApi } from '@/pages/chat/useChatStreams'
import { useModelSelection } from '@/pages/chat/useModelSelection'
import type { ProviderId, Settings } from '../../types'
import { useDocConversation } from './useDocConversation'

interface DocChatPanelProps {
  docId: string
  streams: ChatStreamsApi
  settings: Settings | null
  configuredProviders: ProviderId[]
  onUpdateSettings: (settings: Settings) => Promise<void>
  onOpenSettings: () => void
  onClose: () => void
}

export function DocChatPanel({
  docId,
  streams,
  settings,
  configuredProviders,
  onUpdateSettings,
  onOpenSettings,
  onClose,
}: DocChatPanelProps): ReactElement {
  const { summary, isReady } = useDocConversation(docId)
  const conversationId = summary?.id ?? null

  const { selection, selectionRef, contextLength, handleSelectionChange } = useModelSelection(
    settings,
    configuredProviders,
    onUpdateSettings,
  )

  // Hydrate the conversation buffer once we know its id. Same pattern as
  // ChatPage; useChatStreams routes IPC events by conversationId so docs and
  // chat tabs can stream concurrently without interfering.
  useEffect(() => {
    if (!conversationId) return
    void streams.hydrate(conversationId)
  }, [conversationId, streams])

  const stream = conversationId ? streams.getStream(conversationId) : null
  const messages = stream?.messages ?? []
  const isStreaming = stream?.runningMessageId !== null && stream?.runningMessageId !== undefined
  const usage = stream?.usage ?? null

  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || !conversationId) return

      const currentSelection = selectionRef.current
      if (!currentSelection) {
        onOpenSettings()
        return
      }
      streams.enqueueSend(conversationId, trimmed, currentSelection)
    },
    [conversationId, streams, onOpenSettings, selectionRef],
  )

  const handleAbort = useCallback(() => {
    if (!conversationId) return
    streams.abort(conversationId)
  }, [conversationId, streams])

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between px-3">
        <span
          className="text-[12.5px] tracking-wide text-[var(--text-dim)]"
          style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
        >
          Chat with this doc
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat panel"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        {isReady ? (
          <>
            <Transcript messages={messages} />
            <Composer
              isStreaming={isStreaming}
              onSubmit={handleSubmit}
              onAbort={handleAbort}
              usage={usage}
              contextLength={contextLength}
              configuredProviders={configuredProviders}
              selection={selection}
              onSelectionChange={handleSelectionChange}
              onOpenSettings={onOpenSettings}
              recentOpenRouterModels={settings?.recentOpenRouterModels ?? []}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-dim)]">
            Loading conversation…
          </div>
        )}
      </main>
    </div>
  )
}
