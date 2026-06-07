import { ArrowUpIcon, PlusIcon, SquareIcon } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { ModelPicker } from '@/components/ModelPicker'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ModelSelection, ProviderId, UsageInfo } from '../../types'

interface ComposerProps {
  isStreaming: boolean
  // Sends typed mid-stream pile up here. Surfaced as a small badge so the
  // user can see their input was accepted and not silently dropped.
  queuedCount?: number
  onSubmit: (text: string) => Promise<void> | void
  onAbort: () => void
  usage?: UsageInfo | null
  contextLength?: number | null
  configuredProviders: ProviderId[]
  selection: ModelSelection | null
  onSelectionChange: (selection: ModelSelection) => void
  onOpenSettings: () => void
  recentOpenRouterModels: string[]
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 10_000) return `${(n / 1000).toFixed(2)}k`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function ContextRing({ ratio }: { ratio: number }): ReactElement {
  const r = 7
  const circumference = 2 * Math.PI * r
  // Keep a sliver visible once anything has been used so the indicator
  // doesn't read as "empty" at the start of a conversation.
  const shown = ratio > 0 ? Math.max(ratio, 0.04) : 0
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - shown)}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

function ComposerToolButton({
  label,
  children,
  disabled = false,
  onClick,
}: {
  label: string
  children: ReactElement
  disabled?: boolean
  onClick?: () => void
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function Composer({
  isStreaming,
  queuedCount = 0,
  onSubmit,
  onAbort,
  usage,
  contextLength,
  configuredProviders,
  selection,
  onSelectionChange,
  onOpenSettings,
  recentOpenRouterModels,
}: ComposerProps): ReactElement {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Sends always succeed even while streaming — they're queued and fire after
  // the current run finishes. The Stop button is the way to interrupt.
  const submit = useCallback(async () => {
    const text = value
    if (!text.trim()) return
    setValue('')
    await onSubmit(text)
  }, [value, onSubmit])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
  })

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        void submit()
      }
    },
    [submit],
  )

  const canSend = value.trim().length > 0

  const used = usage?.totalTokens ?? 0
  const ratio = contextLength && contextLength > 0 ? Math.min(used / contextLength, 1) : 0
  const showMeter = (contextLength ?? 0) > 0 || used > 0
  const meterColor =
    ratio >= 0.9 ? 'text-red-500' : ratio >= 0.75 ? 'text-amber-500' : 'text-[var(--text-dim)]'

  return (
    <div className="shrink-0 px-6 pb-6 pt-2">
      <div className="mx-auto max-w-[680px]">
        <div className="rounded-[24px] border border-[var(--border)] bg-[var(--surface)] shadow-[0_2px_16px_rgba(0,0,0,0.04)] transition-shadow focus-within:border-[var(--border-strong)] focus-within:shadow-[0_4px_24px_rgba(0,0,0,0.07)]">
          {queuedCount > 0 && (
            <div className="px-4 pt-2.5">
              <span
                aria-live="polite"
                title={`${queuedCount} message${queuedCount > 1 ? 's' : ''} queued`}
                className="inline-flex items-center rounded-full bg-[var(--bg-soft)] px-2.5 py-0.5 text-[11px] text-[var(--text-soft)]"
              >
                {queuedCount} queued
              </span>
            </div>
          )}

          <div className="px-4 pb-1 pt-3">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? 'Generating...' : 'Ask Aila anything'}
              rows={1}
              className="block min-h-7 max-h-[180px] w-full resize-none overflow-y-auto bg-transparent text-[15px] leading-[1.6] text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
            />
          </div>

          <div className="flex min-h-12 items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <ComposerToolButton label="Attach file">
                <PlusIcon className="size-[18px]" />
              </ComposerToolButton>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {showMeter && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="img"
                      aria-label="Context used"
                      className={`inline-flex ${meterColor}`}
                    >
                      <ContextRing ratio={ratio} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="flex flex-col gap-0.5">
                      <span>
                        {contextLength
                          ? `Context: ${formatTokens(used)} / ${formatTokens(contextLength)} (${Math.round(ratio * 100)}%)`
                          : `Context: ${formatTokens(used)} tokens`}
                      </span>
                      {usage && (
                        <span className="opacity-60">
                          Prompt {formatTokens(usage.promptTokens)} · Completion{' '}
                          {formatTokens(usage.completionTokens)}
                        </span>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
              <ModelPicker
                configuredProviders={configuredProviders}
                selection={selection}
                onChange={onSelectionChange}
                onOpenSettings={onOpenSettings}
                recentOpenRouterModels={recentOpenRouterModels}
              />
              {isStreaming ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="Stop"
                      onClick={onAbort}
                      className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--brand-ink)] text-[var(--brand-ink-fg)] transition-opacity hover:opacity-85"
                    >
                      <SquareIcon className="size-3 fill-current" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Stop</TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={isStreaming ? 'Queue send' : 'Send'}
                    onClick={() => void submit()}
                    disabled={!canSend}
                    className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--brand-ink)] text-[var(--brand-ink-fg)] transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:bg-[var(--surface-hover)] disabled:text-[var(--text-dim)]"
                  >
                    <ArrowUpIcon className="size-4" strokeWidth={2.4} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{isStreaming ? 'Send (queued)' : 'Send'}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
