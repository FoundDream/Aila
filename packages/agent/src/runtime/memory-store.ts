import type { RunEvent } from '../agent-protocol'
import {
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  createInterruptedConversationRecoveryEvent,
  DEFAULT_CONVERSATION_TITLE,
  type RunEventAppendResult,
} from '../conversation-core'
import { prepareRunSnapshot, type RunSnapshot } from '../run-persistence'
import {
  AILA_BLOB_SCHEMA_VERSION,
  type BlobRef,
  prepareSessionEntry,
  projectConversation,
  type SessionEntry,
  type SessionEntryInput,
  type StoredBlob,
  sessionRunEvents,
} from '../session-journal'
import type { WorkbenchStore } from './repositories'

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

function blobSize(data: unknown): number {
  return new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data)).byteLength
}

/** In-memory implementation of the journal/snapshot/blob runtime store. */
export function createInMemoryRuntimeStore(input: InMemoryStoreOptions = {}): WorkbenchStore {
  const createId = input.createId ?? createIdDefault
  const createEventId = input.createEventId ?? createIdDefault
  const now = input.now ?? nowDefault
  const journals = new Map<string, SessionEntry[]>()
  const snapshots = new Map<string, RunSnapshot>()
  const blobs = new Map<string, StoredBlob>()

  function requireJournal(sessionId: string): SessionEntry[] {
    const journal = journals.get(sessionId)
    if (!journal) throw new Error(`conversation not found: ${sessionId}`)
    return journal
  }

  function runKey(sessionId: string, runId: string): string {
    return `${sessionId}:${runId}`
  }

  function blobKey(sessionId: string, blobId: string): string {
    return `${sessionId}:${blobId}`
  }

  async function appendSessionEntry(
    sessionId: string,
    inputEntry: SessionEntryInput,
  ): Promise<{
    entry: SessionEntry
    summary: ReturnType<typeof projectConversation>['meta']
    duplicate?: boolean
  }> {
    const journal = requireJournal(sessionId)
    const prepared = prepareSessionEntry(sessionId, journal, clone(inputEntry), createEventId)
    if (!prepared.duplicate) journal.push(clone(prepared.entry))
    return {
      entry: clone(prepared.entry),
      summary: clone(projectConversation(journal).meta),
      ...(prepared.duplicate ? { duplicate: true } : {}),
    }
  }

  async function appendRecoveryEvent(
    sessionId: string,
    event: RunEvent,
  ): Promise<RunEventAppendResult> {
    const result = await appendSessionEntry(sessionId, {
      type: 'run.event',
      timestamp: event.timestamp,
      entryId: event.eventId,
      turnId: event.turnId,
      runId: event.runId,
      stepId: event.stepId,
      data: { event },
    })
    if (result.entry.type !== 'run.event') throw new Error('invalid recovery journal entry')
    return {
      event: clone(result.entry.data.event) as RunEventAppendResult['event'],
      summary: clone(result.summary),
    }
  }

  return {
    async createConversation(workspace) {
      const createdAt = now()
      const id = createId()
      const summary: ReturnType<typeof projectConversation>['meta'] = {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id,
        title: DEFAULT_CONVERSATION_TITLE,
        createdAt,
        updatedAt: createdAt,
        ...(workspace ? { workspace: clone(workspace) } : {}),
      }
      const created = prepareSessionEntry(
        id,
        [],
        {
          type: 'session.created',
          timestamp: createdAt,
          entryId: `session:${id}`,
          data: { summary },
        },
        createEventId,
      ).entry
      journals.set(id, [created])
      return clone(summary)
    },
    async getConversation(sessionId) {
      return clone(projectConversation(requireJournal(sessionId)))
    },
    async listConversations() {
      return [...journals.values()]
        .map((entries) => projectConversation(entries).meta)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(clone)
    },
    appendSessionEntry,
    async listSessionEntries(sessionId) {
      return clone(requireJournal(sessionId))
    },
    async recoverInterruptedActivities(reason) {
      const recovered: RunEventAppendResult[] = []
      for (const [sessionId, entries] of journals) {
        const events = sessionRunEvents(entries)
        const record = projectConversation(entries)
        const recoveryEvent = createInterruptedConversationRecoveryEvent(events, {
          reason,
          activity: record.meta.activity,
        })
        if (recoveryEvent) recovered.push(await appendRecoveryEvent(sessionId, recoveryEvent))
      }
      return recovered.sort(
        (left, right) =>
          (right.summary?.updatedAt ?? right.event.timestamp) -
          (left.summary?.updatedAt ?? left.event.timestamp),
      )
    },
    async saveRunSnapshot(snapshot) {
      requireJournal(snapshot.identity.conversationId)
      const key = runKey(snapshot.identity.conversationId, snapshot.identity.runId)
      const prepared = prepareRunSnapshot(snapshot, snapshots.get(key))
      snapshots.set(key, clone(prepared))
      return clone(prepared)
    },
    async getRunSnapshot(sessionId, runId) {
      const snapshot = snapshots.get(runKey(sessionId, runId))
      return snapshot ? clone(snapshot) : null
    },
    async listRunSnapshots(sessionId) {
      return [...snapshots.values()]
        .filter((snapshot) => snapshot.identity.conversationId === sessionId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(clone)
    },
    async putBlob(sessionId, blobInput) {
      requireJournal(sessionId)
      const blobId = blobInput.blobId ?? createId()
      const ref: BlobRef = {
        schemaVersion: AILA_BLOB_SCHEMA_VERSION,
        blobId,
        contentType: blobInput.contentType,
        sizeBytes: blobSize(blobInput.data),
        ...(blobInput.preview ? { preview: blobInput.preview } : {}),
      }
      const key = blobKey(sessionId, blobId)
      const existing = blobs.get(key)
      const stored = { ref, data: clone(blobInput.data) }
      if (existing && JSON.stringify(existing) !== JSON.stringify(stored)) {
        throw new Error(`blob is immutable: ${blobId}`)
      }
      blobs.set(key, clone(stored))
      return clone(ref)
    },
    async getBlob(sessionId, blobId) {
      const blob = blobs.get(blobKey(sessionId, blobId))
      return blob ? clone(blob) : null
    },
    async deleteConversation(sessionId) {
      journals.delete(sessionId)
      for (const key of snapshots.keys()) {
        if (key.startsWith(`${sessionId}:`)) snapshots.delete(key)
      }
      for (const key of blobs.keys()) {
        if (key.startsWith(`${sessionId}:`)) blobs.delete(key)
      }
    },
  }
}
