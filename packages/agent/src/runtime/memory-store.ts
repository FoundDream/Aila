import type { RunEvent, UsageInfo } from '../agent-protocol'
import {
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  appendConversationContextTurnLedgerEntry,
  type ConversationRecord,
  type ConversationSummary,
  type ConversationWorkspaceRef,
  createConversationUsageSnapshot,
  createInterruptedConversationRecoveryEvent,
  orderedUniqueRunEvents,
  type PersistedMessage,
  type PersistedRunEvent,
  type PersistedTextBlock,
  prepareRunEventAppend,
  type RunEventAppendResult,
  replayConversationActivity,
} from '../conversation-core'
import {
  prepareRunArtifact,
  prepareRunCheckpoint,
  type RunArtifact,
  type RunCheckpoint,
} from '../run-persistence'
import type { WorkbenchStore } from './repositories'

const DEFAULT_SESSION_TITLE = '新对话'
const SESSION_TITLE_MAX = 40

export interface RuntimeEnvironment {
  createId?: () => string
  createRunId?: () => string
  createEventId?: () => string
  now?: () => number
}

export type InMemoryStoreOptions = RuntimeEnvironment

function nowDefault(): number {
  return Date.now()
}

function createIdDefault(): string {
  const cryptoLike = (
    globalThis as typeof globalThis & {
      crypto?: { randomUUID?: () => string }
    }
  ).crypto
  return (
    cryptoLike?.randomUUID?.() ??
    `runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function messageText(message: PersistedMessage): string {
  return message.blocks
    .filter((block): block is PersistedTextBlock => block.type === 'text')
    .map((block) => block.content)
    .join('\n')
}

function nextUpdatedAt(current: ConversationSummary, timestamp: number): number {
  return Math.max(current.updatedAt + 1, timestamp)
}

function deriveTitle(message: PersistedMessage): string | null {
  if (message.role !== 'user') return null
  const title = messageText(message).replace(/\s+/g, ' ').trim()
  if (!title) return null
  if (title.length <= SESSION_TITLE_MAX) return title
  return `${title.slice(0, SESSION_TITLE_MAX - 3)}...`
}

function sameActivity(
  left: ConversationSummary['activity'],
  right: ConversationSummary['activity'],
): boolean {
  return (
    left?.state === right?.state &&
    left?.title === right?.title &&
    left?.updatedAt === right?.updatedAt &&
    left?.eventType === right?.eventType &&
    left?.messageId === right?.messageId &&
    left?.detail === right?.detail &&
    left?.toolName === right?.toolName
  )
}

/** In-memory implementation of the split Session, Event and Run repositories. */
export function createInMemoryRuntimeStore(input: InMemoryStoreOptions = {}): WorkbenchStore {
  const createId = input.createId ?? createIdDefault
  const createEventId = input.createEventId ?? createIdDefault
  const now = input.now ?? nowDefault
  const records = new Map<string, ConversationRecord>()
  const runEvents = new Map<string, PersistedRunEvent[]>()
  const checkpoints = new Map<string, RunCheckpoint>()
  const artifacts = new Map<string, RunArtifact>()

  function requireRecord(sessionId: string): ConversationRecord {
    const record = records.get(sessionId)
    if (!record) throw new Error(`conversation not found: ${sessionId}`)
    return record
  }

  function runKey(sessionId: string, runId: string): string {
    return `${sessionId}:${runId}`
  }

  function summary(record: ConversationRecord): ConversationSummary {
    return clone(record.meta)
  }

  function updateMeta(
    sessionId: string,
    updater: (current: ConversationSummary) => ConversationSummary,
  ): ConversationSummary {
    const record = requireRecord(sessionId)
    record.meta = clone(updater(record.meta))
    return summary(record)
  }

  async function recordRunEvent(sessionId: string, event: RunEvent): Promise<RunEventAppendResult> {
    const record = requireRecord(sessionId)
    const events = runEvents.get(sessionId) ?? []
    const previousActivity = replayConversationActivity(events)
    const prepared = prepareRunEventAppend(events, clone(event), createEventId)
    const persisted = prepared.event
    if (!prepared.duplicate) events.push(persisted)
    runEvents.set(sessionId, events)

    const activity = replayConversationActivity(events)
    if (!activity || sameActivity(previousActivity, activity)) {
      return { event: clone(persisted) }
    }
    if (record.meta.activity && record.meta.activity.updatedAt > activity.updatedAt) {
      return { event: clone(persisted) }
    }

    const updated = updateMeta(sessionId, (current) => ({
      ...current,
      updatedAt: nextUpdatedAt(current, persisted.timestamp),
      activity,
    }))
    return { event: clone(persisted), summary: updated }
  }

  return {
    async createConversation(
      workspace?: ConversationWorkspaceRef | null,
    ): Promise<ConversationSummary> {
      const createdAt = now()
      const meta: ConversationSummary = {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id: createId(),
        title: DEFAULT_SESSION_TITLE,
        createdAt,
        updatedAt: createdAt,
        ...(workspace ? { workspace: clone(workspace) } : {}),
      }
      records.set(meta.id, { meta, messages: [] })
      runEvents.set(meta.id, [])
      return clone(meta)
    },
    async getConversation(sessionId): Promise<ConversationRecord> {
      return clone(requireRecord(sessionId))
    },
    async saveMessage(sessionId, message): Promise<ConversationSummary> {
      const record = requireRecord(sessionId)
      const prepared = clone(message)
      const index = record.messages.findIndex((current) => current.id === prepared.id)
      if (index >= 0) record.messages[index] = prepared
      else record.messages.push(prepared)

      record.meta = {
        ...record.meta,
        updatedAt: nextUpdatedAt(record.meta, now()),
      }
      if (record.meta.title === DEFAULT_SESSION_TITLE) {
        const title = deriveTitle(prepared)
        if (title) record.meta.title = title
      }
      return summary(record)
    },
    recordRunEvent,
    async listConversations(): Promise<readonly ConversationSummary[]> {
      return [...records.values()]
        .map((record) => summary(record))
        .sort((left, right) => right.updatedAt - left.updatedAt)
    },
    async listRunEvents(sessionId): Promise<readonly PersistedRunEvent[]> {
      return clone(orderedUniqueRunEvents(runEvents.get(sessionId) ?? []))
    },
    async recoverInterruptedActivities(reason): Promise<readonly RunEventAppendResult[]> {
      const recovered: RunEventAppendResult[] = []
      for (const [sessionId, record] of records) {
        const events = runEvents.get(sessionId) ?? []
        const replayedActivity = replayConversationActivity(events)
        if (replayedActivity && !sameActivity(record.meta.activity, replayedActivity)) {
          updateMeta(sessionId, (current) =>
            current.activity && current.activity.updatedAt > replayedActivity.updatedAt
              ? current
              : {
                  ...current,
                  updatedAt: nextUpdatedAt(current, replayedActivity.updatedAt),
                  activity: replayedActivity,
                },
          )
        }
        const recoveryEvent = createInterruptedConversationRecoveryEvent(events, {
          reason,
          activity: replayedActivity ?? record.meta.activity,
        })
        if (!recoveryEvent) continue
        recovered.push(await recordRunEvent(sessionId, recoveryEvent))
      }
      return recovered.sort(
        (left, right) =>
          (right.summary?.updatedAt ?? right.event.timestamp) -
          (left.summary?.updatedAt ?? left.event.timestamp),
      )
    },
    async renameConversation(sessionId, title): Promise<ConversationSummary> {
      return updateMeta(sessionId, (current) => ({
        ...current,
        title: title.trim() || DEFAULT_SESSION_TITLE,
        updatedAt: nextUpdatedAt(current, now()),
      }))
    },
    async recordUsage(sessionId, usage: UsageInfo): Promise<ConversationSummary> {
      const timestamp = now()
      return updateMeta(sessionId, (current) => ({
        ...current,
        updatedAt: nextUpdatedAt(current, timestamp),
        usage: createConversationUsageSnapshot(current.usage, usage, timestamp),
      }))
    },
    async saveContextCheckpoint(sessionId, checkpoint): Promise<ConversationSummary> {
      return updateMeta(sessionId, (current) => ({
        ...current,
        updatedAt: nextUpdatedAt(current, checkpoint.createdAt),
        context: {
          ...(current.context ?? {}),
          checkpoint: clone(checkpoint),
        },
      }))
    },
    async recordContextTurnLedger(sessionId, entry): Promise<ConversationSummary> {
      return updateMeta(sessionId, (current) => ({
        ...current,
        updatedAt: nextUpdatedAt(current, entry.createdAt),
        context: appendConversationContextTurnLedgerEntry(current.context, entry),
      }))
    },
    async saveRunCheckpoint(checkpoint): Promise<RunCheckpoint> {
      requireRecord(checkpoint.identity.conversationId)
      const key = runKey(checkpoint.identity.conversationId, checkpoint.identity.runId)
      const prepared = prepareRunCheckpoint(checkpoint, checkpoints.get(key))
      checkpoints.set(key, clone(prepared))
      return clone(prepared)
    },
    async getRunCheckpoint(sessionId, runId): Promise<RunCheckpoint | null> {
      const checkpoint = checkpoints.get(runKey(sessionId, runId))
      return checkpoint ? clone(checkpoint) : null
    },
    async listRunCheckpoints(sessionId): Promise<readonly RunCheckpoint[]> {
      return [...checkpoints.values()]
        .filter((checkpoint) => checkpoint.identity.conversationId === sessionId)
        .map((checkpoint) => clone(checkpoint))
        .sort((left, right) => right.updatedAt - left.updatedAt)
    },
    async saveRunArtifact(artifact): Promise<RunArtifact> {
      requireRecord(artifact.conversationId)
      const prepared = prepareRunArtifact(artifact)
      const existing = artifacts.get(prepared.artifactId)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(prepared)) {
          throw new Error(`run artifact is immutable: ${prepared.artifactId}`)
        }
        return clone(existing)
      }
      artifacts.set(prepared.artifactId, clone(prepared))
      return clone(prepared)
    },
    async listRunArtifacts(sessionId, runId): Promise<readonly RunArtifact[]> {
      return [...artifacts.values()]
        .filter((artifact) => artifact.conversationId === sessionId && artifact.runId === runId)
        .map((artifact) => clone(artifact))
        .sort((left, right) => left.createdAt - right.createdAt)
    },
    async deleteConversation(sessionId): Promise<void> {
      records.delete(sessionId)
      runEvents.delete(sessionId)
      for (const key of checkpoints.keys()) {
        if (key.startsWith(`${sessionId}:`)) checkpoints.delete(key)
      }
      for (const [artifactId, artifact] of artifacts) {
        if (artifact.conversationId === sessionId) artifacts.delete(artifactId)
      }
    },
  }
}
