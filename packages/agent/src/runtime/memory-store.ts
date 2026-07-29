import type { RunEvent } from '../agent-protocol'
import {
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  createInterruptedConversationRecoveryEvent,
  DEFAULT_CONVERSATION_TITLE,
  type RunEventAppendResult,
} from '../conversation-core'
import {
  AILA_BLOB_SCHEMA_VERSION,
  type BlobRef,
  createSessionTree,
  getSessionBranch,
  getSessionLeafId,
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
  const blobs = new Map<string, StoredBlob>()

  function requireJournal(sessionId: string): SessionEntry[] {
    const journal = journals.get(sessionId)
    if (!journal) throw new Error(`conversation not found: ${sessionId}`)
    return journal
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

  async function createConversationInternal(
    workspace?: Parameters<NonNullable<WorkbenchStore['createConversation']>>[0],
  ): Promise<ReturnType<typeof projectConversation>['meta']> {
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
  }

  function copyEntryInput(entry: SessionEntry): SessionEntryInput {
    const {
      schemaVersion: _schemaVersion,
      entryId: _entryId,
      sessionId: _sessionId,
      seq: _seq,
      parentId: _parentId,
      ...inputEntry
    } = clone(entry)
    return inputEntry as SessionEntryInput
  }

  return {
    createConversation: createConversationInternal,
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
    async getSessionTree(sessionId) {
      return clone(createSessionTree(requireJournal(sessionId)))
    },
    async getSessionBranch(sessionId, entryId) {
      const entries = requireJournal(sessionId)
      const leafId = entryId ?? getSessionLeafId(entries)
      if (!leafId) throw new Error(`conversation has no active leaf: ${sessionId}`)
      return clone(getSessionBranch(entries, leafId))
    },
    async setSessionLeaf(sessionId, entryId) {
      return appendSessionEntry(sessionId, {
        type: 'session.leaf.changed',
        timestamp: now(),
        data: { targetEntryId: entryId },
      })
    },
    async forkConversation(sessionId, entryId, workspace) {
      const sourceEntries = requireJournal(sessionId)
      const sourceLeafId = entryId ?? getSessionLeafId(sourceEntries)
      if (!sourceLeafId) throw new Error(`conversation has no active leaf: ${sessionId}`)
      const sourceBranch = getSessionBranch(sourceEntries, sourceLeafId)
      const sourceBranchIds = new Set(sourceBranch.map((entry) => entry.entryId))
      const copyableEntries = sourceEntries.filter(
        (entry) =>
          (entry.type !== 'session.created' && sourceBranchIds.has(entry.entryId)) ||
          (entry.type === 'extension.custom' &&
            entry.parentId !== null &&
            sourceBranchIds.has(entry.parentId)),
      )
      const sourceRecord = projectConversation(sourceEntries)
      const explicitTitle = [...sourceEntries]
        .reverse()
        .find((entry) => entry.type === 'conversation.renamed')
      const created = await createConversationInternal(workspace ?? sourceRecord.meta.workspace)
      const targetJournal = requireJournal(created.id)
      try {
        await appendSessionEntry(created.id, {
          type: 'session.forked',
          timestamp: now(),
          data: { origin: { sessionId, entryId: sourceLeafId } },
        })
        for (const entry of copyableEntries) {
          if (entry.payloadRef) {
            const sourceBlob = blobs.get(blobKey(sessionId, entry.payloadRef.blobId))
            if (!sourceBlob) {
              throw new Error(`fork source blob not found: ${entry.payloadRef.blobId}`)
            }
            blobs.set(blobKey(created.id, entry.payloadRef.blobId), clone(sourceBlob))
          }
          const prepared = prepareSessionEntry(
            created.id,
            targetJournal,
            copyEntryInput(entry),
            createEventId,
          )
          targetJournal.push(clone(prepared.entry))
        }
        if (explicitTitle?.type === 'conversation.renamed') {
          await appendSessionEntry(created.id, {
            type: 'conversation.renamed',
            timestamp: now(),
            data: { title: explicitTitle.data.title },
          })
        }
        return clone(projectConversation(targetJournal).meta)
      } catch (error) {
        journals.delete(created.id)
        for (const key of blobs.keys()) {
          if (key.startsWith(`${created.id}:`)) blobs.delete(key)
        }
        throw error
      }
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
    async collectGarbageBlobs(sessionId) {
      const entries = requireJournal(sessionId)
      const referenced = new Set(
        entries.flatMap((entry) => (entry.payloadRef ? [entry.payloadRef.blobId] : [])),
      )
      for (const event of sessionRunEvents(entries)) {
        if (event.runId) referenced.add(`run-context:${event.runId}`)
      }
      const deletedBlobIds: string[] = []
      const retainedBlobIds: string[] = []
      for (const key of [...blobs.keys()]) {
        if (!key.startsWith(`${sessionId}:`)) continue
        const blobId = key.slice(sessionId.length + 1)
        if (referenced.has(blobId)) retainedBlobIds.push(blobId)
        else {
          blobs.delete(key)
          deletedBlobIds.push(blobId)
        }
      }
      return {
        deletedBlobIds: deletedBlobIds.sort(),
        retainedBlobIds: retainedBlobIds.sort(),
      }
    },
    async deleteConversation(sessionId) {
      journals.delete(sessionId)
      for (const key of blobs.keys()) {
        if (key.startsWith(`${sessionId}:`)) blobs.delete(key)
      }
    },
  }
}
