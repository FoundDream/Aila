import { FoldVerticalIcon, PlayIcon, PlusIcon, Undo2Icon } from 'lucide-react'
import type { ReactElement } from 'react'
import type { ModelSelection } from '../../types'
import { MessageCard } from './MessageCard'
import { deriveRunControls, type MessageRole, type TranscriptCard } from './playgroundState'
import { RunTraceSection } from './RunTraceSection'
import type { PlaygroundApi } from './usePlayground'

interface TranscriptCanvasProps {
  api: PlaygroundApi
  /** Streaming text of the in-flight assistant turn, when any. */
  liveAssistantText: string | null
  selection: ModelSelection | null
  onNeedSelection: () => void
  autoLoadMaxBytes: number
}

/**
 * The playground canvas: the conversation as an editable document. Committed
 * and fabricated messages are the same kind of card; the difference is whether
 * a trace hangs underneath. The tail is where hypotheses start — fabricate a
 * message or run the model on the constructed state.
 */
export function TranscriptCanvas({
  api,
  liveAssistantText,
  selection,
  onNeedSelection,
  autoLoadMaxBytes,
}: TranscriptCanvasProps): ReactElement {
  const { state, cards, guards, activeRunId } = api

  const runWithSelection = (): void => {
    if (!selection) {
      onNeedSelection()
      return
    }
    api.runFromLeaf(selection)
  }

  return (
    <div className="mx-auto w-full max-w-[880px] space-y-2.5 pb-6">
      {cards.length === 0 && !activeRunId && (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)] px-6 py-10 text-center">
          <p className="text-[13px] font-semibold text-[var(--text)]">Empty conversation</p>
          <p className="mt-1 text-[11.5px] text-[var(--text-dim)]">
            Fabricate a message below to construct a state, or send one from the composer.
          </p>
        </div>
      )}

      {cards.map((card, index) => {
        if (card.kind === 'context-marker') {
          return (
            <div
              key={card.entryId}
              className="flex items-center gap-2 px-2 text-[10.5px] text-[var(--text-dim)]"
            >
              <FoldVerticalIcon className="size-3 shrink-0" />
              <span>{card.markerLabel}</span>
              <span className="h-px flex-1 bg-[var(--border)]" />
              {guards.canMutate && (
                <button
                  type="button"
                  title="Rewind to this point"
                  onClick={() => api.rewindTo(card.entryId)}
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                >
                  <Undo2Icon className="size-3" />
                  Rewind here
                </button>
              )}
            </div>
          )
        }
        const message = card.message
        if (!message) return null
        const resolution = message.role === 'assistant' ? api.resolveRun(index) : null
        const run = resolution?.run ?? null
        const candidates = resolution?.candidates ?? []
        const traceAvailable = run !== null || candidates.length > 0
        const traceExpanded = state.expandedTraceKeys.includes(message.id)
        const traceRunIds = run ? [run.identity.runId] : candidates.map((c) => c.identity.runId)
        return (
          <MessageCard
            key={card.entryId}
            card={card}
            mutable={guards.canMutate}
            draftText={state.draft?.entryId === card.entryId ? state.draft.text : null}
            run={run}
            traceAvailable={traceAvailable}
            traceExpanded={traceExpanded}
            onStartEdit={() => api.startDraft(card.entryId, message ? messageDraftText(card) : '')}
            onChangeDraft={api.changeDraft}
            onCancelEdit={api.cancelDraft}
            onSaveEdit={() => api.saveDraft(card)}
            onRewind={() => card.parentEntryId && api.rewindTo(card.parentEntryId)}
            onToggleTrace={() => api.toggleTrace(message.id, traceRunIds)}
          >
            {run ? (
              <RunTraceSection
                runId={run.identity.runId}
                inspection={state.inspections[run.identity.runId]}
                controls={deriveRunControls(state, run.identity.runId)}
                expandedStepIds={state.expandedStepIds[run.identity.runId] ?? []}
                payloads={state.payloads}
                payloadErrors={state.payloadErrors}
                onToggleStep={api.toggleStep}
                onLoadPayload={api.loadPayload}
                onStep={api.stepRun}
                onContinue={api.continueRun}
                onAbort={api.abortRun}
                autoLoadMaxBytes={autoLoadMaxBytes}
              />
            ) : (
              <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[11px] text-[var(--text-dim)]">
                Resolving which run produced this message…
              </div>
            )}
          </MessageCard>
        )
      })}

      {activeRunId && (
        <article className="rounded-xl border border-[var(--signal)] bg-[var(--surface)] px-3.5 py-3">
          <header className="flex items-center gap-2">
            <span className="rounded-full bg-[var(--bg-soft)] px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--text-soft)]">
              assistant
            </span>
            <span className="flex items-center gap-1.5 text-[10px] font-medium text-[var(--blue)]">
              <span className="size-1.5 animate-pulse rounded-full bg-[var(--signal)]" />
              live run
            </span>
          </header>
          {liveAssistantText && (
            <div className="mt-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[var(--text)]">
              {liveAssistantText}
            </div>
          )}
          <RunTraceSection
            runId={activeRunId}
            inspection={state.inspections[activeRunId]}
            controls={deriveRunControls(state, activeRunId)}
            expandedStepIds={state.expandedStepIds[activeRunId] ?? []}
            payloads={state.payloads}
            payloadErrors={state.payloadErrors}
            onToggleStep={api.toggleStep}
            onLoadPayload={api.loadPayload}
            onStep={api.stepRun}
            onContinue={api.continueRun}
            onAbort={api.abortRun}
            autoLoadMaxBytes={autoLoadMaxBytes}
          />
        </article>
      )}

      {guards.canMutate &&
        (state.insertDraft ? (
          <InsertEditor
            role={state.insertDraft.role}
            text={state.insertDraft.text}
            onChange={api.changeInsert}
            onCancel={api.cancelInsert}
            onSave={api.saveInsert}
          />
        ) : (
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => api.startInsert('assistant')}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-[var(--border-strong)] px-3 text-[11.5px] font-medium text-[var(--text-dim)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
            >
              <PlusIcon className="size-3.5" />
              Fabricate message
            </button>
            {guards.canRunFromLeaf && (
              <button
                type="button"
                onClick={runWithSelection}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--signal)] bg-[var(--signal)] px-3 text-[11.5px] font-medium text-white transition-all hover:brightness-110"
              >
                <PlayIcon className="size-3.5" />
                Run · {state.loopMode === 'step' ? 'step' : 'continuous'}
              </button>
            )}
          </div>
        ))}
    </div>
  )
}

function messageDraftText(card: TranscriptCard): string {
  if (!card.message) return ''
  return card.message.blocks
    .filter((block) => block.type === 'text' && 'content' in block)
    .map((block) => ('content' in block ? block.content : ''))
    .join('\n')
}

function InsertEditor({
  role,
  text,
  onChange,
  onCancel,
  onSave,
}: {
  role: MessageRole
  text: string
  onChange: (patch: { role?: MessageRole; text?: string }) => void
  onCancel: () => void
  onSave: () => void
}): ReactElement {
  return (
    <div className="rounded-xl border border-[var(--warning-border)] bg-[var(--surface)] px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[10.5px] font-medium text-[var(--warning)]">
          Fabricating a message
        </span>
        <div className="ml-auto flex rounded-lg bg-[var(--bg-soft)] p-0.5">
          {(['user', 'assistant'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onChange({ role: option })}
              className={`rounded-md px-2.5 py-1 text-[10.5px] font-medium transition-colors ${
                role === option
                  ? 'bg-[var(--bg)] text-[var(--text)] shadow-[var(--shadow-xs)]'
                  : 'text-[var(--text-dim)] hover:text-[var(--text-soft)]'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <textarea
        value={text}
        onChange={(event) => onChange({ text: event.target.value })}
        rows={3}
        placeholder={
          role === 'assistant'
            ? 'Write what the assistant "said" — the model will believe it did'
            : 'Write a user message without running the model on it yet'
        }
        className="mt-2 block w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--textarea)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--border-strong)]"
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="h-7 rounded-md border border-[var(--border)] px-2.5 text-[11px] font-medium text-[var(--text-soft)] hover:text-[var(--text)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={text.trim().length === 0}
          className="h-7 rounded-md border border-[var(--warning)] bg-[var(--warning)] px-2.5 text-[11px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
        >
          Append
        </button>
      </div>
    </div>
  )
}
