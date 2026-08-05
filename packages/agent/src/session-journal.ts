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
  | 'model_request'
  | 'model_response'
  | 'tool_batch'
  | 'tool_request'
  | 'tool_result'
  | 'compaction'

export interface RunPayloadData {
  kind: RunPayloadKind
  label: string
  modelMessage?: ChatMessage
  modelMessages?: ChatMessage[]
  assistantMessage?: PersistedMessage
}

export type SessionPhase = 'idle' | 'turn' | 'compaction' | 'retry'

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
  'extension.message',
])

export function sessionEntryAdvancesLeaf(entry: Pick<SessionEntry, 'type'>): boolean {
  return SEMANTIC_ENTRY_TYPES.has(entry.type)
}

function sortSessionEntryRefs(entries: readonly SessionEntry[]): SessionEntry[] {
  return [...entries].sort(
    (left, right) => left.seq - right.seq || left.timestamp - right.timestamp,
  )
}

/**
 * Sorted, deduplicated entry references without cloning. Internal fast path;
 * callers own nothing and must not mutate the results.
 */
function orderSessionEntryRefs(entries: readonly SessionEntry[]): SessionEntry[] {
  const seen = new Set<string>()
  const refs: SessionEntry[] = []
  for (const entry of sortSessionEntryRefs(entries)) {
    if (seen.has(entry.entryId)) continue
    seen.add(entry.entryId)
    refs.push(entry)
  }
  return refs
}

export function orderedSessionEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  return orderSessionEntryRefs(entries).map((entry) => structuredClone(entry))
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
  // Sorted but NOT deduplicated: duplicate entry ids must still throw here.
  validateOrderedRefs(sortSessionEntryRefs(entries))
}

/** Validation over pre-ordered references; reads only, never clones. */
function validateOrderedRefs(ordered: readonly SessionEntry[]): void {
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

function getSessionLeafIdFromOrdered(ordered: readonly SessionEntry[]): string | null {
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

export function getSessionLeafId(entries: readonly SessionEntry[]): string | null {
  const ordered = orderSessionEntryRefs(entries)
  if (ordered.length === 0) return null
  validateOrderedRefs(ordered)
  return getSessionLeafIdFromOrdered(ordered)
}

function getSessionPhaseFromOrdered(ordered: readonly SessionEntry[]): SessionPhase {
  let phase: SessionPhase = 'idle'
  for (const entry of ordered) {
    if (entry.type === 'session.phase.changed') phase = entry.data.phase
  }
  return phase
}

export function getSessionPhase(entries: readonly SessionEntry[]): SessionPhase {
  return getSessionPhaseFromOrdered(orderSessionEntryRefs(entries))
}

/** Root-to-leaf references over pre-validated ordered refs; output is cloned. */
function getSessionBranchFromOrdered(
  ordered: readonly SessionEntry[],
  leafId: string,
): SessionEntry[] {
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

export function getActiveSessionBranch(entries: readonly SessionEntry[]): SessionEntry[] {
  const ordered = orderSessionEntryRefs(entries)
  if (ordered.length === 0) return []
  validateOrderedRefs(ordered)
  const leafId = getSessionLeafIdFromOrdered(ordered)
  if (!leafId) return []
  return getSessionBranchFromOrdered(ordered, leafId)
}

export function getSessionBranch(entries: readonly SessionEntry[], leafId: string): SessionEntry[] {
  const ordered = orderSessionEntryRefs(entries)
  validateOrderedRefs(ordered)
  return getSessionBranchFromOrdered(ordered, leafId)
}

export function createSessionTree(entries: readonly SessionEntry[]): SessionTree {
  const ordered = orderSessionEntryRefs(entries)
  validateOrderedRefs(ordered)
  const root = ordered.find(
    (entry): entry is SessionEntry<'session.created'> => entry.type === 'session.created',
  )
  const leafId = getSessionLeafIdFromOrdered(ordered)
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
    phase: getSessionPhaseFromOrdered(ordered),
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

  const ordered = orderSessionEntryRefs(existing)
  const seq = existing.reduce((maximum, entry) => Math.max(maximum, entry.seq), 0) + 1
  const parentId =
    input.type === 'session.created'
      ? null
      : (input.parentId ?? getSessionLeafIdFromOrdered(ordered))
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
  assertAppendedEntry(ordered, prepared)
  return { entry: prepared, duplicate: false }
}

/**
 * Incremental validation of a single appended entry against an already
 * validated journal — replaces re-validating the whole array per append.
 * Error messages mirror validateOrderedRefs exactly.
 */
function assertAppendedEntry(ordered: readonly SessionEntry[], prepared: SessionEntry): void {
  if (prepared.schemaVersion !== AILA_SESSION_ENTRY_SCHEMA_VERSION) {
    throw new Error(`unsupported session entry schema: ${prepared.schemaVersion}`)
  }
  const maxSeq = ordered.length === 0 ? 0 : ordered[ordered.length - 1].seq
  if (!Number.isInteger(prepared.seq) || prepared.seq <= maxSeq) {
    throw new Error(`invalid session journal sequence: ${prepared.seq}`)
  }
  if (prepared.type === 'session.created') {
    if (ordered.length > 0 || prepared.parentId !== null || prepared.seq !== 1) {
      throw new Error('session journal must have exactly one root session.created entry')
    }
  } else {
    const root = ordered[0]
    if (!root || root.type !== 'session.created') {
      throw new Error('session journal is missing session.created')
    }
    if (prepared.sessionId !== root.sessionId) {
      throw new Error(`session entry belongs to another session: ${prepared.entryId}`)
    }
    const byId = new Map(ordered.map((entry) => [entry.entryId, entry]))
    if (prepared.parentId === null || !byId.has(prepared.parentId)) {
      throw new Error(`session entry parent not found: ${prepared.entryId}`)
    }
    const parent = byId.get(prepared.parentId)
    if (!parent || !sessionEntryAdvancesLeaf(parent)) {
      throw new Error(`session entry parent is not a semantic entry: ${prepared.entryId}`)
    }
    if (prepared.type === 'session.leaf.changed') {
      const target = prepared.data.targetEntryId
      const targetEntry = target ? byId.get(target) : undefined
      if (target === null || !targetEntry || !sessionEntryAdvancesLeaf(targetEntry)) {
        throw new Error(`invalid session leaf target: ${target ?? 'null'}`)
      }
    }
  }
  if (prepared.type === 'extension.custom' || prepared.type === 'extension.message') {
    assertExtensionIdentity(prepared)
  }
}

function transformedActiveBranchFromOrdered(
  ordered: readonly SessionEntry[],
  options: SessionProjectionOptions,
): SessionEntry[] {
  const leafId = getSessionLeafIdFromOrdered(ordered)
  if (!leafId) return []
  const byId = new Map(ordered.map((entry) => [entry.entryId, entry]))
  const requestedLeaf = byId.get(leafId)
  if (!requestedLeaf || !sessionEntryAdvancesLeaf(requestedLeaf)) {
    throw new Error(`invalid session branch leaf: ${leafId}`)
  }
  const semanticIds = new Set<string>()
  let cursor: string | null = requestedLeaf.entryId
  while (cursor) {
    const entry = byId.get(cursor)
    if (!entry) throw new Error(`session branch entry not found: ${cursor}`)
    semanticIds.add(entry.entryId)
    cursor = entry.parentId
  }
  // The clone here establishes ownership for the projection and for the
  // caller-supplied transforms; entries upstream are shared references.
  let branch = ordered
    .filter(
      (entry) =>
        semanticIds.has(entry.entryId) ||
        (entry.type === 'extension.custom' &&
          entry.parentId !== null &&
          semanticIds.has(entry.parentId)),
    )
    .map((entry) => structuredClone(entry))
  for (const transform of options.entryTransforms ?? []) {
    branch = [...transform(branch)].map((entry) => structuredClone(entry))
  }
  return branch
}

export function projectConversation(
  entries: readonly SessionEntry[],
  options: SessionProjectionOptions = {},
): ConversationRecord {
  const ordered = orderSessionEntryRefs(entries)
  validateOrderedRefs(ordered)
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
        meta.usage = createConversationUsageSnapshot(
          meta.usage,
          structuredClone(entry.data.usage),
          entry.timestamp,
        )
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
  for (const entry of transformedActiveBranchFromOrdered(ordered, options)) {
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
  return orderSessionEntryRefs(entries).flatMap((entry) =>
    entry.type === 'run.event' ? [structuredClone(entry.data.event) as PersistedRunEvent] : [],
  )
}

export function sessionRunPayloads(
  entries: readonly SessionEntry[],
  runId?: string,
): Array<SessionEntry<'run.payload'>> {
  return orderSessionEntryRefs(entries)
    .filter(
      (entry): entry is SessionEntry<'run.payload'> =>
        entry.type === 'run.payload' && (!runId || entry.runId === runId),
    )
    .map((entry) => structuredClone(entry))
}
