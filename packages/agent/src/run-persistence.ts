import type { ChatMessage, ModelSelection, UsageInfo } from './agent-protocol'
import type { AgentContextPlan } from './context'
import type { PersistedMessage } from './conversation-core'
import type { ModelCallToolCall } from './model-call'
import {
  assertRunStateInvariant,
  type RunCursor,
  type RunIdentity,
  type RunNextAction,
  type RunWait,
} from './run-machine'
import type { AilaExecutionMode } from './tool-policy'

export const AILA_RUN_CHECKPOINT_SCHEMA_VERSION = 2
export const AILA_RUN_ARTIFACT_SCHEMA_VERSION = 2

export type RunRecoveryStrategy = 'automatic' | 'manual_review'

export interface RunRecovery {
  strategy: RunRecoveryStrategy
  reason?: string
}

/**
 * Durable execution cursor. Unlike a prompt-compaction checkpoint, this record
 * contains everything required to continue the same run after process restart.
 */
export interface RunCheckpoint {
  schemaVersion: typeof AILA_RUN_CHECKPOINT_SCHEMA_VERSION
  identity: RunIdentity
  assistantMessageId: string
  selection: ModelSelection
  executionMode: AilaExecutionMode
  maxToolSteps: number
  loop: RunCursor<ModelCallToolCall>
  messages: ChatMessage[]
  modelStepOutputs: Record<string, string>
  contextPlan?: AgentContextPlan
  assistantMessage: PersistedMessage
  usage?: UsageInfo
  plan?: {
    id: string
    operation?: 'create' | 'revise' | 'implement'
  }
  recovery: RunRecovery
  revision: number
  createdAt: number
  updatedAt: number
  lastEventSeq?: number
}

function normalizeNextAction(value: unknown): RunNextAction | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (
    record.type === 'model' &&
    (record.reason === 'user' ||
      record.reason === 'tool_results' ||
      record.reason === 'retry' ||
      record.reason === 'steer' ||
      record.reason === 'resume' ||
      record.reason === 'provider_overflow')
  ) {
    return { type: 'model', reason: record.reason }
  }
  if (
    record.type === 'tools' &&
    Array.isArray(record.toolCallIds) &&
    record.toolCallIds.every((id) => typeof id === 'string')
  ) {
    return { type: 'tools', toolCallIds: [...record.toolCallIds] as string[] }
  }
  if (
    record.type === 'compact' &&
    (record.reason === 'preflight' || record.reason === 'provider_overflow')
  ) {
    return { type: 'compact', reason: record.reason }
  }
  return undefined
}

function normalizeWaitState(value: unknown): RunWait | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.reason !== 'debug' && record.reason !== 'approval' && record.reason !== 'user_input') {
    return undefined
  }
  return {
    reason: record.reason,
    ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
  }
}

/**
 * Upgrades durable run cursors without requiring callers to delete existing
 * data. V1 mixed pause/complete control states into nextAction; V2 keeps only
 * executable work there and stores the wait condition separately.
 */
export function normalizeRunCheckpoint(value: unknown): RunCheckpoint {
  if (!value || typeof value !== 'object') throw new Error('invalid agent run checkpoint')
  const checkpoint = structuredClone(value) as RunCheckpoint
  const sourceSchemaVersion = (checkpoint as unknown as { schemaVersion: number }).schemaVersion
  if (sourceSchemaVersion !== 1 && sourceSchemaVersion !== 2) {
    throw new Error(`unsupported agent run checkpoint schema: ${sourceSchemaVersion}`)
  }

  const state = checkpoint.loop?.state
  if (!state || !checkpoint.identity) throw new Error('invalid agent run checkpoint state')
  const legacyAction = state.nextAction as
    | { type?: unknown; reason?: unknown; toolCallIds?: unknown }
    | undefined
  let nextAction = normalizeNextAction(legacyAction)
  let wait = normalizeWaitState(state.wait)

  if (legacyAction?.type === 'complete') {
    state.status = 'completed'
    state.completedAt ??= checkpoint.updatedAt
  } else if (legacyAction?.type === 'pause') {
    state.status = 'paused'
    wait =
      legacyAction.reason === 'approval' || legacyAction.reason === 'user_input'
        ? { reason: legacyAction.reason }
        : { reason: 'debug' }
    nextAction = { type: 'model', reason: 'resume' }
  }

  if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
    nextAction = undefined
    wait = undefined
  } else if (state.status === 'paused') {
    nextAction ??= { type: 'model', reason: 'resume' }
    wait ??= { reason: 'debug' }
  } else if (state.status === 'running') {
    if (!nextAction) {
      const currentStep = state.currentStep
      if (currentStep?.kind === 'tool_batch') {
        nextAction = {
          type: 'tools',
          toolCallIds: checkpoint.loop.pendingToolCalls.map(
            (call, index) => call.id || `tool-${index + 1}`,
          ),
        }
      } else if (currentStep?.kind === 'compact') {
        nextAction = { type: 'compact', reason: 'provider_overflow' }
      } else {
        nextAction = { type: 'model', reason: currentStep ? 'retry' : 'resume' }
      }
    }
    wait = undefined
  } else {
    nextAction = undefined
    wait = undefined
  }

  state.nextAction = nextAction
  state.wait = wait
  checkpoint.schemaVersion = AILA_RUN_CHECKPOINT_SCHEMA_VERSION
  assertRunStateInvariant(state)
  return checkpoint
}

export type RunArtifactKind =
  | 'model_request'
  | 'model_response'
  | 'model_call'
  | 'tool_batch'
  | 'tool_request'
  | 'tool_result'
  | 'compaction'
  | 'debug'

/** Immutable, inspectable payload produced by one run step. */
export interface RunArtifact {
  schemaVersion: typeof AILA_RUN_ARTIFACT_SCHEMA_VERSION
  artifactId: string
  conversationId: string
  turnId: string
  runId: string
  stepId: string
  kind: RunArtifactKind
  createdAt: number
  contentType: 'application/json' | 'text/plain'
  data: unknown
}

export function runRecoveryFromCursor(loop: RunCursor<ModelCallToolCall>): RunRecovery {
  if (
    loop.state.currentStep?.kind === 'tool_batch' &&
    loop.state.currentStep.status === 'running'
  ) {
    return {
      strategy: 'manual_review',
      reason: 'process stopped while a tool batch was running; side effects may have occurred',
    }
  }
  return { strategy: 'automatic' }
}

export function prepareRunCheckpoint(
  checkpoint: RunCheckpoint,
  previous?: RunCheckpoint,
): RunCheckpoint {
  const normalized = normalizeRunCheckpoint(checkpoint)
  const normalizedPrevious = previous ? normalizeRunCheckpoint(previous) : undefined
  if (normalized.identity.runId !== normalized.loop.state.identity.runId) {
    throw new Error('run checkpoint identity does not match loop snapshot')
  }
  if (normalized.assistantMessage.id !== normalized.assistantMessageId) {
    throw new Error('run checkpoint assistant message id does not match its message snapshot')
  }
  return {
    ...structuredClone(normalized),
    schemaVersion: AILA_RUN_CHECKPOINT_SCHEMA_VERSION,
    revision: normalizedPrevious
      ? Math.max(normalizedPrevious.revision + 1, normalized.revision)
      : Math.max(1, normalized.revision),
    recovery: runRecoveryFromCursor(normalized.loop),
  }
}

export function prepareRunCheckpointForResume(
  checkpoint: RunCheckpoint,
  timestamp: number,
): RunCheckpoint {
  const prepared = prepareRunCheckpoint(checkpoint)
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
  prepared.loop.state.wait = { reason: 'debug', detail: 'ready to resume persisted run' }
  prepared.loop.state.completedAt = undefined
  prepared.loop.state.error = undefined
  prepared.recovery = { strategy: 'automatic' }
  prepared.updatedAt = timestamp
  return prepared
}

export function prepareRunArtifact(artifact: RunArtifact): RunArtifact {
  return {
    ...structuredClone(artifact),
    schemaVersion: AILA_RUN_ARTIFACT_SCHEMA_VERSION,
  }
}
