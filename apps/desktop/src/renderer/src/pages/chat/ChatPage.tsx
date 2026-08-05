import { type ReactElement, useCallback, useEffect, useState } from 'react'
import homeAssistantImage from '@/assets/home-assistant.png'
import type {
  ChatAttachmentInput,
  ConversationRecord,
  ConversationSummary,
  ConversationWorkspaceRef,
  ProviderConnectionSnapshot,
  ProviderId,
  Settings,
} from '../../types'
import { Composer } from './Composer'
import { Transcript } from './Transcript'
import type { ChatStreamsApi } from './useChatStreams'
import { useModelSelection } from './useModelSelection'

interface ChatPageProps {
  conversation: ConversationRecord | null
  draftWorkspace: ConversationWorkspaceRef | null
  onCreateConversation: (
    workspace?: ConversationWorkspaceRef | null,
  ) => Promise<ConversationSummary>
  streams: ChatStreamsApi
  settings: Settings | null
  configuredProviders: ProviderId[]
  connections: ProviderConnectionSnapshot[]
  onUpdateSettings: (settings: Settings) => Promise<void>
  onOpenSettings: () => void
}

export function ChatPage({
  conversation,
  draftWorkspace,
  onCreateConversation,
  streams,
  settings,
  configuredProviders,
  connections,
  onUpdateSettings,
  onOpenSettings,
}: ChatPageProps): ReactElement {
  const { selection, selectionRef, contextLength, handleSelectionChange } = useModelSelection(
    settings,
    configuredProviders,
    connections,
    onUpdateSettings,
  )
  const [submitScrollKey, setSubmitScrollKey] = useState(0)

  const conversationId = conversation?.meta.id ?? null

  // Hydrate on conversation switch. Switching is purely a view change, so we do
  // NOT abort the previous conversation's in-flight stream; it keeps running
  // in main and shows up the next time the user navigates back.
  useEffect(() => {
    if (!conversationId) return
    void streams.hydrate(conversationId)
  }, [conversationId, streams])

  const stream = conversationId ? streams.getStream(conversationId) : null
  const messages = stream?.messages ?? []
  const displayMessages = stream?.displayMessages ?? []
  const events = stream?.events ?? []
  const isStreaming =
    Boolean(stream?.startingRun) ||
    (stream?.runningMessageId !== null && stream?.runningMessageId !== undefined)
  const usage = stream?.usage ?? null
  const queuedRuns = stream?.queue ?? []
  const queuedCount = queuedRuns.length
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
        const summary = await onCreateConversation(draftWorkspace)
        id = summary.id
        // We just created it, and disk is empty. Mark hydrated synchronously so
        // the deferred hydrate effect doesn't race with our enqueueSend.
        streams.markHydrated(id)
      }

      streams.enqueueSend(id, trimmed, currentSelection, attachments)
      setSubmitScrollKey((key) => key + 1)
    },
    [conversationId, draftWorkspace, onCreateConversation, streams, onOpenSettings, selectionRef],
  )

  const handleAbort = useCallback(() => {
    if (!conversationId) return
    streams.abort(conversationId)
  }, [conversationId, streams])

  const handleClearQueue = useCallback(() => {
    if (!conversationId) return
    streams.clearQueue(conversationId)
  }, [conversationId, streams])

  const handleCompact = useCallback(async (): Promise<{ compacted: boolean }> => {
    if (!conversationId) return { compacted: false }
    if (isStreaming) throw new Error('Wait for the current response before compacting.')
    const currentSelection = selectionRef.current
    if (!currentSelection) {
      onOpenSettings()
      return { compacted: false }
    }
    return streams.compact(conversationId, currentSelection)
  }, [conversationId, isStreaming, streams, onOpenSettings, selectionRef])

  const handleRetryLast = useCallback(() => {
    if (!conversationId) return
    const currentSelection = selectionRef.current
    if (!currentSelection) {
      onOpenSettings()
      return
    }
    streams.enqueueRetryLast(conversationId, currentSelection)
  }, [conversationId, streams, onOpenSettings, selectionRef])

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
      onSubmit={handleSubmit}
      onCompact={handleCompact}
      onAbort={handleAbort}
      onClearQueue={handleClearQueue}
      queuedRuns={queuedRuns}
      usage={usage}
      contextLength={contextLength}
      configuredProviders={configuredProviders}
      connections={connections}
      selection={selection}
      onSelectionChange={handleSelectionChange}
      onOpenSettings={onOpenSettings}
      recentOpenRouterModels={settings?.recentOpenRouterModels ?? []}
      approvalMode={settings?.approvalMode ?? 'safe'}
      onApprovalModeChange={handleApprovalModeChange}
    />
  )

  return (
    <div className="flex h-full flex-col bg-[var(--bg)] text-[var(--text)]">
      <main className="min-h-0 flex-1 overflow-hidden">
        <section className="flex h-full min-w-0 flex-col overflow-hidden">
          {displayMessages.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col justify-center">
              <div className="mx-auto mb-12 flex w-full max-w-[720px] items-center justify-center gap-5 px-6">
                <img
                  src={homeAssistantImage}
                  alt="Aila assistant"
                  className="h-auto w-28 shrink-0 object-contain"
                />
                <h1 className="text-[36px] font-medium leading-tight tracking-[-0.035em]">
                  What will we build?
                </h1>
              </div>
              {composer}
            </div>
          ) : (
            <>
              <Transcript
                messages={displayMessages}
                events={events}
                canRetryLast={canRetryLast}
                onRetryLast={handleRetryLast}
                submitScrollKey={submitScrollKey}
              />
              {composer}
            </>
          )}
        </section>
      </main>
    </div>
  )
}
