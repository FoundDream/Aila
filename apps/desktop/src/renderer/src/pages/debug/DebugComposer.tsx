import { SendIcon, StepForwardIcon } from 'lucide-react'
import { type KeyboardEvent, type ReactElement, useCallback, useState } from 'react'
import { ModelPicker } from '@/components/ModelPicker'
import type { ModelSelection, ProviderConnectionSnapshot, ProviderId } from '../../types'
import type { PlaygroundLoopMode } from './playgroundState'

interface DebugComposerProps {
  disabled: boolean
  /** Shown instead of the input hint while the composer is disabled. */
  disabledHint: string | null
  loopMode: PlaygroundLoopMode
  onLoopModeChange: (loopMode: PlaygroundLoopMode) => void
  /** Rendered when the injected-context override applies to this send. */
  overrideActive: boolean
  selection: ModelSelection | null
  configuredProviders: ProviderId[]
  connections: ProviderConnectionSnapshot[]
  recentOpenRouterModels: string[]
  onSelectionChange: (next: ModelSelection) => void
  onOpenSettings: () => void
  onSubmit: (text: string) => void
}

/**
 * Lean playground composer. Attachments, compaction and approval-mode chrome
 * stay in the chat Composer; this one only starts recorded runs.
 */
export function DebugComposer({
  disabled,
  disabledHint,
  loopMode,
  onLoopModeChange,
  overrideActive,
  selection,
  configuredProviders,
  connections,
  recentOpenRouterModels,
  onSelectionChange,
  onOpenSettings,
  onSubmit,
}: DebugComposerProps): ReactElement {
  const [text, setText] = useState('')

  const submit = useCallback((): void => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSubmit(trimmed)
    setText('')
  }, [text, disabled, onSubmit])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submit()
      }
    },
    [submit],
  )

  return (
    <footer className="shrink-0 border-t border-[var(--border)] bg-[var(--bg)] px-4 py-3">
      <div className="mx-auto w-full max-w-[1080px]">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--textarea)] focus-within:border-[var(--border-strong)]">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder={
              loopMode === 'step'
                ? 'Send a message in step mode — the run pauses after every step'
                : 'Send a message — the run executes to completion'
            }
            className="block w-full resize-none bg-transparent px-3.5 pt-3 text-[13px] leading-relaxed text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none"
          />
          <div className="flex items-center justify-between gap-3 px-2.5 pb-2">
            <div className="flex items-center gap-2">
              <ModelPicker
                configuredProviders={configuredProviders}
                connections={connections}
                selection={selection}
                onChange={onSelectionChange}
                onOpenSettings={onOpenSettings}
                recentOpenRouterModels={recentOpenRouterModels}
              />
              <div className="flex rounded-lg bg-[var(--bg-soft)] p-0.5">
                {(
                  [
                    ['step', 'Step'],
                    ['continuous', 'Continuous'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onLoopModeChange(mode)}
                    className={`rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
                      loopMode === mode
                        ? 'bg-[var(--bg)] text-[var(--text)] shadow-[var(--shadow-xs)]'
                        : 'text-[var(--text-dim)] hover:text-[var(--text-soft)]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {overrideActive && (
                <span className="rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-[9.5px] font-medium text-[var(--warning)]">
                  context override active
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10.5px] text-[var(--text-dim)]">
                {disabled && disabledHint
                  ? disabledHint
                  : 'Enter to send · Shift+Enter for newline'}
              </span>
              <button
                type="button"
                onClick={submit}
                disabled={disabled || text.trim().length === 0}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--signal)] bg-[var(--signal)] px-3 text-[11.5px] font-medium text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
              >
                {loopMode === 'step' ? (
                  <StepForwardIcon className="size-3.5" />
                ) : (
                  <SendIcon className="size-3.5" />
                )}
                Send{loopMode === 'step' ? ' · step mode' : ''}
              </button>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
