import {
  ArrowUpIcon,
  Code2Icon,
  MessageCircleIcon,
  PlusIcon,
  SearchIcon,
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
import type {
  AgentProfile,
  AgentProfileId,
  ModelSelection,
  ProviderId,
  UsageInfo,
} from '../../types'

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
  agentProfiles?: AgentProfile[]
  agentProfileId?: AgentProfileId
  onAgentProfileChange?: (profileId: AgentProfileId) => void
  onOpenSettings: () => void
  recentOpenRouterModels: string[]
}

function profileIcon(profile: AgentProfile): ReactElement {
  const baseProfileId = profile.baseProfileId ?? profile.id
  if (baseProfileId === 'coding') return <Code2Icon className="size-3.5" />
  if (baseProfileId === 'research') return <SearchIcon className="size-3.5" />
  return <MessageCircleIcon className="size-3.5" />
}

function profileLabel(profile: AgentProfile): string {
  if (profile.id === 'coding') return 'Code'
  return profile.label
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
          className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function AgentProfileControl({
  profiles,
  value,
  onChange,
}: {
  profiles: AgentProfile[]
  value: AgentProfileId
  onChange: (profileId: AgentProfileId) => void
}): ReactElement {
  return (
    <div className="flex h-7 max-w-[min(54vw,420px)] shrink-0 items-center gap-0.5 overflow-x-auto rounded-full bg-[var(--bg-soft)] p-0.5">
      {profiles.map((profile) => {
        const active = profile.id === value
        return (
          <Tooltip key={profile.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={profile.description}
                aria-pressed={active}
                onClick={() => onChange(profile.id)}
                className={`flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] transition-colors ${
                  active
                    ? 'bg-[var(--surface)] text-[var(--text)] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
                    : 'text-[var(--text-dim)] hover:text-[var(--text)]'
                }`}
              >
                {profileIcon(profile)}
                <span className="hidden whitespace-nowrap sm:inline">{profileLabel(profile)}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{profile.description}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
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
  agentProfiles = [],
  agentProfileId,
  onAgentProfileChange,
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
              {agentProfileId && onAgentProfileChange && agentProfiles.length > 0 ? (
                <AgentProfileControl
                  profiles={agentProfiles}
                  value={agentProfileId}
                  onChange={onAgentProfileChange}
                />
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {showMeter && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className={`text-[11px] tabular-nums ${meterColor}`}>
                      {contextLength
                        ? `${formatTokens(used)} / ${formatTokens(contextLength)}`
                        : formatTokens(used)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Context used</TooltipContent>
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
