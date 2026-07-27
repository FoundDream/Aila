import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BlobRef,
  ConversationSummary,
  ConversationWorkspaceRef,
  RunEvent,
  RunEventAppendResult,
  RunSnapshot,
  SessionEntry,
  SessionEntryInput,
  StoredBlob,
  WorkbenchStore,
} from '@aila/agent'
import {
  AILA_BLOB_SCHEMA_VERSION,
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  createInterruptedConversationRecoveryEvent,
  DEFAULT_CONVERSATION_TITLE,
  normalizeRunSnapshot,
  prepareRunSnapshot,
  prepareSessionEntry,
  projectConversation,
  sessionRunEvents,
} from '@aila/agent'
import { getNodeToolResultsConversationDir } from './tool-result-store'

export interface FileRuntimeStoreOptions {
  dataDir: string
  toolResultDir?: string
  createId?: () => string
  createEventId?: () => string
  now?: () => number
}

export function createFileRuntimeStore(options: FileRuntimeStoreOptions): WorkbenchStore {
  const sessionsDir = join(options.dataDir, 'sessions')
  const createId = options.createId ?? randomUUID
  const createEventId = options.createEventId ?? randomUUID
  const now = options.now ?? Date.now
  const writeChains = new Map<string, Promise<void>>()

  function sessionDir(sessionId: string): string {
    return join(sessionsDir, encodeURIComponent(sessionId))
  }

  function journalPath(sessionId: string): string {
    return join(sessionDir(sessionId), 'entries.jsonl')
  }

  function snapshotsDir(sessionId: string): string {
    return join(sessionDir(sessionId), 'snapshots')
  }

  function snapshotPath(sessionId: string, runId: string): string {
    return join(snapshotsDir(sessionId), `${encodeURIComponent(runId)}.json`)
  }

  function blobsDir(sessionId: string): string {
    return join(sessionDir(sessionId), 'blobs')
  }

  function blobPath(sessionId: string, blobId: string): string {
    return join(blobsDir(sessionId), `${encodeURIComponent(blobId)}.json`)
  }

  async function queueWrite<T>(sessionId: string, writer: () => Promise<T>): Promise<T> {
    const previous = writeChains.get(sessionId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(writer)
    const guard = run.then(
      () => undefined,
      () => undefined,
    )
    writeChains.set(sessionId, guard)
    guard.finally(() => {
      if (writeChains.get(sessionId) === guard) writeChains.delete(sessionId)
    })
    return run
  }

  async function readJournal(sessionId: string): Promise<SessionEntry[]> {
    const raw = await readFile(journalPath(sessionId), 'utf-8')
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SessionEntry)
      .sort((left, right) => left.seq - right.seq)
  }

  async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
      await rename(temporaryPath, path)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {})
      throw error
    }
  }

  async function appendEntry(
    sessionId: string,
    input: SessionEntryInput,
  ): Promise<
    ReturnType<WorkbenchStore['appendSessionEntry']> extends Promise<infer T> ? T : never
  > {
    return queueWrite(sessionId, async () => {
      const entries = await readJournal(sessionId)
      const prepared = prepareSessionEntry(sessionId, entries, input, createEventId)
      if (!prepared.duplicate) {
        await appendFile(journalPath(sessionId), `${JSON.stringify(prepared.entry)}\n`, 'utf-8')
        entries.push(prepared.entry)
      }
      return {
        entry: structuredClone(prepared.entry),
        summary: structuredClone(projectConversation(entries).meta),
        ...(prepared.duplicate ? { duplicate: true } : {}),
      }
    })
  }

  async function appendRecoveryEvent(
    sessionId: string,
    event: RunEvent,
  ): Promise<RunEventAppendResult> {
    const result = await appendEntry(sessionId, {
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
      event: structuredClone(result.entry.data.event) as RunEventAppendResult['event'],
      summary: structuredClone(result.summary),
    }
  }

  return {
    async createConversation(
      workspace?: ConversationWorkspaceRef | null,
    ): Promise<ConversationSummary> {
      const createdAt = now()
      const id = createId()
      const summary: ConversationSummary = {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id,
        title: DEFAULT_CONVERSATION_TITLE,
        createdAt,
        updatedAt: createdAt,
        ...(workspace ? { workspace: structuredClone(workspace) } : {}),
      }
      const dir = sessionDir(id)
      await mkdir(dir, { recursive: true })
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
      await writeFile(journalPath(id), `${JSON.stringify(created)}\n`, 'utf-8')
      return structuredClone(summary)
    },
    async getConversation(sessionId) {
      return structuredClone(projectConversation(await readJournal(sessionId)))
    },
    async listConversations() {
      await mkdir(sessionsDir, { recursive: true })
      const directories = await readdir(sessionsDir, { withFileTypes: true })
      const records = await Promise.all(
        directories
          .filter((entry) => entry.isDirectory() && !entry.name.includes('.deleting-'))
          .map((entry) =>
            readJournal(decodeURIComponent(entry.name))
              .then((entries) => projectConversation(entries).meta)
              .catch(() => null),
          ),
      )
      return records
        .filter((summary): summary is ConversationSummary => summary !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((summary) => structuredClone(summary))
    },
    appendSessionEntry: appendEntry,
    async listSessionEntries(sessionId) {
      return structuredClone(await readJournal(sessionId))
    },
    async recoverInterruptedActivities(reason) {
      const summaries = (await this.listConversations?.()) ?? []
      const recovered: RunEventAppendResult[] = []
      for (const summary of summaries) {
        const entries = await readJournal(summary.id)
        const events = sessionRunEvents(entries)
        const recoveryEvent = createInterruptedConversationRecoveryEvent(events, {
          reason,
          activity: projectConversation(entries).meta.activity,
        })
        if (recoveryEvent) recovered.push(await appendRecoveryEvent(summary.id, recoveryEvent))
      }
      return recovered
    },
    async saveRunSnapshot(snapshot) {
      return queueWrite(snapshot.identity.conversationId, async () => {
        await readJournal(snapshot.identity.conversationId)
        let previous: RunSnapshot | undefined
        try {
          previous = normalizeRunSnapshot(
            JSON.parse(
              await readFile(
                snapshotPath(snapshot.identity.conversationId, snapshot.identity.runId),
                'utf-8',
              ),
            ),
          )
        } catch (error) {
          if (!isErrnoCode(error, 'ENOENT')) throw error
        }
        const prepared = prepareRunSnapshot(snapshot, previous)
        await mkdir(snapshotsDir(snapshot.identity.conversationId), { recursive: true })
        await writeJsonAtomic(
          snapshotPath(prepared.identity.conversationId, prepared.identity.runId),
          prepared,
        )
        return structuredClone(prepared)
      })
    },
    async getRunSnapshot(sessionId, runId) {
      try {
        return structuredClone(
          normalizeRunSnapshot(JSON.parse(await readFile(snapshotPath(sessionId, runId), 'utf-8'))),
        )
      } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) return null
        throw error
      }
    },
    async listRunSnapshots(sessionId) {
      await readJournal(sessionId)
      let files: string[]
      try {
        files = await readdir(snapshotsDir(sessionId))
      } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) return []
        throw error
      }
      const snapshots = await Promise.all(
        files
          .filter((file) => file.endsWith('.json'))
          .map((file) =>
            this.getRunSnapshot(sessionId, decodeURIComponent(file.slice(0, -5))).catch(() => null),
          ),
      )
      return snapshots
        .filter((snapshot): snapshot is RunSnapshot => snapshot !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt)
    },
    async putBlob(sessionId, input) {
      return queueWrite(sessionId, async () => {
        await readJournal(sessionId)
        const blobId = input.blobId ?? createId()
        const ref: BlobRef = {
          schemaVersion: AILA_BLOB_SCHEMA_VERSION,
          blobId,
          contentType: input.contentType,
          sizeBytes: blobSize(input.data),
          ...(input.preview ? { preview: input.preview } : {}),
        }
        const stored: StoredBlob = { ref, data: structuredClone(input.data) }
        const path = blobPath(sessionId, blobId)
        await mkdir(blobsDir(sessionId), { recursive: true })
        try {
          const existing = JSON.parse(await readFile(path, 'utf-8')) as StoredBlob
          if (JSON.stringify(existing) !== JSON.stringify(stored)) {
            throw new Error(`blob is immutable: ${blobId}`)
          }
          return structuredClone(existing.ref)
        } catch (error) {
          if (!isErrnoCode(error, 'ENOENT')) throw error
        }
        await writeJsonAtomic(path, stored)
        return structuredClone(ref)
      })
    },
    async getBlob(sessionId, blobId) {
      try {
        return structuredClone(
          JSON.parse(await readFile(blobPath(sessionId, blobId), 'utf-8')) as StoredBlob,
        )
      } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) return null
        throw error
      }
    },
    async deleteConversation(sessionId) {
      await (writeChains.get(sessionId) ?? Promise.resolve()).catch(() => {})
      const source = sessionDir(sessionId)
      const tombstone = `${source}.deleting-${randomUUID()}`
      let moved = false
      try {
        await rename(source, tombstone)
        moved = true
        await rm(getNodeToolResultsConversationDir(sessionId, options), {
          recursive: true,
          force: true,
        })
        await rm(tombstone, { recursive: true, force: true })
      } catch (error) {
        if (moved) await rename(tombstone, source).catch(() => {})
        if (!moved && isErrnoCode(error, 'ENOENT')) return
        throw error
      } finally {
        writeChains.delete(sessionId)
      }
    },
  }
}

function blobSize(data: unknown): number {
  return Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data), 'utf-8')
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}
