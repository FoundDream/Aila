import type {
  ConversationContextCheckpoint,
  ConversationContextTurnLedgerEntry,
  ConversationRecord,
  ConversationSummary,
  ConversationWorkspaceRef,
  PersistedMessage,
  PersistedRunEvent,
  RunEvent,
  RunEventAppendResult,
  RunPayload,
  RunSnapshot,
  SessionEntry,
  UsageInfo,
  WorkbenchStore,
} from '@aila/agent'
import {
  AILA_RUN_PAYLOAD_SCHEMA_VERSION,
  normalizeRunPayloadKind,
  sessionRunEvents,
  sessionRunPayloads,
} from '@aila/agent'
import { createFileRuntimeStore } from '../node/file-store'
import { getDataDir } from './paths'

export {
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  AILA_RUN_EVENT_SCHEMA_VERSION,
  type ConversationActivity,
  type ConversationActivityState,
  type ConversationCompactArtifact,
  type ConversationCompactFileArtifact,
  type ConversationCompactToolActivity,
  type ConversationCompactToolResultArtifact,
  type ConversationContextCheckpoint,
  type ConversationContextState,
  type ConversationContextTurnLedgerEntry,
  type ConversationInterruptedRecoveryOptions,
  type ConversationMeta,
  type ConversationRecord,
  type ConversationRuntimePendingApproval,
  type ConversationRuntimeReplayState,
  type ConversationRuntimeReplayTurn,
  type ConversationRuntimeStatePhase,
  type ConversationSummary,
  type ConversationUsage,
  createInterruptedConversationRecoveryEvent,
  orderedUniqueRunEvents,
  type PersistedBlock,
  type PersistedFileBlock,
  type PersistedImageBlock,
  type PersistedMessage,
  type PersistedRunEvent,
  type PersistedTextBlock,
  type PersistedToolCallBlock,
  type RunEventAppendResult,
  replayConversationActivity,
  replayConversationRuntimeState,
} from '@aila/agent'

export interface TokenUsageDay {
  date: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheMissTokens: number
  reasoningTokens: number
  modelCallCount: number
  turnCount: number
}

export interface TokenUsageStats {
  generatedAt: number
  today: TokenUsageDay
  lifetime: TokenUsageDay
  peakDay: TokenUsageDay | null
  currentStreakDays: number
  longestStreakDays: number
  days: TokenUsageDay[]
}

let cachedDataDir: string | null = null
let cachedStore: WorkbenchStore | null = null

function store(): WorkbenchStore {
  const dataDir = getDataDir()
  if (!cachedStore || cachedDataDir !== dataDir) {
    cachedDataDir = dataDir
    cachedStore = createFileRuntimeStore({ dataDir })
  }
  return cachedStore
}

export async function listConversations(): Promise<ConversationSummary[]> {
  return structuredClone([...((await store().listConversations?.()) ?? [])])
}

export async function recoverInterruptedConversationActivities(
  reason?: string,
): Promise<ConversationSummary[]> {
  return (await recoverInterruptedConversationActivityResults(reason)).flatMap((result) =>
    result.summary ? [result.summary] : [],
  )
}

export async function recoverInterruptedConversationActivityResults(
  reason?: string,
): Promise<RunEventAppendResult[]> {
  return structuredClone([...((await store().recoverInterruptedActivities?.(reason)) ?? [])])
}

export async function getConversation(id: string): Promise<ConversationRecord> {
  return structuredClone(await store().getConversation(id))
}

export async function createConversation(
  workspace?: ConversationWorkspaceRef | null,
): Promise<ConversationSummary> {
  const create = store().createConversation
  if (!create) throw new Error('runtime store cannot create conversations')
  return structuredClone(await create(workspace))
}

export async function appendMessage(
  id: string,
  message: PersistedMessage,
): Promise<ConversationSummary> {
  return upsertMessage(id, message)
}

export async function upsertMessage(
  id: string,
  message: PersistedMessage,
): Promise<ConversationSummary> {
  const result = await store().appendSessionEntry(id, {
    type: 'message.committed',
    timestamp: Date.now(),
    data: { message: structuredClone(message) },
  })
  return structuredClone(result.summary)
}

export async function appendRunEvent(id: string, event: RunEvent): Promise<PersistedRunEvent> {
  return (await appendRunEventAndTouchConversation(id, event)).event
}

export async function appendRunEventAndTouchConversation(
  id: string,
  event: RunEvent,
): Promise<RunEventAppendResult> {
  const result = await store().appendSessionEntry(id, {
    type: 'run.event',
    timestamp: event.timestamp,
    entryId: event.eventId,
    turnId: event.turnId,
    runId: event.runId,
    stepId: event.stepId,
    data: { event: structuredClone(event) },
  })
  if (result.entry.type !== 'run.event') throw new Error('invalid run event journal entry')
  return {
    event: structuredClone(result.entry.data.event) as PersistedRunEvent,
    summary: structuredClone(result.summary),
  }
}

export async function listRunEvents(id: string): Promise<PersistedRunEvent[]> {
  return structuredClone(sessionRunEvents(await store().listSessionEntries(id)))
}

export async function getTokenUsageStats(now = Date.now()): Promise<TokenUsageStats> {
  const days = new Map<string, TokenUsageDay>()
  for (const summary of await listConversations()) {
    for (const entry of await store().listSessionEntries(summary.id)) {
      if (entry.type !== 'usage.recorded') continue
      const date = new Date(entry.timestamp).toISOString().slice(0, 10)
      const day = days.get(date) ?? emptyUsageDay(date)
      addUsage(day, entry.data.usage)
      days.set(date, day)
    }
  }
  const ordered = [...days.values()].sort((left, right) => left.date.localeCompare(right.date))
  const lifetime = emptyUsageDay('lifetime')
  for (const day of ordered) addUsageDay(lifetime, day)
  const todayDate = new Date(now).toISOString().slice(0, 10)
  const today = structuredClone(days.get(todayDate) ?? emptyUsageDay(todayDate))
  const peakDay =
    ordered.reduce<TokenUsageDay | null>(
      (peak, day) => (!peak || day.totalTokens > peak.totalTokens ? day : peak),
      null,
    ) ?? null
  const streaks = usageStreaks(ordered)
  return {
    generatedAt: now,
    today,
    lifetime,
    peakDay: peakDay ? structuredClone(peakDay) : null,
    currentStreakDays: streaks.current,
    longestStreakDays: streaks.longest,
    days: structuredClone(ordered),
  }
}

export async function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  const result = await store().appendSessionEntry(id, {
    type: 'conversation.renamed',
    timestamp: Date.now(),
    data: { title },
  })
  return structuredClone(result.summary)
}

export async function setConversationUsage(
  id: string,
  usage: UsageInfo,
): Promise<ConversationSummary> {
  const result = await store().appendSessionEntry(id, {
    type: 'usage.recorded',
    timestamp: Date.now(),
    data: { usage: structuredClone(usage) },
  })
  return structuredClone(result.summary)
}

export async function setConversationContextCheckpoint(
  id: string,
  checkpoint: ConversationContextCheckpoint,
): Promise<ConversationSummary> {
  const result = await store().appendSessionEntry(id, {
    type: 'context.compacted',
    timestamp: checkpoint.createdAt,
    data: { checkpoint: structuredClone(checkpoint) },
  })
  return structuredClone(result.summary)
}

export async function recordConversationContextTurnLedger(
  id: string,
  entry: ConversationContextTurnLedgerEntry,
): Promise<ConversationSummary> {
  const result = await store().appendSessionEntry(id, {
    type: 'context.turn.recorded',
    timestamp: entry.createdAt,
    data: { entry: structuredClone(entry) },
  })
  return structuredClone(result.summary)
}

export async function getRunSnapshot(
  conversationId: string,
  runId: string,
): Promise<RunSnapshot | null> {
  return structuredClone(await store().getRunSnapshot(conversationId, runId))
}

export async function saveRunSnapshot(snapshot: RunSnapshot): Promise<RunSnapshot> {
  return structuredClone(await store().saveRunSnapshot(snapshot))
}

export async function listRunSnapshots(conversationId: string): Promise<RunSnapshot[]> {
  return structuredClone([...(await store().listRunSnapshots(conversationId))])
}

export async function saveRunPayload(payload: RunPayload): Promise<RunPayload> {
  const payloadRef = await store().putBlob(payload.conversationId, {
    blobId: `payload:${payload.payloadId}`,
    contentType: payload.contentType,
    data: structuredClone(payload.data),
  })
  await store().appendSessionEntry(payload.conversationId, {
    type: 'run.payload',
    entryId: payload.payloadId,
    timestamp: payload.createdAt,
    turnId: payload.turnId,
    runId: payload.runId,
    stepId: payload.stepId,
    payloadRef,
    data: {
      kind: payload.kind,
      label: payload.kind.replaceAll('_', ' '),
    },
  })
  return structuredClone(payload)
}

export async function listRunPayloads(
  conversationId: string,
  runId: string,
): Promise<RunPayload[]> {
  const entries = sessionRunPayloads(await store().listSessionEntries(conversationId), runId)
  return Promise.all(entries.map((entry) => resolvePayload(entry)))
}

export async function deleteConversation(id: string): Promise<void> {
  await store().deleteConversation(id)
}

async function resolvePayload(entry: SessionEntry<'run.payload'>): Promise<RunPayload> {
  const blob = entry.payloadRef
    ? await store().getBlob(entry.sessionId, entry.payloadRef.blobId)
    : null
  return {
    schemaVersion: AILA_RUN_PAYLOAD_SCHEMA_VERSION,
    payloadId: entry.entryId,
    conversationId: entry.sessionId,
    turnId: entry.turnId ?? '',
    runId: entry.runId ?? '',
    stepId: entry.stepId ?? '',
    kind: normalizeRunPayloadKind(entry.data.kind),
    createdAt: entry.timestamp,
    contentType: entry.payloadRef?.contentType === 'text/plain' ? 'text/plain' : 'application/json',
    data: structuredClone(blob?.data ?? null),
  }
}

function emptyUsageDay(date: string): TokenUsageDay {
  return {
    date,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    modelCallCount: 0,
    turnCount: 0,
  }
}

function addUsage(day: TokenUsageDay, usage: UsageInfo): void {
  day.totalTokens += usage.totalTokens
  day.inputTokens += usage.promptTokens
  day.outputTokens += usage.completionTokens
  day.cacheReadTokens += usage.cacheReadTokens ?? 0
  day.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  day.cacheMissTokens += usage.cacheMissTokens ?? 0
  day.reasoningTokens += usage.reasoningTokens ?? 0
  day.modelCallCount += usage.modelCallCount ?? 1
  day.turnCount += 1
}

function addUsageDay(target: TokenUsageDay, source: TokenUsageDay): void {
  target.totalTokens += source.totalTokens
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.cacheMissTokens += source.cacheMissTokens
  target.reasoningTokens += source.reasoningTokens
  target.modelCallCount += source.modelCallCount
  target.turnCount += source.turnCount
}

function usageStreaks(days: readonly TokenUsageDay[]): { current: number; longest: number } {
  let current = 0
  let longest = 0
  let previous: number | null = null
  for (const day of days) {
    const value = Date.parse(`${day.date}T00:00:00Z`)
    current = previous !== null && value - previous === 86_400_000 ? current + 1 : 1
    longest = Math.max(longest, current)
    previous = value
  }
  return { current, longest }
}
