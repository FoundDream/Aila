import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent } from './agent-protocol'
import {
  type AgentEventAppendResult,
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  activityFromAgentEvent,
  type ConversationMeta,
  type ConversationRecord,
  type ConversationSummary,
  conversationActivityEquals,
  createInterruptedConversationRecoveryEvent,
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
  interruptedRecoveryEventFromLegacyActivity,
  normalizeAgentEvent,
  normalizeConversationMeta,
  normalizePersistedMessage,
  orderedUniqueAgentEvents,
  type PersistedAgentEvent,
  type PersistedMessage,
  prepareAgentEvent,
  preparePersistedMessage,
  replayConversationActivity,
  upsertPersistedMessage,
} from './conversation-core'
import { getConversationsDir } from './paths'

export {
  type AgentEventAppendResult,
  AILA_AGENT_EVENT_SCHEMA_VERSION,
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  type ConversationActivity,
  type ConversationActivityState,
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
  orderedUniqueAgentEvents,
  type PersistedAgentEvent,
  type PersistedBlock,
  type PersistedFileBlock,
  type PersistedImageBlock,
  type PersistedMessage,
  type PersistedTextBlock,
  type PersistedToolCallBlock,
  replayConversationActivity,
  replayConversationRuntimeState,
} from './conversation-core'

const metaWriteChains = new Map<string, Promise<void>>()
const messageWriteChains = new Map<string, Promise<void>>()
const eventWriteChains = new Map<string, Promise<void>>()

async function ensureDir(): Promise<string> {
  const dir = getConversationsDir()
  await mkdir(dir, { recursive: true })
  return dir
}

function logPath(id: string): string {
  return join(getConversationsDir(), `${id}.jsonl`)
}

function eventLogPath(id: string): string {
  return join(getConversationsDir(), `${id}.events.jsonl`)
}

function metaPath(id: string): string {
  return join(getConversationsDir(), `${id}.meta.json`)
}

async function readMeta(id: string): Promise<ConversationMeta> {
  const raw = await readFile(metaPath(id), 'utf-8')
  return normalizeConversationMeta(JSON.parse(raw) as Partial<ConversationMeta>, id)
}

async function writeMeta(meta: ConversationMeta): Promise<void> {
  await ensureDir()
  await writeFile(
    metaPath(meta.id),
    JSON.stringify(normalizeConversationMeta(meta), null, 2),
    'utf-8',
  )
}

async function updateMeta(
  id: string,
  updater: (current: ConversationMeta) => ConversationMeta,
): Promise<ConversationMeta> {
  const previous = metaWriteChains.get(id) ?? Promise.resolve()
  const run = previous
    .catch(() => {})
    .then(async () => {
      const current = await readMeta(id)
      const next = normalizeConversationMeta(updater(current), id)
      await writeMeta(next)
      return next
    })
  const guard = run.then(
    () => undefined,
    () => undefined,
  )
  metaWriteChains.set(id, guard)
  guard.finally(() => {
    if (metaWriteChains.get(id) === guard) metaWriteChains.delete(id)
  })
  return run
}

async function queueMessageWrite(id: string, writer: () => Promise<void>): Promise<void> {
  const previous = messageWriteChains.get(id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(writer)
  const guard = run.then(
    () => undefined,
    () => undefined,
  )
  messageWriteChains.set(id, guard)
  guard.finally(() => {
    if (messageWriteChains.get(id) === guard) messageWriteChains.delete(id)
  })
  return run
}

async function queueEventWrite(id: string, writer: () => Promise<void>): Promise<void> {
  const previous = eventWriteChains.get(id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(writer)
  const guard = run.then(
    () => undefined,
    () => undefined,
  )
  eventWriteChains.set(id, guard)
  guard.finally(() => {
    if (eventWriteChains.get(id) === guard) eventWriteChains.delete(id)
  })
  return run
}

function nextUpdatedAt(current: ConversationMeta, timestamp = Date.now()): number {
  return Math.max(Date.now(), timestamp, current.updatedAt + 1)
}

export async function listConversations(): Promise<ConversationSummary[]> {
  await ensureDir()
  const entries = await readdir(getConversationsDir())
  const records = await Promise.all(
    entries
      .filter((name) => name.endsWith('.meta.json'))
      .map(async (name) => {
        try {
          const raw = await readFile(join(getConversationsDir(), name), 'utf-8')
          return normalizeConversationMeta(JSON.parse(raw) as Partial<ConversationMeta>)
        } catch {
          return null
        }
      }),
  )
  return records
    .filter((record): record is ConversationMeta => record !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function listChatConversations(): Promise<ConversationSummary[]> {
  const list = await listConversations()
  return list.filter((meta) => !meta.docId)
}

export async function recoverInterruptedConversationActivities(
  reason = 'runtime restarted before this turn finished',
): Promise<ConversationSummary[]> {
  const list = await listConversations()
  const recovered: ConversationSummary[] = []
  await Promise.all(
    list.map(async (meta) => {
      const events = await listAgentEvents(meta.id)
      const replayedActivity = replayConversationActivity(events)
      const activity = replayedActivity ?? meta.activity
      if (!activity) return
      if (replayedActivity && !conversationActivityEquals(meta.activity, replayedActivity)) {
        await updateMeta(meta.id, (current) =>
          current.activity && current.activity.updatedAt > replayedActivity.updatedAt
            ? current
            : {
                ...current,
                updatedAt: nextUpdatedAt(current, replayedActivity.updatedAt),
                activity: replayedActivity,
              },
        )
      }
      const recoveryEvent =
        createInterruptedConversationRecoveryEvent(events, { reason, activity }) ??
        interruptedRecoveryEventFromLegacyActivity(
          meta.id,
          replayedActivity ? undefined : activity,
          reason,
        )
      if (!recoveryEvent) return
      const { summary } = await appendAgentEventAndTouchConversation(meta.id, recoveryEvent)
      if (summary) recovered.push(summary)
    }),
  )
  return recovered.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getConversation(id: string): Promise<ConversationRecord> {
  const meta = await readMeta(id)
  let raw = ''
  try {
    raw = await readFile(logPath(id), 'utf-8')
  } catch {
    // log file may not exist yet for a freshly created conversation
  }
  const messages: PersistedMessage[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const message = normalizePersistedMessage(JSON.parse(trimmed) as Partial<PersistedMessage>)
      if (message) upsertPersistedMessage(messages, message)
    } catch {
      // skip malformed line -- keeps the rest of the conversation readable
    }
  }
  return { meta, messages }
}

export async function createConversation(docId?: string): Promise<ConversationSummary> {
  await ensureDir()
  const now = Date.now()
  const meta: ConversationMeta = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: randomUUID(),
    title: DEFAULT_CONVERSATION_TITLE,
    createdAt: now,
    updatedAt: now,
    ...(docId ? { docId } : {}),
  }
  await writeMeta(meta)
  await writeFile(logPath(meta.id), '', 'utf-8')
  return meta
}

// Doc-bound conversations: a doc may have N of them. Title is derived from
// the first user message (same path as chat-tab conversations); listConversations
// already sorts by updatedAt desc, so we just filter.
export async function listDocConversations(docId: string): Promise<ConversationSummary[]> {
  const list = await listConversations()
  return list.filter((meta) => meta.docId === docId)
}

export async function appendMessage(
  id: string,
  message: PersistedMessage,
): Promise<ConversationSummary> {
  await ensureDir()
  await queueMessageWrite(id, () =>
    appendFile(logPath(id), `${JSON.stringify(preparePersistedMessage(message))}\n`, 'utf-8'),
  )
  return touchMetaAfterMessage(id, message)
}

export async function upsertMessage(
  id: string,
  message: PersistedMessage,
): Promise<ConversationSummary> {
  await ensureDir()
  await queueMessageWrite(id, async () => {
    let raw = ''
    try {
      raw = await readFile(logPath(id), 'utf-8')
    } catch {
      raw = ''
    }

    const prepared = preparePersistedMessage(message)
    const preparedLine = JSON.stringify(prepared)
    const nextLines: string[] = []
    let replaced = false

    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const existing = JSON.parse(trimmed) as Partial<PersistedMessage>
        if (existing.id === prepared.id) {
          if (!replaced) {
            nextLines.push(preparedLine)
            replaced = true
          }
          continue
        }
      } catch {
        nextLines.push(line)
        continue
      }
      nextLines.push(line)
    }

    if (!replaced) nextLines.push(preparedLine)
    await writeFile(logPath(id), `${nextLines.join('\n')}\n`, 'utf-8')
  })
  return touchMetaAfterMessage(id, message)
}

function touchMetaAfterMessage(
  id: string,
  message: PersistedMessage,
): Promise<ConversationSummary> {
  return updateMeta(id, (current) => {
    const next: ConversationMeta = {
      ...current,
      updatedAt: nextUpdatedAt(current),
    }
    if (current.title === DEFAULT_CONVERSATION_TITLE) {
      const derived = deriveConversationTitle(message)
      if (derived) next.title = derived
    }
    return next
  })
}

export async function appendAgentEvent(
  id: string,
  event: AgentEvent,
): Promise<PersistedAgentEvent> {
  await ensureDir()
  const prepared = prepareAgentEvent(event)
  await queueEventWrite(id, () =>
    appendFile(eventLogPath(id), `${JSON.stringify(prepared)}\n`, 'utf-8'),
  )
  return prepared
}

export async function appendAgentEventAndTouchConversation(
  id: string,
  event: AgentEvent,
): Promise<AgentEventAppendResult> {
  const persisted = await appendAgentEvent(id, event)
  const activity = activityFromAgentEvent(persisted)
  const summary = activity
    ? await updateMeta(id, (current) =>
        current.activity && current.activity.updatedAt > activity.updatedAt
          ? current
          : {
              ...current,
              updatedAt: nextUpdatedAt(current, persisted.timestamp),
              activity,
            },
      )
    : undefined
  return { event: persisted, ...(summary ? { summary } : {}) }
}

export async function listAgentEvents(id: string): Promise<PersistedAgentEvent[]> {
  await ensureDir()
  let raw = ''
  try {
    raw = await readFile(eventLogPath(id), 'utf-8')
  } catch {
    return []
  }

  const events: PersistedAgentEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = normalizeAgentEvent(JSON.parse(trimmed) as Partial<PersistedAgentEvent>, id)
      if (!event) continue
      events.push(event)
    } catch {
      // skip malformed line
    }
  }
  return orderedUniqueAgentEvents(events)
}

export async function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  return updateMeta(id, (current) => ({
    ...current,
    title: title.trim() || DEFAULT_CONVERSATION_TITLE,
    updatedAt: nextUpdatedAt(current),
  }))
}

export async function setConversationUsage(
  id: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
): Promise<ConversationSummary> {
  return updateMeta(id, (current) => ({
    ...current,
    updatedAt: nextUpdatedAt(current),
    usage: { ...usage, updatedAt: Date.now() },
  }))
}

export async function deleteConversation(id: string): Promise<void> {
  await metaWriteChains.get(id)?.catch(() => {})
  await messageWriteChains.get(id)?.catch(() => {})
  await eventWriteChains.get(id)?.catch(() => {})
  await Promise.all([
    rm(metaPath(id), { force: true }),
    rm(logPath(id), { force: true }),
    rm(eventLogPath(id), { force: true }),
  ])
  metaWriteChains.delete(id)
  messageWriteChains.delete(id)
  eventWriteChains.delete(id)
}

export interface DocRefRewrite {
  oldPath: string
  newPath: string
  // True for folder renames/moves: matches docIds equal to oldPath or starting
  // with `${oldPath}/`. False (or omitted) for doc renames: only exact match.
  isFolder?: boolean
}

// Cascade-rewrite meta.docId across every doc-bound conversation after a doc
// or folder is renamed/moved. Mirrors Obsidian's "rename + scan vault and
// rewrite wikilinks" behaviour. Caller (docs.ts) invokes after fs.rename has
// already committed; failure here leaves the file rename in place and the
// affected conversations show broken doc-bindings.
export async function rewriteDocRefs(rewrites: DocRefRewrite[]): Promise<ConversationSummary[]> {
  if (rewrites.length === 0) return []
  await ensureDir()
  const dir = getConversationsDir()
  const entries = await readdir(dir)
  const updated: ConversationSummary[] = []
  const rewriteDocId = (docId: string): string | null => {
    for (const r of rewrites) {
      if (r.isFolder) {
        if (docId === r.oldPath || docId.startsWith(`${r.oldPath}/`)) {
          return `${r.newPath}${docId.slice(r.oldPath.length)}`
        }
      } else if (docId === r.oldPath) {
        return r.newPath
      }
    }
    return null
  }
  await Promise.all(
    entries
      .filter((name) => name.endsWith('.meta.json'))
      .map(async (name) => {
        const path = join(dir, name)
        let raw: string
        try {
          raw = await readFile(path, 'utf-8')
        } catch {
          return
        }
        let meta: ConversationMeta
        try {
          meta = normalizeConversationMeta(JSON.parse(raw) as Partial<ConversationMeta>)
        } catch {
          return
        }
        const docId = meta.docId
        if (!docId) return
        if (rewriteDocId(docId) === null) return
        const next = await updateMeta(meta.id, (current) => {
          const currentDocId = current.docId
          if (!currentDocId) return current
          const nextDocId = rewriteDocId(currentDocId)
          return nextDocId === null ? current : { ...current, docId: nextDocId }
        })
        if (next.docId !== docId) updated.push(next)
      }),
  )
  return updated
}
