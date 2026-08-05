import type {
  RunPayload,
  RunSnapshot,
  RuntimeRunPayloadDescriptor,
  RuntimeRunSummary,
} from '../../types'

export type RunLoopState = RunSnapshot['loop']['state']
export type RunStepState = RunLoopState['steps'][number]
export type RunNextAction = RunLoopState['nextAction']
export type RunPayloadKind = RunPayload['kind']

/** Semantic tone shared by chips, dots and rails; components map it to CSS vars. */
export type StatusTone = 'ok' | 'busy' | 'hold' | 'bad' | 'muted'

export const TONE_CHIP_CLASS: Record<StatusTone, string> = {
  ok: 'bg-[var(--success-soft)] text-[var(--success)]',
  busy: 'bg-[var(--signal-soft)] text-[var(--blue)]',
  hold: 'bg-[var(--warning-soft)] text-[var(--warning)]',
  bad: 'bg-[var(--error-soft)] text-[var(--error)]',
  muted: 'bg-[var(--bg-soft)] text-[var(--text-dim)]',
}

export const TONE_DOT_CLASS: Record<StatusTone, string> = {
  ok: 'bg-[var(--success)]',
  busy: 'animate-pulse bg-[var(--signal)]',
  hold: 'bg-[var(--warning)]',
  bad: 'bg-[var(--error)]',
  muted: 'bg-[var(--border-strong)]',
}

export function toneForStatus(
  status: RuntimeRunSummary['status'] | RunStepState['status'],
): StatusTone {
  switch (status) {
    case 'completed':
      return 'ok'
    case 'running':
      return 'busy'
    case 'paused':
      return 'hold'
    case 'failed':
      return 'bad'
    default:
      return 'muted'
  }
}

export function truncatedId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function elapsed(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0 ms'
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
}

export function byteSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function tokenCount(value: number | undefined): string {
  if (value === undefined) return '—'
  return Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? 'compact' : 'standard',
  }).format(value)
}

export function toJsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function toDisplayText(value: unknown): string {
  return typeof value === 'string' ? value : toJsonText(value)
}

export function readableEnum(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase())
}

export function messageFromError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function pluckRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function pluckString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function pluckNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Timeline heading for a step; tool steps surface the tool name when recorded. */
export function stepHeading(
  step: RunStepState,
  descriptors: readonly RuntimeRunPayloadDescriptor[],
): string {
  if (step.kind === 'model') return 'Model call'
  if (step.kind === 'compact') return 'Context compaction'
  const request = descriptors.find(
    (descriptor) => descriptor.stepId === step.stepId && descriptor.kind === 'tool_request',
  )
  if (request) {
    const name = request.label.split('·')[1]?.trim()
    if (name) return name
  }
  return 'Tool call'
}

export function describeNextAction(
  action: RunNextAction | RuntimeRunSummary['nextAction'],
): string {
  if (!action) return 'nothing left to do'
  if (action.type === 'model') return `model call (${action.reason.replaceAll('_', ' ')})`
  if (action.type === 'tools') {
    return action.toolCallIds.length === 1
      ? '1 pending tool call'
      : `${action.toolCallIds.length} pending tool calls`
  }
  if (action.type === 'finalize') return `finalize run (${action.outcome})`
  return `context compaction (${action.reason.replaceAll('_', ' ')})`
}

export function describeWait(reason: string): string {
  if (reason === 'approval') return 'waiting for tool approval'
  if (reason === 'user_input') return 'waiting for user input'
  return 'paused by the debugger'
}

const PAYLOAD_NAMES: Record<string, string> = {
  model_request: 'Request',
  model_response: 'Response',
  tool_request: 'Arguments',
  tool_result: 'Result',
  tool_batch: 'Batch summary',
  compaction: 'Compaction report',
  inspection: 'Inspection data',
}

export function payloadName(kind: RunPayloadKind): string {
  return PAYLOAD_NAMES[kind] ?? 'Payload'
}

const PAYLOAD_RANK: Record<string, number> = {
  model_request: 0,
  tool_request: 0,
  model_response: 2,
  tool_result: 2,
  tool_batch: 3,
}

/** Requests sort before their responses inside a step; otherwise chronological. */
export function byPayloadOrder(
  left: RuntimeRunPayloadDescriptor,
  right: RuntimeRunPayloadDescriptor,
): number {
  return (
    left.createdAt - right.createdAt ||
    (PAYLOAD_RANK[left.kind] ?? 4) - (PAYLOAD_RANK[right.kind] ?? 4)
  )
}
