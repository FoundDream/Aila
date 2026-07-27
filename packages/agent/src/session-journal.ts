import type { ChatMessage, RunEvent, UsageInfo } from './agent-protocol'
import {
  AILA_RUN_EVENT_SCHEMA_VERSION,
  appendConversationContextTurnLedgerEntry,
  type ConversationContextCheckpoint,
  type ConversationContextTurnLedgerEntry,
  type ConversationRecord,
  type ConversationSummary,
  createConversationUsageSnapshot,
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
  type PersistedMessage,
  type PersistedRunEvent,
  preparePersistedMessage,
  replayConversationActivity,
  upsertPersistedMessage,
} from './conversation-core'

export const AILA_SESSION_ENTRY_SCHEMA_VERSION = 1
export const AILA_BLOB_SCHEMA_VERSION = 1

export interface BlobRef {
  schemaVersion: typeof AILA_BLOB_SCHEMA_VERSION
  blobId: string
  contentType: string
  sizeBytes: number
  preview?: string
}

export interface StoredBlob {
  ref: BlobRef
  data: unknown
}

export type RunPayloadKind =
  | 'provider_request'
  | 'provider_response'
  | 'tool_batch'
  | 'tool_request'
  | 'tool_result'
  | 'context_compaction'
  | 'inspection'

export interface RunPayloadData {
  kind: RunPayloadKind
  label: string
  modelMessage?: ChatMessage
  assistantMessage?: PersistedMessage
}

export interface SessionEntryDataMap {
  'session.created': { summary: ConversationSummary }
  'conversation.renamed': { title: string }
  'message.committed': { message: PersistedMessage }
  'usage.recorded': { usage: UsageInfo }
  'run.event': { event: RunEvent | PersistedRunEvent }
  'run.payload': RunPayloadData
  'context.compacted': { checkpoint: ConversationContextCheckpoint }
  'context.turn.recorded': { entry: ConversationContextTurnLedgerEntry }
}

export type SessionEntryType = keyof SessionEntryDataMap

interface SessionEntryIdentity {
  entryId: string
  sessionId: string
  seq: number
  timestamp: number
  turnId?: string
  runId?: string
  stepId?: string
  parentId?: string
  payloadRef?: BlobRef
}

export type SessionEntry<TType extends SessionEntryType = SessionEntryType> = {
  [Type in TType]: SessionEntryIdentity & {
    schemaVersion: typeof AILA_SESSION_ENTRY_SCHEMA_VERSION
    type: Type
    data: SessionEntryDataMap[Type]
  }
}[TType]

export type SessionEntryInput<TType extends SessionEntryType = SessionEntryType> = {
  [Type in TType]: Omit<SessionEntry<Type>, 'schemaVersion' | 'sessionId' | 'seq' | 'entryId'> & {
    entryId?: string
  }
}[TType]

export interface SessionEntryAppendResult {
  entry: SessionEntry
  summary: ConversationSummary
  duplicate?: boolean
}

export function orderedSessionEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  return [...entries]
    .sort((left, right) => left.seq - right.seq || left.timestamp - right.timestamp)
    .filter(
      (entry, index, ordered) =>
        ordered.findIndex((candidate) => candidate.entryId === entry.entryId) === index,
    )
    .map((entry) => structuredClone(entry))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function prepareSessionEntry(
  sessionId: string,
  existing: readonly SessionEntry[],
  input: SessionEntryInput,
  createId: () => string,
): { entry: SessionEntry; duplicate: boolean } {
  const entryId =
    input.entryId ??
    (input.type === 'run.event' ? input.data.event.eventId : undefined) ??
    createId()
  const duplicate = existing.find((entry) => entry.entryId === entryId)
  if (duplicate) {
    const comparable = {
      ...structuredClone(input),
      entryId,
      sessionId,
      seq: duplicate.seq,
      schemaVersion: AILA_SESSION_ENTRY_SCHEMA_VERSION,
    } as SessionEntry
    if (comparable.type === 'run.event') {
      comparable.data.event = {
        ...structuredClone(comparable.data.event),
        schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
        eventId: entryId,
        seq: duplicate.seq,
      } as PersistedRunEvent
    }
    if (canonicalJson(duplicate) !== canonicalJson(comparable)) {
      throw new Error(`session entry is immutable: ${entryId}`)
    }
    return { entry: structuredClone(duplicate), duplicate: true }
  }

  const seq = existing.reduce((maximum, entry) => Math.max(maximum, entry.seq), 0) + 1
  const prepared = {
    ...structuredClone(input),
    schemaVersion: AILA_SESSION_ENTRY_SCHEMA_VERSION,
    entryId,
    sessionId,
    seq,
  } as SessionEntry
  if (prepared.type === 'run.event') {
    prepared.data.event = {
      ...structuredClone(prepared.data.event),
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      eventId: entryId,
      seq,
    } as PersistedRunEvent
  }
  return { entry: prepared, duplicate: false }
}

export function projectConversation(entries: readonly SessionEntry[]): ConversationRecord {
  const ordered = orderedSessionEntries(entries)
  const created = ordered.find(
    (entry): entry is SessionEntry<'session.created'> => entry.type === 'session.created',
  )
  if (!created) throw new Error('session journal is missing session.created')

  const meta = structuredClone(created.data.summary)
  const messages: PersistedMessage[] = []
  const runEvents: PersistedRunEvent[] = []

  for (const entry of ordered) {
    meta.updatedAt = Math.max(meta.updatedAt, entry.timestamp)
    switch (entry.type) {
      case 'conversation.renamed':
        meta.title = entry.data.title.trim() || DEFAULT_CONVERSATION_TITLE
        break
      case 'message.committed': {
        const message = preparePersistedMessage(entry.data.message)
        upsertPersistedMessage(messages, message)
        if (meta.title === DEFAULT_CONVERSATION_TITLE) {
          meta.title = deriveConversationTitle(message) ?? meta.title
        }
        break
      }
      case 'usage.recorded':
        meta.usage = createConversationUsageSnapshot(meta.usage, entry.data.usage, entry.timestamp)
        break
      case 'run.event':
        runEvents.push(structuredClone(entry.data.event) as PersistedRunEvent)
        break
      case 'context.compacted':
        meta.context = {
          ...(meta.context ?? {}),
          checkpoint: structuredClone(entry.data.checkpoint),
        }
        break
      case 'context.turn.recorded':
        meta.context = appendConversationContextTurnLedgerEntry(
          meta.context,
          structuredClone(entry.data.entry),
        )
        break
      case 'session.created':
      case 'run.payload':
        break
    }
  }

  const activity = replayConversationActivity(runEvents)
  if (activity && (!meta.activity || activity.updatedAt >= meta.activity.updatedAt)) {
    meta.activity = activity
    meta.updatedAt = Math.max(meta.updatedAt, activity.updatedAt)
  }
  return { meta, messages }
}

export function sessionRunEvents(entries: readonly SessionEntry[]): PersistedRunEvent[] {
  return orderedSessionEntries(entries).flatMap((entry) =>
    entry.type === 'run.event' ? [structuredClone(entry.data.event) as PersistedRunEvent] : [],
  )
}

export function sessionRunPayloads(
  entries: readonly SessionEntry[],
  runId?: string,
): Array<SessionEntry<'run.payload'>> {
  return orderedSessionEntries(entries).filter(
    (entry): entry is SessionEntry<'run.payload'> =>
      entry.type === 'run.payload' && (!runId || entry.runId === runId),
  )
}
