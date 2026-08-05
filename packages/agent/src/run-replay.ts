import type { ModelSelection, UsageInfo } from './agent-protocol'
import type { PersistedRunEvent } from './conversation-core'
import type { ModelCallToolCall } from './model-call'
import { type RunCursor, type RunState, replayRunState } from './run-machine'
import { type RunSnapshot, runRecoveryFromCursor } from './run-persistence'
import {
  AILA_BLOB_SCHEMA_VERSION,
  type SessionEntry,
  type StoredBlob,
  sessionRunEvents,
  sessionRunPayloads,
} from './session-journal'

/**
 * Rebuilds RunSnapshot views from the journal — the journal is the single
 * source of truth; snapshots are computed on demand, never persisted.
 *
 * Every producer stamps selection / maxToolSteps /
 * sessionLeafId onto the run's opening event, so a run missing them is not
 * reconstructible and rebuilds to null rather than to invented defaults.
 */

export interface RebuildRunSnapshotInput {
  runId: string
  entries: readonly SessionEntry[]
  getBlob: (blobId: string) => Promise<StoredBlob | null>
}

/** Run ids present in the journal, ordered by first event appearance. */
export function listJournalRunIds(entries: readonly SessionEntry[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const event of sessionRunEvents(entries)) {
    if (event.runId && !seen.has(event.runId)) {
      seen.add(event.runId)
      ordered.push(event.runId)
    }
  }
  return ordered
}

export async function rebuildRunSnapshot(
  input: RebuildRunSnapshotInput,
): Promise<RunSnapshot | null> {
  const eventsByRun = groupEventsByRun(input.entries)
  const events = eventsByRun.get(input.runId)
  if (!events || events.length === 0) return null
  const state = replayRunState(events, input.runId)
  if (!state) return null

  const meta = resolveRunMeta(input.runId, eventsByRun)
  if (!meta.selection || meta.maxToolSteps === undefined || meta.sessionLeafId === undefined) {
    return null
  }
  const rootRunId = resolveRootRunId(input.runId, eventsByRun)
  const payloads = visibleRunPayloads(input.entries, state)
  const batch = await lastModelBatch(payloads, input.getBlob)
  const usage = await accumulateJournalUsage(payloads, input.getBlob)

  const completedToolCallIds = new Set(
    state.steps
      .filter((step) => step.kind === 'tool' && step.status === 'completed' && step.toolCallId)
      .map((step) => step.toolCallId as string),
  )
  const pendingIds =
    state.nextAction?.type === 'tools' ? state.nextAction.toolCallIds : ([] as string[])
  const byId = new Map(batch.map((call) => [call.id, call]))
  const pendingToolCalls = pendingIds
    .map((id) => byId.get(id))
    .filter((call): call is ModelCallToolCall => call !== undefined)
  const toolBatchCalls =
    state.nextAction?.type === 'tools'
      ? batch.filter((call) => !completedToolCallIds.has(call.id))
      : []

  const modelStepCount = state.steps.filter((step) => step.kind === 'model').length
  const loop: RunCursor = {
    state,
    nextStepIndex: state.steps.reduce((max, step) => Math.max(max, step.index + 1), 0),
    modelStepIndex: Math.max(modelStepCount, state.nextAction?.type === 'tools' ? 1 : 0),
    completedToolBatches: countCompletedToolBatches(state.identity.runId, eventsByRun),
    pendingToolCalls,
    ...(toolBatchCalls.length > 0 ? { toolBatchCalls } : {}),
  }

  const timestamps = events.map((event) => event.timestamp)
  return {
    identity: structuredClone(state.identity),
    assistantMessageId: events[0]?.messageId ?? state.identity.turnId,
    selection: meta.selection,
    maxToolSteps: meta.maxToolSteps,
    loop,
    sessionLeafId: meta.sessionLeafId,
    contextRef: {
      schemaVersion: AILA_BLOB_SCHEMA_VERSION,
      blobId: `run-context:${rootRunId}`,
      contentType: 'application/json',
      sizeBytes: 0,
    },
    ...(usage ? { usage } : {}),
    recovery: runRecoveryFromCursor(loop),
    revision: events.length,
    createdAt: timestamps.length > 0 ? Math.min(...timestamps) : 0,
    updatedAt: timestamps.length > 0 ? Math.max(...timestamps) : 0,
  }
}

function groupEventsByRun(entries: readonly SessionEntry[]): Map<string, PersistedRunEvent[]> {
  const byRun = new Map<string, PersistedRunEvent[]>()
  for (const event of sessionRunEvents(entries)) {
    if (!event.runId) continue
    const bucket = byRun.get(event.runId)
    if (bucket) bucket.push(event)
    else byRun.set(event.runId, [event])
  }
  return byRun
}

interface RunMetaFields {
  selection?: ModelSelection
  maxToolSteps?: number
  sessionLeafId?: string
}

function metaFromEvents(events: readonly PersistedRunEvent[]): RunMetaFields {
  const meta: RunMetaFields = {}
  for (const event of events) {
    if (event.type !== 'turn.started' && event.type !== 'run.started') continue
    const data = (event.data ?? {}) as Record<string, unknown>
    if (
      meta.selection === undefined &&
      typeof data.providerId === 'string' &&
      typeof data.modelId === 'string'
    ) {
      meta.selection = { providerId: data.providerId, modelId: data.modelId }
    }
    if (meta.maxToolSteps === undefined && typeof data.maxToolSteps === 'number') {
      meta.maxToolSteps = data.maxToolSteps
    }
    if (meta.sessionLeafId === undefined && typeof data.sessionLeafId === 'string') {
      meta.sessionLeafId = data.sessionLeafId
    }
  }
  return meta
}

function parentOf(
  runId: string,
  eventsByRun: Map<string, PersistedRunEvent[]>,
): string | undefined {
  const events = eventsByRun.get(runId) ?? []
  for (const event of events) {
    const parent = (event.data as Record<string, unknown> | undefined)?.parentRunId
    if (typeof parent === 'string' && parent.length > 0) return parent
  }
  return undefined
}

/** Walks the fork chain, child fields winning over ancestors. */
function resolveRunMeta(
  runId: string,
  eventsByRun: Map<string, PersistedRunEvent[]>,
): RunMetaFields {
  let meta: RunMetaFields = {}
  let probe: string | undefined = runId
  for (let depth = 0; probe !== undefined && depth < 32; depth += 1) {
    const layer = metaFromEvents(eventsByRun.get(probe) ?? [])
    meta = { ...layer, ...pruneUndefined(meta) }
    probe = parentOf(probe, eventsByRun)
  }
  return meta
}

function resolveRootRunId(runId: string, eventsByRun: Map<string, PersistedRunEvent[]>): string {
  let probe = runId
  for (let depth = 0; depth < 32; depth += 1) {
    const parent = parentOf(probe, eventsByRun)
    if (!parent) return probe
    probe = parent
  }
  return probe
}

function pruneUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}

/**
 * Payloads visible to a run: its fork source truncated at the origin step,
 * then its own — the same rule the resume path uses to rebuild messages.
 */
function visibleRunPayloads(
  entries: readonly SessionEntry[],
  state: RunState,
): Array<SessionEntry<'run.payload'>> {
  const runId = state.identity.runId
  const sourceRunId = state.identity.parentRunId ?? runId
  let sourcePayloads = sessionRunPayloads(entries, sourceRunId)
  if (state.identity.originStepId) {
    const boundarySeq = sourcePayloads
      .filter((entry) => entry.stepId === state.identity.originStepId)
      .reduce((maximum, entry) => Math.max(maximum, entry.seq), 0)
    if (boundarySeq > 0) {
      sourcePayloads = sourcePayloads.filter((entry) => entry.seq <= boundarySeq)
    }
  }
  const ownPayloads = sourceRunId === runId ? [] : sessionRunPayloads(entries, runId)
  return [...sourcePayloads, ...ownPayloads].sort((left, right) => left.seq - right.seq)
}

/** Tool calls of the latest model response, minus provider-resolved ones. */
async function lastModelBatch(
  payloads: readonly SessionEntry<'run.payload'>[],
  getBlob: (blobId: string) => Promise<StoredBlob | null>,
): Promise<ModelCallToolCall[]> {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const payload = payloads[index]
    if (payload.data.kind !== 'model_response' || !payload.payloadRef) continue
    const blob = await getBlob(payload.payloadRef.blobId)
    const data = blob?.data as Record<string, unknown> | undefined
    const toolCalls = Array.isArray(data?.toolCalls) ? (data.toolCalls as ModelCallToolCall[]) : []
    const resolved = Array.isArray(data?.resolvedToolResults)
      ? (data.resolvedToolResults as Array<{ toolCallId?: string }>)
      : []
    const resolvedIds = new Set(resolved.map((entry) => entry.toolCallId))
    return structuredClone(toolCalls.filter((call) => !resolvedIds.has(call.id)))
  }
  return []
}

/** Re-runs the executor's usage accumulator over persisted step usage. */
async function accumulateJournalUsage(
  payloads: readonly SessionEntry<'run.payload'>[],
  getBlob: (blobId: string) => Promise<StoredBlob | null>,
): Promise<UsageInfo | undefined> {
  let total: UsageInfo | undefined
  for (const payload of payloads) {
    if (payload.data.kind !== 'model_response' || !payload.payloadRef) continue
    const blob = await getBlob(payload.payloadRef.blobId)
    const data = blob?.data as Record<string, unknown> | undefined
    const stepUsage = Array.isArray(data?.stepUsage)
      ? (data.stepUsage as Array<Record<string, number | null | undefined>>)
      : []
    for (const usage of stepUsage) {
      total ??= { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      addUsage(total, usage)
    }
  }
  return total
}

function addUsage(total: UsageInfo, usage: Record<string, number | null | undefined>): void {
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  total.promptTokens += inputTokens
  total.completionTokens += outputTokens
  total.totalTokens += usage.totalTokens ?? inputTokens + outputTokens
  total.modelCallCount = (total.modelCallCount ?? 0) + 1
  total.maxInputTokens = Math.max(total.maxInputTokens ?? 0, inputTokens)
  total.lastInputTokens = inputTokens
  total.lastOutputTokens = outputTokens
  setLastOptional(total, 'lastCacheReadTokens', usage.cacheReadTokens)
  setLastOptional(total, 'lastCacheWriteTokens', usage.cacheWriteTokens)
  setLastOptional(total, 'lastCacheMissTokens', usage.cacheMissTokens)
  addOptional(total, 'cacheReadTokens', usage.cacheReadTokens)
  addOptional(total, 'cacheWriteTokens', usage.cacheWriteTokens)
  addOptional(total, 'cacheMissTokens', usage.cacheMissTokens)
  addOptional(total, 'reasoningTokens', usage.reasoningTokens)
}

type OptionalUsageKey =
  | 'lastCacheReadTokens'
  | 'lastCacheWriteTokens'
  | 'lastCacheMissTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'cacheMissTokens'
  | 'reasoningTokens'

function setLastOptional(
  total: UsageInfo,
  key: OptionalUsageKey,
  value: number | null | undefined,
): void {
  if (value !== null && value !== undefined) total[key] = value
}

function addOptional(
  total: UsageInfo,
  key: OptionalUsageKey,
  value: number | null | undefined,
): void {
  if (value !== null && value !== undefined) total[key] = (total[key] ?? 0) + value
}

/** A tool batch completes exactly when its last tool step hands back to the model. */
function countCompletedToolBatches(
  runId: string,
  eventsByRun: Map<string, PersistedRunEvent[]>,
  originStepIndexBound?: number,
): number {
  const events = eventsByRun.get(runId) ?? []
  let own = 0
  for (const event of events) {
    if (event.type !== 'step.completed') continue
    const data = (event.data ?? {}) as Record<string, unknown>
    if (data.kind !== 'tool') continue
    if (
      originStepIndexBound !== undefined &&
      typeof data.index === 'number' &&
      data.index > originStepIndexBound
    ) {
      continue
    }
    const nextAction = data.nextAction as { type?: string } | undefined
    if (nextAction?.type === 'model') own += 1
  }
  const parent = parentOf(runId, eventsByRun)
  if (!parent) return own
  const originStepId = originStepIdOf(runId, eventsByRun)
  const parentBound = originStepId ? stepIndexOf(parent, originStepId, eventsByRun) : undefined
  return own + countCompletedToolBatches(parent, eventsByRun, parentBound)
}

function originStepIdOf(
  runId: string,
  eventsByRun: Map<string, PersistedRunEvent[]>,
): string | undefined {
  for (const event of eventsByRun.get(runId) ?? []) {
    const origin = (event.data as Record<string, unknown> | undefined)?.originStepId
    if (typeof origin === 'string' && origin.length > 0) return origin
  }
  return undefined
}

function stepIndexOf(
  runId: string,
  stepId: string,
  eventsByRun: Map<string, PersistedRunEvent[]>,
): number | undefined {
  for (const event of eventsByRun.get(runId) ?? []) {
    if (event.stepId !== stepId) continue
    const index = (event.data as Record<string, unknown> | undefined)?.index
    if (typeof index === 'number') return index
  }
  return undefined
}
