import { type ReactElement, useCallback, useEffect, useState } from 'react'
import type {
  ChatAttachmentInput,
  ConversationRecord,
  ConversationSummary,
  ConversationWorkspaceRef,
  ProviderId,
  Settings,
} from '../../types'
import { Composer } from './Composer'
import { Transcript } from './Transcript'
import type { ChatStreamsApi } from './useChatStreams'
import { useModelSelection } from './useModelSelection'

interface ChatPageProps {
  conversation: ConversationRecord | null
  onCreateConversation: (
    workspace?: ConversationWorkspaceRef | null,
  ) => Promise<ConversationSummary>
  streams: ChatStreamsApi
  settings: Settings | null
  configuredProviders: ProviderId[]
  onUpdateSettings: (settings: Settings) => Promise<void>
  onOpenSettings: () => void
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
  const { selection, selectionRef, contextLength, handleSelectionChange } = useModelSelection(
    settings,
    configuredProviders,
    onUpdateSettings,
  )
  const [submitScrollKey, setSubmitScrollKey] = useState(0)

  const conversationId = conversation?.meta.id ?? null

  // Hydrate on conversation switch. Switching is purely a view change — we do
  // NOT abort the previous conversation's in-flight stream; it keeps running
  // in main and shows up the next time the user navigates back.
  useEffect(() => {
    if (!conversationId) return
    void streams.hydrate(conversationId)
  }, [conversationId, streams])

  const stream = conversationId ? streams.getStream(conversationId) : null
  const messages = stream?.messages ?? []
  const isStreaming = stream?.runningMessageId !== null && stream?.runningMessageId !== undefined
  const usage = stream?.usage ?? null
  const queuedCount = stream?.queue.length ?? 0
  const lastMessage = messages.at(-1)
  const hasRetryableLastTurn =
    lastMessage?.role === 'user' ||
    (lastMessage?.role === 'assistant' && lastMessage.status === 'error')
  const canRetryLast =
    Boolean(conversationId) && !isStreaming && queuedCount === 0 && hasRetryableLastTurn

  const handleSubmit = useCallback(
    async (text: string, attachments: ChatAttachmentInput[]) => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return

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

      streams.enqueueSend(id, trimmed, currentSelection, attachments)
      setSubmitScrollKey((key) => key + 1)
    },
    [conversationId, onCreateConversation, streams, onOpenSettings, selectionRef.current],
  )

  const handleAbort = useCallback(() => {
    if (!conversationId) return
    streams.abort(conversationId)
  }, [conversationId, streams])

  const handleRetryLast = useCallback(() => {
    if (!conversationId) return
    const currentSelection = selectionRef.current
    if (!currentSelection) {
      onOpenSettings()
      return
    }
    streams.enqueueRetryLast(conversationId, currentSelection)
  }, [conversationId, streams, onOpenSettings, selectionRef.current])

  const handleApprovalModeChange = useCallback(
    async (approvalMode: NonNullable<Settings['approvalMode']>) => {
      if (!settings) {
        onOpenSettings()
        return
      }
      await onUpdateSettings({ ...settings, approvalMode })
    },
    [settings, onUpdateSettings, onOpenSettings],
  )

  const composer = (
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
      onOpenSettings={onOpenSettings}
      recentOpenRouterModels={settings?.recentOpenRouterModels ?? []}
      approvalMode={settings?.approvalMode ?? 'safe'}
      onApprovalModeChange={handleApprovalModeChange}
    />
  )

  return (
    <div className="flex h-full flex-col text-[var(--text)]">
      <header className="flex h-10 shrink-0 items-center justify-center px-8 [-webkit-app-region:drag]">
        <span className="max-w-[60%] truncate text-[13px] font-medium text-[var(--text-soft)]">
          {conversation?.meta.title ?? ''}
        </span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        {messages.length === 0 ? (
          // New-chat hero: prompt + composer sit together at the vertical
          // center; pb offsets the h-10 header so it reads optically centered.
          <div className="flex min-h-0 flex-1 flex-col justify-center pb-20">
            <p className="mb-4 text-center text-[22px] font-medium text-[var(--text)]">
              What can I help with?
            </p>
            {composer}
          </div>
        ) : (
          <>
            <Transcript
              messages={messages}
              canRetryLast={canRetryLast}
              onRetryLast={handleRetryLast}
              submitScrollKey={submitScrollKey}
            />
            {composer}
          </>
        )}
      </main>
    </div>
  )
}
