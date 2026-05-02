import { findModel, MODEL_CATALOG } from '@shared/models'
import { type ReactElement, useCallback, useEffect, useMemo, useRef } from 'react'
import type {
  ConversationRecord,
  ConversationSummary,
  ModelSelection,
  ProviderId,
  Settings,
} from '../../types'
import { Composer } from './Composer'
import { Transcript } from './Transcript'
import type { ChatStreamsApi } from './useChatStreams'

interface ChatPageProps {
  conversation: ConversationRecord | null
  onCreateConversation: () => Promise<ConversationSummary>
  streams: ChatStreamsApi
  settings: Settings | null
  configuredProviders: ProviderId[]
  onUpdateSettings: (settings: Settings) => Promise<void>
  onOpenSettings: () => void
}

function pickInitialSelection(
  settings: Settings | null,
  configured: ProviderId[],
): ModelSelection | null {
  if (!settings) return null
  const def = settings.defaultModel
  if (def && configured.includes(def.providerId)) return def
  const first = configured[0]
  if (!first) return null
  const fallback = MODEL_CATALOG.find((m) => m.providerId === first)
  return fallback ? { providerId: first, modelId: fallback.modelId } : null
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
  const selection = useMemo(
    () => pickInitialSelection(settings, configuredProviders),
    [settings, configuredProviders],
  )
  const selectionRef = useRef<ModelSelection | null>(selection)
  selectionRef.current = selection

  const contextLength = useMemo(() => {
    if (!selection) return null
    const meta = findModel(selection.providerId, selection.modelId)
    return meta?.contextLength ? meta.contextLength : null
  }, [selection])

  const handleSelectionChange = useCallback(
    (next: ModelSelection) => {
      if (!settings) return
      const update: Settings = { ...settings, defaultModel: next }
      if (next.providerId === 'openrouter') {
        const prev = settings.recentOpenRouterModels ?? []
        update.recentOpenRouterModels = [
          next.modelId,
          ...prev.filter((id) => id !== next.modelId),
        ].slice(0, 5)
      }
      void onUpdateSettings(update)
    },
    [settings, onUpdateSettings],
  )

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

      streams.enqueueSend(id, trimmed, currentSelection)
    },
    [conversationId, onCreateConversation, streams, onOpenSettings],
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
      </main>
    </div>
  )
}
