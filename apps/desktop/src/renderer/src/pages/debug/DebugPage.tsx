import { FlaskConicalIcon, RefreshCwIcon } from 'lucide-react'
import { type ReactElement, useCallback, useEffect, useMemo } from 'react'
import type {
  ConversationRecord,
  ProviderConnectionSnapshot,
  ProviderId,
  Settings,
} from '../../types'
import type { ChatStreamsApi } from '../chat/useChatStreams'
import { useModelSelection } from '../chat/useModelSelection'
import { ContextPanel } from './ContextPanel'
import { DebugComposer } from './DebugComposer'
import { readableEnum } from './debugFormat'
import { messageText } from './playgroundState'
import { TranscriptCanvas } from './TranscriptCanvas'
import { PAYLOAD_AUTO_LOAD_MAX_BYTES, usePlayground } from './usePlayground'

interface DebugPageProps {
  conversation: ConversationRecord | null
  streams: ChatStreamsApi
  settings: Settings | null
  configuredProviders: ProviderId[]
  connections: ProviderConnectionSnapshot[]
  onUpdateSettings: (settings: Settings) => Promise<void>
  onOpenSettings: () => void
}

/**
 * The playground: the conversation as a constructible document ("what if the
 * state were this?") with the durable trace of every real run hanging off the
 * messages it produced ("what actually happened?").
 */
export function DebugPage({
  conversation,
  streams,
  settings,
  configuredProviders,
  connections,
  onUpdateSettings,
  onOpenSettings,
}: DebugPageProps): ReactElement {
  const conversationId = conversation?.meta.id ?? null
  const { selection, selectionRef, handleSelectionChange } = useModelSelection(
    settings,
    configuredProviders,
    connections,
    onUpdateSettings,
  )
  const api = usePlayground(conversationId)
  const { state, guards } = api

  // Keep the chat stream hydrated so playground sends merge into it and the
  // agent transcript is warm when switching back (same policy as ChatPage).
  useEffect(() => {
    if (!conversationId) return
    void streams.hydrate(conversationId)
  }, [conversationId, streams])

  const liveAssistantText = useMemo(() => {
    if (!conversationId) return null
    const stream = streams.getStream(conversationId)
    if (!stream.runningMessageId) return null
    const running = stream.messages.find((message) => message.id === stream.runningMessageId)
    if (!running || running.role !== 'assistant') return null
    return messageText(running) || null
  }, [conversationId, streams])

  const handleSubmit = useCallback(
    (text: string): void => {
      if (!conversationId) return
      const currentSelection = selectionRef.current
      if (!currentSelection) {
        onOpenSettings()
        return
      }
      if (state.injected.mode === 'default') {
        streams.enqueueSend(conversationId, text, currentSelection, [], {
          loopMode: state.loopMode,
        })
      } else {
        // The queued send path cannot carry a context override, so compose it
        // from the sanctioned primitives: persist the user message, then run
        // it via retry-last with the override attached.
        api.fabricateAndRun(text, currentSelection)
      }
    },
    [
      conversationId,
      selectionRef,
      onOpenSettings,
      state.injected.mode,
      state.loopMode,
      streams,
      api,
    ],
  )

  if (!conversationId) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[var(--bg)] px-6 text-center">
        <FlaskConicalIcon className="mb-3 size-6 text-[var(--text-dim)]" />
        <p className="text-[14px] font-semibold text-[var(--text)]">
          Select a conversation to open it in the playground
        </p>
        <p className="mt-1 max-w-sm text-[12px] text-[var(--text-dim)]">
          The playground shares conversations with the agent workbench: edit or fabricate any part
          of the transcript, run the model on the constructed state, and inspect the trace of every
          real run inline.
        </p>
      </div>
    )
  }

  const phase = state.tree?.phase

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]"
      aria-label="Playground debugger"
    >
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-[var(--border)] px-3.5">
        <FlaskConicalIcon className="size-3.5 shrink-0 text-[var(--signal)]" />
        <h2 className="truncate text-[13px] font-semibold tracking-[-0.01em]">Playground</h2>
        {phase && phase !== 'idle' && (
          <span className="shrink-0 rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-[9.5px] font-medium text-[var(--warning)]">
            {readableEnum(phase)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Refresh"
            title="Refresh"
            onClick={api.refresh}
            className="grid size-8 place-items-center rounded-lg text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <RefreshCwIcon className={`size-4 ${state.loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {state.error && (
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--error-border)] bg-[var(--error-soft)] px-5 py-2 text-[12px] text-[var(--error)]">
          <span className="truncate">{state.error}</span>
          <button type="button" onClick={api.dismissError} className="ml-4 shrink-0 font-medium">
            Dismiss
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 scrollbar-thin">
        <TranscriptCanvas
          api={api}
          liveAssistantText={liveAssistantText}
          selection={selection}
          onNeedSelection={onOpenSettings}
          autoLoadMaxBytes={PAYLOAD_AUTO_LOAD_MAX_BYTES}
        />
      </div>

      <ContextPanel injected={state.injected} onChange={api.setInjected} />

      <DebugComposer
        disabled={!guards.composerEnabled}
        disabledHint={guards.blockedReason}
        loopMode={state.loopMode}
        onLoopModeChange={api.setLoopMode}
        overrideActive={state.injected.mode !== 'default'}
        selection={selection}
        configuredProviders={configuredProviders}
        connections={connections}
        recentOpenRouterModels={settings?.recentOpenRouterModels ?? []}
        onSelectionChange={handleSelectionChange}
        onOpenSettings={onOpenSettings}
        onSubmit={handleSubmit}
      />
    </section>
  )
}
