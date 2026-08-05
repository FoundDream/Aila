import type { ModelSelection, UsageInfo } from './agent-protocol'
import { assertRunStateInvariant, type RunCursor, type RunIdentity } from './run-machine'
import type { BlobRef, RunPayloadKind } from './session-journal'

export type { RunPayloadKind } from './session-journal'

export const AILA_RUN_PAYLOAD_SCHEMA_VERSION = 1

export type RunRecoveryStrategy = 'automatic' | 'manual_review'

export interface RunRecovery {
  strategy: RunRecoveryStrategy
  reason?: string
}

/**
 * Materialized execution cursor — a read view rebuilt from the journal on
 * demand (see `rebuildRunSnapshot`). Never persisted, so it carries no schema
 * version and needs no deserialization path.
 */
export interface RunSnapshot {
  identity: RunIdentity
  assistantMessageId: string
  selection: ModelSelection
  maxToolSteps: number
  loop: RunCursor
  /** Semantic session branch used to materialize this run's context. */
  sessionLeafId: string
  contextRef: BlobRef
  usage?: UsageInfo
  recovery: RunRecovery
  revision: number
  createdAt: number
  updatedAt: number
}

/** Reader view resolved from a run.payload journal entry and its BlobRef. */
export interface RunPayload {
  schemaVersion: typeof AILA_RUN_PAYLOAD_SCHEMA_VERSION
  payloadId: string
  conversationId: string
  turnId: string
  runId: string
  stepId: string
  kind: RunPayloadKind
  createdAt: number
  contentType: 'application/json' | 'text/plain'
  data: unknown
}

export function runRecoveryFromCursor(loop: RunCursor): RunRecovery {
  if (loop.state.currentStep?.kind === 'tool' && loop.state.currentStep.status === 'running') {
    return {
      strategy: 'manual_review',
      reason: 'process stopped while a tool was running; side effects may have occurred',
    }
  }
  return { strategy: 'automatic' }
}

export function prepareRunSnapshotForResume(snapshot: RunSnapshot, timestamp: number): RunSnapshot {
  if (snapshot.identity.runId !== snapshot.loop.state.identity.runId) {
    throw new Error('run snapshot identity does not match loop snapshot')
  }
  assertRunStateInvariant(snapshot.loop.state)

  const prepared: RunSnapshot = {
    ...structuredClone(snapshot),
    recovery: runRecoveryFromCursor(snapshot.loop),
  }
  if (
    prepared.loop.state.status === 'completed' ||
    prepared.loop.state.status === 'failed' ||
    prepared.loop.state.status === 'cancelled'
  ) {
    throw new Error(`agent run is already ${prepared.loop.state.status}`)
  }
  if (prepared.recovery.strategy === 'manual_review') {
    throw new Error(prepared.recovery.reason ?? 'agent run requires manual review')
  }

  const currentStep = prepared.loop.state.currentStep
  if (currentStep?.status === 'running') {
    prepared.loop.state.steps = prepared.loop.state.steps.map((step) =>
      step.stepId === currentStep.stepId
        ? {
            ...step,
            status: 'cancelled',
            completedAt: timestamp,
            error: 'interrupted_before_resume',
          }
        : step,
    )
    prepared.loop.state.currentStep = undefined
    prepared.loop.state.nextAction =
      currentStep.kind === 'compact'
        ? { type: 'compact', reason: 'provider_overflow' }
        : { type: 'model', reason: 'retry' }
  }
  prepared.loop.state.status = 'paused'
  prepared.loop.state.wait = { reason: 'operator', detail: 'ready to resume persisted run' }
  prepared.loop.state.completedAt = undefined
  prepared.loop.state.error = undefined
  prepared.recovery = { strategy: 'automatic' }
  prepared.updatedAt = timestamp
  return prepared
}
