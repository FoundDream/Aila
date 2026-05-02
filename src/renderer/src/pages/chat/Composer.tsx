import {
  AtSignIcon,
  BotIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  SlashIcon,
  SquareIcon,
} from 'lucide-react'
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
          className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40"
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
  const barColor =
    ratio >= 0.9 ? 'bg-red-500' : ratio >= 0.75 ? 'bg-amber-500' : 'bg-[var(--text-dim)]'

  return (
    <div className="shrink-0 px-8 pb-8 pt-2">
      <div className="mx-auto max-w-[680px]">
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_18px_50px_rgba(31,31,28,0.06)] transition-colors focus-within:border-[var(--border-strong)]">
          <div className="flex min-h-8 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-soft)]/55 px-3 py-1.5">
            <ModelPicker
              configuredProviders={configuredProviders}
              selection={selection}
              onChange={onSelectionChange}
              onOpenSettings={onOpenSettings}
              recentOpenRouterModels={recentOpenRouterModels}
            />
            {showMeter && (
              <div className="flex min-w-[150px] max-w-[260px] flex-1 items-center justify-end gap-2">
                <div className="h-[3px] min-w-16 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                  {contextLength ? (
                    <div
                      className={`h-full ${barColor} transition-[width] duration-300 ease-out`}
                      style={{ width: `${Math.max(ratio * 100, 1)}%` }}
                    />
                  ) : null}
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-dim)]">
                  {contextLength
                    ? `${formatTokens(used)} / ${formatTokens(contextLength)}`
                    : formatTokens(used)}
                </span>
              </div>
            )}
          </div>

          <div className="px-4 py-3">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? 'Generating...' : 'Ask Aila anything'}
              rows={1}
              className="block min-h-9 max-h-[180px] w-full resize-none overflow-y-auto bg-transparent text-[15px] leading-[1.6] text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
            />
          </div>

          <div className="flex min-h-11 items-center justify-between gap-3 border-t border-[var(--border)] px-3 py-2">
            <div className="flex items-center gap-1">
              <ComposerToolButton label="Add context">
                <PlusIcon className="size-4" />
              </ComposerToolButton>
              <ComposerToolButton label="Attach file">
                <PaperclipIcon className="size-4" />
              </ComposerToolButton>
              <ComposerToolButton label="Mention">
                <AtSignIcon className="size-4" />
              </ComposerToolButton>
              <ComposerToolButton label="Commands">
                <SlashIcon className="size-4" />
              </ComposerToolButton>
            </div>

            <div className="flex items-center gap-2">
              <div className="hidden items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1 text-[11px] text-[var(--text-soft)] sm:flex">
                <BotIcon className="size-3.5" />
                <span className="max-w-24 truncate">Chat</span>
              </div>
              {isStreaming && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="Stop"
                      onClick={onAbort}
                      className="grid size-8 shrink-0 place-items-center rounded-md border border-[var(--border)] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                    >
                      <SquareIcon className="size-3.5 fill-current" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Stop</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={isStreaming ? 'Queue send' : 'Send'}
                    onClick={() => void submit()}
                    disabled={!canSend}
                    className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--brand-ink)] text-[var(--brand-ink-fg)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:bg-[var(--surface-hover)] disabled:text-[var(--text-dim)] disabled:opacity-100"
                  >
                    <SendIcon className="size-4" />
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
