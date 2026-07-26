import { CheckCircle2Icon, LoaderCircleIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import type { PersistedRunEvent } from '../../types'

type ContextCompactionEvent = PersistedRunEvent & {
  type: 'context:compacting' | 'context:compacted'
}

interface ContextCompactionStatusProps {
  events: PersistedRunEvent[]
}

export function ContextCompactionStatus({
  events,
}: ContextCompactionStatusProps): ReactElement | null {
  const event = latestCompactionEvent(events)
  if (!event) return null

  const isCompacted = event.type === 'context:compacted'

  return (
    <div aria-live="polite" className="flex justify-center">
      <div className="inline-flex max-w-full items-center gap-2 rounded-full px-2 py-1 text-[12.5px] text-[var(--text-dim)]">
        {isCompacted ? (
          <CheckCircle2Icon className="size-3.5 shrink-0 text-[var(--text-dim)]" />
        ) : (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-[var(--blue)]" />
        )}
        <span className="truncate">
          {isCompacted ? 'Context compacted' : 'Compacting context...'}
        </span>
      </div>
    </div>
  )
}

function latestCompactionEvent(events: PersistedRunEvent[]): ContextCompactionEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'context:compacting' || event.type === 'context:compacted') {
      return event as ContextCompactionEvent
    }
  }
  return null
}
