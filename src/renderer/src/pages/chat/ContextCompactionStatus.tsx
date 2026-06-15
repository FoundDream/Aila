import { ArchiveIcon, CheckCircle2Icon, LoaderCircleIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import type { PersistedAgentEvent } from '../../types'

type ContextCompactionEvent = PersistedAgentEvent & {
  type: 'context:compacting' | 'context:compacted'
}

interface ContextCompactionStatusProps {
  events: PersistedAgentEvent[]
}

export function ContextCompactionStatus({
  events,
}: ContextCompactionStatusProps): ReactElement | null {
  const event = latestCompactionEvent(events)
  if (!event) return null

  const data = event.data
  const isCompacted = event.type === 'context:compacted'
  const checkpointId = stringData(data, 'checkpointId')
  const trigger = stringData(data, 'trigger')
  const reason = stringData(data, 'reason')
  const sourceMessages = numberData(data, 'sourceMessageCount')
  const omittedRounds = numberData(data, 'omittedRoundCount')
  const selectedRounds = numberData(data, 'selectedRoundCount')
  const estimatedInputTokens =
    numberData(data, 'preflightInputTokens') ?? numberData(data, 'estimatedInputTokens')
  const inputBudgetTokens = numberData(data, 'inputBudgetTokens')
  const remainingInputTokens = numberData(data, 'remainingInputTokens')
  const sourceEstimatedTokens = numberData(data, 'sourceEstimatedTokens')
  const checkpointEstimatedTokens = numberData(data, 'checkpointEstimatedTokens')
  const estimatedSavedTokens = numberData(data, 'estimatedSavedTokens')
  const summaryChars = numberData(data, 'summaryChars')
  const artifactFileCount = numberData(data, 'artifactFileCount')
  const artifactToolResultCount = numberData(data, 'artifactToolResultCount')
  const compactArtifactSource = stringData(data, 'compactArtifactSource')
  const compactArtifactFallbackReason = stringData(data, 'compactArtifactFallbackReason')

  const metrics = [
    trigger ? labelValue('Trigger', formatTrigger(trigger)) : null,
    reason ? labelValue('Reason', formatReason(reason)) : null,
    compactArtifactSource
      ? labelValue('Artifact', formatArtifactSource(compactArtifactSource))
      : null,
    compactArtifactFallbackReason
      ? labelValue('Fallback', formatReason(compactArtifactFallbackReason))
      : null,
    sourceMessages !== null
      ? labelValue('Covered', `${formatInteger(sourceMessages)} messages`)
      : omittedRounds !== null
        ? labelValue('Covered', `${formatInteger(omittedRounds)} rounds`)
        : null,
    selectedRounds !== null ? labelValue('Kept', `${formatInteger(selectedRounds)} recent`) : null,
    estimatedSavedTokens !== null
      ? labelValue('Saved', `~${formatTokens(estimatedSavedTokens)} tokens`)
      : null,
    sourceEstimatedTokens !== null && checkpointEstimatedTokens !== null
      ? labelValue(
          'Compression',
          `${formatTokens(sourceEstimatedTokens)} -> ${formatTokens(checkpointEstimatedTokens)}`,
        )
      : null,
    estimatedInputTokens !== null && inputBudgetTokens !== null
      ? labelValue(
          'Input',
          `${formatTokens(estimatedInputTokens)} / ${formatTokens(inputBudgetTokens)}`,
        )
      : null,
    remainingInputTokens !== null
      ? labelValue('Left', `${formatTokens(remainingInputTokens)} tokens`)
      : null,
    summaryChars !== null ? labelValue('Summary', `${formatInteger(summaryChars)} chars`) : null,
    artifactFileCount !== null && artifactFileCount > 0
      ? labelValue('Files', formatInteger(artifactFileCount))
      : null,
    artifactToolResultCount !== null && artifactToolResultCount > 0
      ? labelValue('Tool outputs', formatInteger(artifactToolResultCount))
      : null,
  ].filter((item): item is { label: string; value: string } => item !== null)

  return (
    <div className="shrink-0 px-6 pb-2">
      <section
        aria-live="polite"
        className="mx-auto max-w-[680px] rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-soft)_84%,var(--surface))] px-3.5 py-2.5 text-[12px] text-[var(--text-soft)] shadow-[0_1px_8px_rgba(0,0,0,0.035)]"
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] ${
              isCompacted ? 'text-[var(--blue)]' : 'text-[var(--text-dim)]'
            }`}
          >
            {isCompacted ? (
              <CheckCircle2Icon className="size-3.5" />
            ) : (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-[var(--text)]">
                {isCompacted ? 'Context compacted' : 'Compacting context'}
              </span>
              {checkpointId && (
                <span className="inline-flex min-w-0 items-center gap-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[10.5px] leading-none text-[var(--text-dim)]">
                  <ArchiveIcon className="size-3" />
                  <span className="truncate">{shortId(checkpointId)}</span>
                </span>
              )}
            </div>
            <p className="mt-1 leading-snug text-[var(--text-dim)]">
              {isCompacted
                ? compactArtifactSource === 'model'
                  ? 'Older turns are available through a model-generated checkpoint summary.'
                  : 'Older turns are available through the checkpoint summary.'
                : 'Summarizing older turns into a checkpoint before continuing.'}
            </p>
            {metrics.length > 0 && (
              <dl className="mt-2 flex flex-wrap gap-1.5">
                {metrics.map((metric) => (
                  <div
                    key={`${metric.label}:${metric.value}`}
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 leading-none"
                  >
                    <dt className="text-[10.5px] uppercase tracking-[0.04em] text-[var(--text-dim)]">
                      {metric.label}
                    </dt>
                    <dd className="truncate font-medium text-[var(--text-soft)]">{metric.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function latestCompactionEvent(events: PersistedAgentEvent[]): ContextCompactionEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'context:compacting' || event.type === 'context:compacted') {
      return event as ContextCompactionEvent
    }
  }
  return null
}

function labelValue(label: string, value: string): { label: string; value: string } {
  return { label, value }
}

function stringData(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberData(data: Record<string, unknown> | undefined, key: string): number | null {
  const value = data?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatTrigger(value: string): string {
  if (value === 'manual') return 'manual'
  if (value === 'auto') return 'auto'
  return value
}

function formatReason(value: string): string {
  return value.replaceAll('_', ' ')
}

function formatArtifactSource(value: string): string {
  if (value === 'model') return 'model'
  if (value === 'heuristic') return 'heuristic'
  return value
}

function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 14)}...` : value
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString()
}

function formatTokens(value: number): string {
  const rounded = Math.max(0, Math.round(value))
  if (rounded >= 1_000_000) return `${trimDecimal(rounded / 1_000_000)}M`
  if (rounded >= 1_000) return `${trimDecimal(rounded / 1_000)}k`
  return rounded.toLocaleString()
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '')
}
