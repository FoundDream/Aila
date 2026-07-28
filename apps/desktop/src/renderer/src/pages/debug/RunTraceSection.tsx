import type { ReactElement } from 'react'
import type { RunPayload, RuntimeRunInspection } from '../../types'
import { ExecutionTimeline } from './ExecutionTimeline'
import type { PlaygroundRunControls } from './playgroundState'

interface RunTraceSectionProps {
  runId: string
  inspection: RuntimeRunInspection | undefined
  controls: PlaygroundRunControls
  expandedStepIds: string[]
  payloads: Record<string, RunPayload>
  payloadErrors: Record<string, string>
  onToggleStep: (runId: string, stepId: string) => void
  onLoadPayload: (runId: string, payloadId: string) => void
  onStep: (runId: string) => void
  onContinue: (runId: string) => void
  onAbort: (runId: string) => void
  autoLoadMaxBytes: number
}

/** Mounts a run's step timeline inside a transcript card. */
export function RunTraceSection({
  runId,
  inspection,
  controls,
  expandedStepIds,
  payloads,
  payloadErrors,
  onToggleStep,
  onLoadPayload,
  onStep,
  onContinue,
  onAbort,
  autoLoadMaxBytes,
}: RunTraceSectionProps): ReactElement {
  if (!inspection) {
    return (
      <div className="mt-2 animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="h-3 w-40 rounded bg-[var(--surface-hover)]" />
        <div className="mt-3 h-14 rounded-md bg-[var(--bg-soft)]" />
        <span className="sr-only">Loading run trace</span>
      </div>
    )
  }
  return (
    <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 pt-3">
      <ExecutionTimeline
        embedded
        inspection={inspection}
        controls={controls}
        expandedStepIds={expandedStepIds}
        payloads={payloads}
        payloadErrors={payloadErrors}
        onToggleStep={(stepId) => onToggleStep(runId, stepId)}
        onLoadPayload={(payloadId) => onLoadPayload(runId, payloadId)}
        onStep={() => onStep(runId)}
        onContinue={() => onContinue(runId)}
        onAbort={() => onAbort(runId)}
        autoLoadMaxBytes={autoLoadMaxBytes}
      />
    </div>
  )
}
