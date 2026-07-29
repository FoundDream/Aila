import type { ModelSelection, UsageInfo } from './agent-protocol'
import { assertRunStateInvariant, type RunCursor, type RunIdentity } from './run-machine'
import type { BlobRef, RunPayloadKind } from './session-journal'

export type { RunPayloadKind } from './session-journal'

import type { AilaExecutionMode } from './tool-policy'

export const AILA_RUN_SNAPSHOT_SCHEMA_VERSION = 2
export const AILA_RUN_PAYLOAD_SCHEMA_VERSION = 1

export type RunRecoveryStrategy = 'automatic' | 'manual_review'

export interface RunRecovery {
  strategy: RunRecoveryStrategy
  reason?: string
}

/**
 * Materialized execution cursor. The session journal is the source of truth;
 * this snapshot only accelerates exact run resume.
 */
export interface RunSnapshot {
  schemaVersion: typeof AILA_RUN_SNAPSHOT_SCHEMA_VERSION
  identity: RunIdentity
  assistantMessageId: string
  selection: ModelSelection
  executionMode: AilaExecutionMode
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
  throughSeq: number
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

/** Strictly validates the only supported snapshot schema. */
export function normalizeRunSnapshot(value: unknown): RunSnapshot {
  if (!value || typeof value !== 'object') throw new Error('invalid agent run snapshot')
  const snapshot = structuredClone(value) as RunSnapshot
  if (snapshot.schemaVersion !== AILA_RUN_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`unsupported agent run snapshot schema: ${snapshot.schemaVersion}`)
  }
  if (
    !snapshot.loop?.state ||
    !snapshot.identity ||
    !snapshot.contextRef ||
    !snapshot.sessionLeafId
  ) {
    throw new Error('invalid agent run snapshot state')
  }
  if (
    !Number.isInteger(snapshot.throughSeq) ||
    snapshot.throughSeq < 0 ||
    !Number.isInteger(snapshot.revision) ||
    snapshot.revision < 1
  ) {
    throw new Error('invalid agent run snapshot revision')
  }
  assertRunStateInvariant(snapshot.loop.state)
  return snapshot
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

export function prepareRunSnapshot(snapshot: RunSnapshot, previous?: RunSnapshot): RunSnapshot {
  const normalized = normalizeRunSnapshot(snapshot)
  const normalizedPrevious = previous ? normalizeRunSnapshot(previous) : undefined
  if (normalized.identity.runId !== normalized.loop.state.identity.runId) {
    throw new Error('run snapshot identity does not match loop snapshot')
  }
  return {
    ...structuredClone(normalized),
    schemaVersion: AILA_RUN_SNAPSHOT_SCHEMA_VERSION,
    revision: normalizedPrevious
      ? Math.max(normalizedPrevious.revision + 1, normalized.revision)
      : Math.max(1, normalized.revision),
    recovery: runRecoveryFromCursor(normalized.loop),
  }
}

export function prepareRunSnapshotForResume(snapshot: RunSnapshot, timestamp: number): RunSnapshot {
  const prepared = prepareRunSnapshot(snapshot)
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

/** Normalizes a journal-backed payload reader view. */
export function prepareRunPayload(payload: RunPayload): RunPayload {
  return {
    ...structuredClone(payload),
    schemaVersion: AILA_RUN_PAYLOAD_SCHEMA_VERSION,
  }
}
