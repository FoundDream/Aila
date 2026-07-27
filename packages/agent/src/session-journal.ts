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

export const AILA_SESSION_ENTRY_SCHEMA_VERSION = 2
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

export interface BlobGarbageCollectionResult {
  deletedBlobIds: string[]
  retainedBlobIds: string[]
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

export type SessionPhase = 'idle' | 'turn' | 'compaction' | 'branch_summary' | 'retry'

export interface SessionOrigin {
  sessionId: string
  entryId: string | null
}

export interface SessionExtensionData {
  namespace: string
  version: number
  data: unknown
}

export interface SessionExtensionMessageData {
  namespace: string
  version: number
  message: PersistedMessage
}

export interface SessionEntryDataMap {
  'session.created': { summary: ConversationSummary }
  'session.forked': { origin: SessionOrigin }
  'session.leaf.changed': { targetEntryId: string | null }
  'session.phase.changed': { phase: SessionPhase }
  'conversation.renamed': { title: string }
  'message.committed': { message: PersistedMessage }
  'usage.recorded': { usage: UsageInfo }
  'run.event': { event: RunEvent | PersistedRunEvent }
  'run.payload': RunPayloadData
  'context.compacted': { checkpoint: ConversationContextCheckpoint }
  'context.turn.recorded': { entry: ConversationContextTurnLedgerEntry }
  'context.branch.summary': { summary: string }
  'extension.custom': SessionExtensionData
  'extension.message': SessionExtensionMessageData
}

export type SessionEntryType = keyof SessionEntryDataMap

export interface SessionEntryIdentity {
  entryId: string
  sessionId: string
  seq: number
  timestamp: number
  /**
   * Logical context parent. Observation entries are anchored to the current
   * semantic leaf but do not advance it.
   */
  parentId: string | null
  turnId?: string
  runId?: string
  stepId?: string
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
  [Type in TType]: Omit<
    SessionEntry<Type>,
    'schemaVersion' | 'sessionId' | 'seq' | 'entryId' | 'parentId'
  > & {
    entryId?: string
    /** Defaults to the active semantic leaf. */
    parentId?: string | null
  }
}[TType]

export interface SessionEntryAppendResult {
  entry: SessionEntry
  summary: ConversationSummary
  duplicate?: boolean
}

export interface SessionTreeNode {
  entry: SessionEntry
  children: string[]
}

export interface SessionTree {
  sessionId: string
  rootId: string
  leafId: string
  phase: SessionPhase
  nodes: SessionTreeNode[]
}

export interface SessionProjectionOptions {
  /**
   * Pure transforms applied to the active semantic branch before projection.
   * They may remove or replace entries, but must preserve root-to-leaf order.
   */
  entryTransforms?: readonly ((entries: readonly SessionEntry[]) => readonly SessionEntry[])[]
  /** Optional projectors for namespaced extension.custom entries. */
  customEntryProjectors?: Readonly<
    Record<string, (entry: SessionEntry<'extension.custom'>) => PersistedMessage | null>
  >
}

const SEMANTIC_ENTRY_TYPES = new Set<SessionEntryType>([
  'session.created',
  'message.committed',
  'context.compacted',
  'context.branch.summary',
  'extension.message',
])

export function sessionEntryAdvancesLeaf(entry: Pick<SessionEntry, 'type'>): boolean {
  return SEMANTIC_ENTRY_TYPES.has(entry.type)
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

function assertExtensionIdentity(
  entry: SessionEntry<'extension.custom'> | SessionEntry<'extension.message'>,
): void {
  if (!entry.data.namespace.trim()) throw new Error('session extension namespace is required')
  if (!Number.isInteger(entry.data.version) || entry.data.version < 1) {
    throw new Error('session extension version must be a positive integer')
  }
}

export function validateSessionJournal(entries: readonly SessionEntry[]): void {
  const ordered = [...entries]
    .sort((left, right) => left.seq - right.seq || left.timestamp - right.timestamp)
    .map((entry) => structuredClone(entry))
  if (ordered.length === 0) return
  const byId = new Map<string, SessionEntry>()
  let root: SessionEntry<'session.created'> | undefined
  let previousSeq = 0

  for (const entry of ordered) {
    if (entry.schemaVersion !== AILA_SESSION_ENTRY_SCHEMA_VERSION) {
      throw new Error(`unsupported session entry schema: ${entry.schemaVersion}`)
    }
    if (!Number.isInteger(entry.seq) || entry.seq <= previousSeq) {
      throw new Error(`invalid session journal sequence: ${entry.seq}`)
    }
    previousSeq = entry.seq
    if (byId.has(entry.entryId)) throw new Error(`duplicate session entry: ${entry.entryId}`)
    if (entry.type === 'session.created') {
      if (root || entry.parentId !== null || entry.seq !== 1) {
        throw new Error('session journal must have exactly one root session.created entry')
      }
      root = entry
    } else {
      if (!root) throw new Error('session journal is missing session.created')
      if (entry.sessionId !== root.sessionId) {
        throw new Error(`session entry belongs to another session: ${entry.entryId}`)
      }
      if (entry.parentId === null || !byId.has(entry.parentId)) {
        throw new Error(`session entry parent not found: ${entry.entryId}`)
      }
      const parent = byId.get(entry.parentId)
      if (!parent || !sessionEntryAdvancesLeaf(parent)) {
        throw new Error(`session entry parent is not a semantic entry: ${entry.entryId}`)
      }
    }
    if (entry.type === 'session.leaf.changed') {
      const target = entry.data.targetEntryId
      const targetEntry = target ? byId.get(target) : undefined
      if (target === null || !targetEntry || !sessionEntryAdvancesLeaf(targetEntry)) {
        throw new Error(`invalid session leaf target: ${target ?? 'null'}`)
      }
    }
    if (entry.type === 'extension.custom' || entry.type === 'extension.message') {
      assertExtensionIdentity(entry)
    }
    byId.set(entry.entryId, entry)
  }
  if (!root) throw new Error('session journal is missing session.created')
}

export function getSessionLeafId(entries: readonly SessionEntry[]): string | null {
  const ordered = orderedSessionEntries(entries)
  if (ordered.length === 0) return null
  validateSessionJournal(ordered)
  let leafId: string | null = null
  for (const entry of ordered) {
    if (entry.type === 'session.leaf.changed') {
      leafId = entry.data.targetEntryId
    } else if (sessionEntryAdvancesLeaf(entry)) {
      leafId = entry.entryId
    }
  }
  return leafId
}

export function getSessionPhase(entries: readonly SessionEntry[]): SessionPhase {
  let phase: SessionPhase = 'idle'
  for (const entry of orderedSessionEntries(entries)) {
    if (entry.type === 'session.phase.changed') phase = entry.data.phase
  }
  return phase
}

export function getActiveSessionBranch(entries: readonly SessionEntry[]): SessionEntry[] {
  const ordered = orderedSessionEntries(entries)
  const leafId = getSessionLeafId(ordered)
  if (!leafId) return []
  return getSessionBranch(ordered, leafId)
}

export function getSessionBranch(entries: readonly SessionEntry[], leafId: string): SessionEntry[] {
  const ordered = orderedSessionEntries(entries)
  validateSessionJournal(ordered)
  const byId = new Map(ordered.map((entry) => [entry.entryId, entry]))
  const requestedLeaf = byId.get(leafId)
  if (!requestedLeaf || !sessionEntryAdvancesLeaf(requestedLeaf)) {
    throw new Error(`invalid session branch leaf: ${leafId}`)
  }
  const branch: SessionEntry[] = []
  let cursor: string | null = requestedLeaf.entryId
  while (cursor) {
    const entry = byId.get(cursor)
    if (!entry) throw new Error(`session branch entry not found: ${cursor}`)
    branch.push(structuredClone(entry))
    cursor = entry.parentId
  }
  return branch.reverse()
}

export function createSessionTree(entries: readonly SessionEntry[]): SessionTree {
  const ordered = orderedSessionEntries(entries)
  validateSessionJournal(ordered)
  const root = ordered.find(
    (entry): entry is SessionEntry<'session.created'> => entry.type === 'session.created',
  )
  const leafId = getSessionLeafId(ordered)
  if (!root || !leafId) throw new Error('session journal has no active branch')
  const children = new Map<string, string[]>()
  for (const entry of ordered) {
    if (!sessionEntryAdvancesLeaf(entry) || entry.parentId === null) continue
    const values = children.get(entry.parentId) ?? []
    values.push(entry.entryId)
    children.set(entry.parentId, values)
  }
  return {
    sessionId: root.sessionId,
    rootId: root.entryId,
    leafId,
    phase: getSessionPhase(ordered),
    nodes: ordered.filter(sessionEntryAdvancesLeaf).map((entry) => ({
      entry: structuredClone(entry),
      children: [...(children.get(entry.entryId) ?? [])],
    })),
  }
}

export function prepareSessionEntry(
  sessionId: string,
  existing: readonly SessionEntry[],
  input: SessionEntryInput,
  createId: () => string,
): { entry: SessionEntry; duplicate: boolean } {
  validateSessionJournal(existing)
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
      parentId: input.parentId === undefined ? duplicate.parentId : input.parentId,
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
  const parentId =
    input.type === 'session.created' ? null : (input.parentId ?? getSessionLeafId(existing))
  const prepared = {
    ...structuredClone(input),
    schemaVersion: AILA_SESSION_ENTRY_SCHEMA_VERSION,
    entryId,
    sessionId,
    seq,
    parentId,
  } as SessionEntry
  if (prepared.type === 'run.event') {
    prepared.data.event = {
      ...structuredClone(prepared.data.event),
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      eventId: entryId,
      seq,
    } as PersistedRunEvent
  }
  validateSessionJournal([...existing, prepared])
  return { entry: prepared, duplicate: false }
}

function transformedActiveBranch(
  entries: readonly SessionEntry[],
  options: SessionProjectionOptions,
): SessionEntry[] {
  const semanticBranch = getActiveSessionBranch(entries)
  const semanticIds = new Set(semanticBranch.map((entry) => entry.entryId))
  let branch = orderedSessionEntries(entries).filter(
    (entry) =>
      semanticIds.has(entry.entryId) ||
      (entry.type === 'extension.custom' &&
        entry.parentId !== null &&
        semanticIds.has(entry.parentId)),
  )
  for (const transform of options.entryTransforms ?? []) {
    branch = [...transform(branch)].map((entry) => structuredClone(entry))
  }
  return branch
}

export function projectConversation(
  entries: readonly SessionEntry[],
  options: SessionProjectionOptions = {},
): ConversationRecord {
  const ordered = orderedSessionEntries(entries)
  validateSessionJournal(ordered)
  const created = ordered.find(
    (entry): entry is SessionEntry<'session.created'> => entry.type === 'session.created',
  )
  if (!created) throw new Error('session journal is missing session.created')

  const meta = structuredClone(created.data.summary)
  const messages: PersistedMessage[] = []
  const runEvents: PersistedRunEvent[] = []

  // Session-wide observations and metadata do not depend on the selected branch.
  for (const entry of ordered) {
    meta.updatedAt = Math.max(meta.updatedAt, entry.timestamp)
    switch (entry.type) {
      case 'conversation.renamed':
        meta.title = entry.data.title.trim() || DEFAULT_CONVERSATION_TITLE
        break
      case 'usage.recorded':
        meta.usage = createConversationUsageSnapshot(meta.usage, entry.data.usage, entry.timestamp)
        break
      case 'run.event':
        runEvents.push(structuredClone(entry.data.event) as PersistedRunEvent)
        break
      case 'context.turn.recorded':
        meta.context = appendConversationContextTurnLedgerEntry(
          meta.context,
          structuredClone(entry.data.entry),
        )
        break
    }
  }

  // Context-bearing state is projected only from the active root-to-leaf branch.
  for (const entry of transformedActiveBranch(ordered, options)) {
    switch (entry.type) {
      case 'message.committed': {
        const message = preparePersistedMessage(entry.data.message)
        upsertPersistedMessage(messages, message)
        if (meta.title === DEFAULT_CONVERSATION_TITLE) {
          meta.title = deriveConversationTitle(message) ?? meta.title
        }
        break
      }
      case 'extension.message':
        upsertPersistedMessage(messages, preparePersistedMessage(entry.data.message))
        break
      case 'extension.custom': {
        const projected = options.customEntryProjectors?.[entry.data.namespace]?.(entry)
        if (projected) upsertPersistedMessage(messages, preparePersistedMessage(projected))
        break
      }
      case 'context.compacted':
        meta.context = {
          ...(meta.context ?? {}),
          checkpoint: structuredClone(entry.data.checkpoint),
        }
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
