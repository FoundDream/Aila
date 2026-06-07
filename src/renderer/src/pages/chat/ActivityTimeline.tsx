import { AlertCircleIcon, CheckCircleIcon, CircleIcon, ClockIcon, WrenchIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import type { AgentEventType, PersistedAgentEvent } from '../../types'

const HIDDEN_EVENT_TYPES = new Set<AgentEventType>(['tool.input.delta'])
const MAX_VISIBLE_EVENTS = 8

type ActivityTone = 'neutral' | 'running' | 'success' | 'warning' | 'error'

interface ActivityItem {
  title: string
  detail?: string
  tone: ActivityTone
}

function stringData(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function boolData(data: Record<string, unknown> | undefined, key: string): boolean | null {
  const value = data?.[key]
  return typeof value === 'boolean' ? value : null
}

function previewData(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key]
  if (!value || typeof value !== 'object') return null
  const preview = (value as { preview?: unknown }).preview
  return typeof preview === 'string' && preview.length > 0 ? preview : null
}

function detailData(
  data: Record<string, unknown> | undefined,
  fallbackPreviewKey?: string,
): string | undefined {
  return (
    previewData(data, 'target') ??
    (fallbackPreviewKey ? previewData(data, fallbackPreviewKey) : null) ??
    undefined
  )
}

function eventItem(event: PersistedAgentEvent): ActivityItem | null {
  const data = event.data
  const toolName = stringData(data, 'toolName')

  switch (event.type) {
    case 'turn.started':
      return { title: 'Model streaming', tone: 'running' }
    case 'turn.completed':
      return { title: 'Done', tone: 'success' }
    case 'turn.failed':
      return { title: 'Error', detail: stringData(data, 'error') ?? undefined, tone: 'error' }
    case 'turn.cancelled':
      return {
        title: stringData(data, 'phase') === 'requested' ? 'Stop requested' : 'Stopped',
        detail: stringData(data, 'reason') ?? undefined,
        tone: 'warning',
      }
    case 'turn.interrupted':
      return {
        title: 'Interrupted',
        detail: stringData(data, 'reason') ?? undefined,
        tone: 'warning',
      }
    case 'tool.requested':
      return {
        title: `Tool requested: ${toolName ?? 'tool'}`,
        detail: detailData(data),
        tone: 'running',
      }
    case 'tool.input.completed':
      return {
        title: `Args ready: ${toolName ?? 'tool'}`,
        detail: detailData(data, 'input'),
        tone: 'neutral',
      }
    case 'tool.execution.started':
      return {
        title: `Running: ${toolName ?? 'tool'}`,
        detail: detailData(data, 'input'),
        tone: 'running',
      }
    case 'tool.execution.completed':
      return {
        title: `Tool completed: ${toolName ?? 'tool'}`,
        detail: detailData(data, 'result'),
        tone: 'success',
      }
    case 'tool.execution.failed':
      return {
        title: `Tool failed: ${toolName ?? 'tool'}`,
        detail: detailData(data) ?? stringData(data, 'error') ?? undefined,
        tone: 'error',
      }
    case 'tool.result.returned':
      return {
        title: `${boolData(data, 'isError') ? 'Tool result failed' : 'Tool result returned'}: ${
          toolName ?? 'tool'
        }`,
        detail: detailData(data, 'result'),
        tone: boolData(data, 'isError') ? 'error' : 'success',
      }
    case 'tool.approval.requested': {
      const risk = stringData(data, 'risk')
      const args = previewData(data, 'target') ?? previewData(data, 'args')
      const detail = [risk, args].filter((value): value is string => Boolean(value)).join(' · ')
      return {
        title: `Approval pending: ${toolName ?? 'tool'}`,
        detail: detail || undefined,
        tone: 'warning',
      }
    }
    case 'tool.approval.resolved': {
      const approved = boolData(data, 'approved')
      return {
        title: `${approved ? 'Approved' : 'Denied'}: ${toolName ?? 'tool'}`,
        detail: stringData(data, 'reason') ?? undefined,
        tone: approved ? 'success' : 'error',
      }
    }
    default:
      return null
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function ActivityIcon({ tone }: { tone: ActivityTone }): ReactElement {
  const className =
    tone === 'success'
      ? 'text-emerald-600'
      : tone === 'warning'
        ? 'text-amber-600'
        : tone === 'error'
          ? 'text-red-600'
          : tone === 'running'
            ? 'text-blue-600'
            : 'text-[var(--text-dim)]'

  if (tone === 'success') return <CheckCircleIcon className={`size-3.5 ${className}`} />
  if (tone === 'warning') return <ClockIcon className={`size-3.5 ${className}`} />
  if (tone === 'error') return <AlertCircleIcon className={`size-3.5 ${className}`} />
  if (tone === 'running') return <WrenchIcon className={`size-3.5 ${className}`} />
  return <CircleIcon className={`size-3 ${className}`} />
}

export function ActivityTimeline({
  events,
}: {
  events: PersistedAgentEvent[]
}): ReactElement | null {
  const items = events
    .filter((event) => !HIDDEN_EVENT_TYPES.has(event.type))
    .map((event) => ({ event, item: eventItem(event) }))
    .filter(
      (entry): entry is { event: PersistedAgentEvent; item: ActivityItem } => entry.item !== null,
    )
    .slice(-MAX_VISIBLE_EVENTS)

  if (items.length === 0) return null

  return (
    <section
      aria-label="Assistant activity"
      className="shrink-0 border-t border-[var(--border)] bg-[var(--bg-soft)]/35 px-8 py-2"
    >
      <div className="mx-auto max-h-32 max-w-[680px] overflow-y-auto">
        <div className="mb-1 text-[11px] font-medium tracking-wide text-[var(--text-dim)]">
          Activity
        </div>
        <ol className="flex flex-col gap-1">
          {items.map(({ event, item }) => (
            <li
              key={`${event.timestamp}:${event.type}:${event.messageId}:${JSON.stringify(
                event.data ?? {},
              )}`}
              className="flex gap-2"
            >
              <span className="mt-[3px] shrink-0">
                <ActivityIcon tone={item.tone} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[12px] text-[var(--text)]">{item.title}</span>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--text-dim)]">
                    {formatTime(event.timestamp)}
                  </span>
                </div>
                {item.detail && (
                  <div className="truncate text-[11px] text-[var(--text-dim)]">{item.detail}</div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
