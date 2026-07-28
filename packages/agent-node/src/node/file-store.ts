import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  createSessionTree,
  DEFAULT_CONVERSATION_TITLE,
  getSessionBranch,
  getSessionLeafId,
  normalizeRunSnapshot,
  prepareRunSnapshot,
  prepareSessionEntry,
  projectConversation,
  sessionRunEvents,
  validateSessionJournal,
} from '@aila/agent'
import { getNodeToolResultsConversationDir } from './tool-result-store'

export interface FileRuntimeStoreOptions {
  dataDir: string
  toolResultDir?: string
  createId?: () => string
  createEventId?: () => string
  now?: () => number
  /**
   * Upper bound on in-memory cached journals (LRU by touch). Unbounded when
   * omitted. The cache assumes this process is the only writer to dataDir;
   * out-of-process appends to a cached session are not observed.
   */
  maxCachedJournals?: number
}

export function createFileRuntimeStore(options: FileRuntimeStoreOptions): WorkbenchStore {
  const sessionsDir = join(options.dataDir, 'sessions')
  const createId = options.createId ?? randomUUID
  const createEventId = options.createEventId ?? randomUUID
  const now = options.now ?? Date.now
  const writeChains = new Map<string, Promise<void>>()
  // Parsed+validated journals, extended in place on append. Hits are verified
  // against the journal's byte size, so appends by other store instances (or
  // processes) invalidate instead of going stale. Insertion order doubles as
  // LRU order; entries are shared refs — public outputs must clone.
  interface CachedJournal {
    entries: SessionEntry[]
    maxSeq: number
    sizeBytes: number
  }
  const journalCache = new Map<string, CachedJournal>()

  function touchJournalCache(sessionId: string, cached: CachedJournal): void {
    journalCache.delete(sessionId)
    journalCache.set(sessionId, cached)
    if (options.maxCachedJournals !== undefined) {
      while (journalCache.size > Math.max(1, options.maxCachedJournals)) {
        const oldest = journalCache.keys().next().value
        if (oldest === undefined) break
        journalCache.delete(oldest)
      }
    }
  }

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
    const cached = journalCache.get(sessionId)
    if (cached) {
      let currentSize = -1
      try {
        currentSize = (await stat(journalPath(sessionId))).size
      } catch {
        // Missing or unreadable file: fall through to the full read below,
        // which surfaces the same error the uncached path always threw.
      }
      if (currentSize === cached.sizeBytes) {
        touchJournalCache(sessionId, cached)
        return cached.entries
      }
      journalCache.delete(sessionId)
    }
    const raw = await readFile(journalPath(sessionId), 'utf-8')
    const entries = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SessionEntry)
      .sort((left, right) => left.seq - right.seq)
    validateSessionJournal(entries)
    touchJournalCache(sessionId, {
      entries,
      maxSeq: entries.reduce((maximum, entry) => Math.max(maximum, entry.seq), 0),
      sizeBytes: Buffer.byteLength(raw, 'utf-8'),
    })
    return entries
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
      try {
        const entries = await readJournal(sessionId)
        const prepared = prepareSessionEntry(sessionId, entries, input, createEventId)
        if (!prepared.duplicate) {
          const line = `${JSON.stringify(prepared.entry)}\n`
          await appendFile(journalPath(sessionId), line, 'utf-8')
          entries.push(prepared.entry)
          const cached = journalCache.get(sessionId)
          if (cached && cached.entries === entries) {
            cached.maxSeq = Math.max(cached.maxSeq, prepared.entry.seq)
            cached.sizeBytes += Buffer.byteLength(line, 'utf-8')
          } else {
            journalCache.delete(sessionId)
          }
        }
        return {
          entry: structuredClone(prepared.entry),
          summary: structuredClone(projectConversation(entries).meta),
          ...(prepared.duplicate ? { duplicate: true } : {}),
        }
      } catch (error) {
        // A failed write may leave cache and file out of sync; re-read next time.
        journalCache.delete(sessionId)
        throw error
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

  async function createConversationInternal(
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
    const createdLine = `${JSON.stringify(created)}\n`
    await writeFile(journalPath(id), createdLine, 'utf-8')
    touchJournalCache(id, {
      entries: [created],
      maxSeq: created.seq,
      sizeBytes: Buffer.byteLength(createdLine, 'utf-8'),
    })
    return structuredClone(summary)
  }

  function copyEntryInput(entry: SessionEntry): SessionEntryInput {
    const {
      schemaVersion: _schemaVersion,
      entryId: _entryId,
      sessionId: _sessionId,
      seq: _seq,
      parentId: _parentId,
      ...inputEntry
    } = structuredClone(entry)
    return inputEntry as SessionEntryInput
  }

  return {
    createConversation: createConversationInternal,
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
            readJournal(decodeURIComponent(entry.name)).then(
              (entries) => projectConversation(entries).meta,
            ),
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
    async getSessionTree(sessionId) {
      return structuredClone(createSessionTree(await readJournal(sessionId)))
    },
    async getSessionBranch(sessionId, entryId) {
      const entries = await readJournal(sessionId)
      const leafId = entryId ?? getSessionLeafId(entries)
      if (!leafId) throw new Error(`conversation has no active leaf: ${sessionId}`)
      return structuredClone(getSessionBranch(entries, leafId))
    },
    async setSessionLeaf(sessionId, entryId) {
      return appendEntry(sessionId, {
        type: 'session.leaf.changed',
        timestamp: now(),
        data: { targetEntryId: entryId },
      })
    },
    async forkConversation(sessionId, entryId, workspace) {
      const sourceEntries = await readJournal(sessionId)
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
      try {
        await appendEntry(created.id, {
          type: 'session.forked',
          timestamp: now(),
          data: { origin: { sessionId, entryId: sourceLeafId } },
        })
        for (const entry of copyableEntries) {
          if (entry.payloadRef) {
            const sourceBlob = await readFile(blobPath(sessionId, entry.payloadRef.blobId), 'utf-8')
            await mkdir(blobsDir(created.id), { recursive: true })
            const targetBlobPath = blobPath(created.id, entry.payloadRef.blobId)
            try {
              const existingBlob = await readFile(targetBlobPath, 'utf-8')
              if (existingBlob !== sourceBlob) {
                throw new Error(`fork target blob is immutable: ${entry.payloadRef.blobId}`)
              }
            } catch (error) {
              if (!isErrnoCode(error, 'ENOENT')) throw error
              await writeFile(targetBlobPath, sourceBlob, { encoding: 'utf-8', flag: 'wx' })
            }
          }
          await appendEntry(created.id, copyEntryInput(entry))
        }
        if (explicitTitle?.type === 'conversation.renamed') {
          await appendEntry(created.id, {
            type: 'conversation.renamed',
            timestamp: now(),
            data: { title: explicitTitle.data.title },
          })
        }
        return structuredClone(projectConversation(await readJournal(created.id)).meta)
      } catch (error) {
        journalCache.delete(created.id)
        await rm(sessionDir(created.id), { recursive: true, force: true }).catch(() => {})
        throw error
      }
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
        const entries = await readJournal(snapshot.identity.conversationId)
        getSessionBranch(entries, snapshot.sessionLeafId)
        const maximumSeq = entries.reduce((maximum, entry) => Math.max(maximum, entry.seq), 0)
        if (snapshot.throughSeq > maximumSeq) {
          throw new Error(`run snapshot exceeds session journal: ${snapshot.throughSeq}`)
        }
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
          .map((file) => this.getRunSnapshot(sessionId, decodeURIComponent(file.slice(0, -5)))),
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
    async collectGarbageBlobs(sessionId) {
      return queueWrite(sessionId, async () => {
        const entries = await readJournal(sessionId)
        const referenced = new Set(
          entries.flatMap((entry) => (entry.payloadRef ? [entry.payloadRef.blobId] : [])),
        )
        try {
          const snapshotFiles = await readdir(snapshotsDir(sessionId))
          for (const file of snapshotFiles.filter((candidate) => candidate.endsWith('.json'))) {
            const snapshot = normalizeRunSnapshot(
              JSON.parse(await readFile(join(snapshotsDir(sessionId), file), 'utf-8')),
            )
            referenced.add(snapshot.contextRef.blobId)
          }
        } catch (error) {
          if (!isErrnoCode(error, 'ENOENT')) throw error
        }

        let blobFiles: string[]
        try {
          blobFiles = await readdir(blobsDir(sessionId))
        } catch (error) {
          if (isErrnoCode(error, 'ENOENT')) {
            return { deletedBlobIds: [], retainedBlobIds: [] }
          }
          throw error
        }
        const deletedBlobIds: string[] = []
        const retainedBlobIds: string[] = []
        for (const file of blobFiles.filter((candidate) => candidate.endsWith('.json'))) {
          const blobId = decodeURIComponent(file.slice(0, -5))
          if (referenced.has(blobId)) retainedBlobIds.push(blobId)
          else {
            await rm(join(blobsDir(sessionId), file), { force: true })
            deletedBlobIds.push(blobId)
          }
        }
        return {
          deletedBlobIds: deletedBlobIds.sort(),
          retainedBlobIds: retainedBlobIds.sort(),
        }
      })
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
        journalCache.delete(sessionId)
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
