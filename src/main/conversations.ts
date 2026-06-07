import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../shared/models'
import type { AgentEvent } from './agent'
import { getConversationsDir } from './paths'

export const AILA_CONVERSATION_META_SCHEMA_VERSION = 1
export const AILA_PERSISTED_MESSAGE_SCHEMA_VERSION = 1
export const AILA_AGENT_EVENT_SCHEMA_VERSION = 1

export interface PersistedTextBlock {
  type: 'text' | 'reasoning'
  content: string
}

export interface PersistedToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error'
  result?: string
}

export interface PersistedImageBlock {
  type: 'image'
  url: string // aila-image://i/<filename>
  mime: string
  prompt?: string
}

export type PersistedBlock = PersistedTextBlock | PersistedToolCallBlock | PersistedImageBlock

export interface PersistedMessage {
  schemaVersion: typeof AILA_PERSISTED_MESSAGE_SCHEMA_VERSION
  id: string
  role: 'user' | 'assistant'
  blocks: PersistedBlock[]
  status: 'streaming' | 'done' | 'error'
  error?: string
  model?: { providerId: ProviderId; modelId: string }
}

export interface ConversationUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  updatedAt: number
}

export interface ConversationMeta {
  schemaVersion: typeof AILA_CONVERSATION_META_SCHEMA_VERSION
  id: string
  title: string
  createdAt: number
  updatedAt: number
  usage?: ConversationUsage
  // When set, this conversation is the AI sidebar attached to a specific doc.
  // The chat tab filters these out; Desktop owns docs workspace behavior.
  docId?: string | null
}

export type ConversationSummary = ConversationMeta

export interface ConversationRecord {
  meta: ConversationMeta
  messages: PersistedMessage[]
}

export interface PersistedAgentEvent extends AgentEvent {
  schemaVersion: typeof AILA_AGENT_EVENT_SCHEMA_VERSION
}

const DEFAULT_TITLE = '新对话'
const TITLE_MAX = 40

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

function normalizeConversationMeta(
  value: Partial<ConversationMeta>,
  fallbackId?: string,
): ConversationMeta {
  const now = Date.now()
  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : fallbackId
  if (!id) throw new Error('conversation meta is missing id')

  return {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id,
    title: typeof value.title === 'string' && value.title.length > 0 ? value.title : DEFAULT_TITLE,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
    ...(value.usage ? { usage: value.usage } : {}),
    ...(value.docId !== undefined ? { docId: value.docId } : {}),
  }
}

function normalizePersistedMessage(value: Partial<PersistedMessage>): PersistedMessage | null {
  if (typeof value.id !== 'string' || value.id.length === 0) return null
  if (value.role !== 'user' && value.role !== 'assistant') return null
  if (!Array.isArray(value.blocks)) return null
  if (value.status !== 'streaming' && value.status !== 'done' && value.status !== 'error') {
    return null
  }

  return {
    schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
    id: value.id,
    role: value.role,
    blocks: value.blocks,
    status: value.status,
    ...(value.error !== undefined && { error: value.error }),
    ...(value.model !== undefined && { model: value.model }),
  }
}

function preparePersistedMessage(message: PersistedMessage): PersistedMessage {
  return {
    ...message,
    schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  }
}

function prepareAgentEvent(event: AgentEvent): PersistedAgentEvent {
  return {
    ...event,
    schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
  }
}

function normalizeAgentEvent(
  value: Partial<PersistedAgentEvent>,
  fallbackConversationId?: string,
): PersistedAgentEvent | null {
  const conversationId =
    typeof value.conversationId === 'string' && value.conversationId.length > 0
      ? value.conversationId
      : fallbackConversationId
  if (!conversationId) return null
  if (typeof value.messageId !== 'string' || value.messageId.length === 0) return null
  if (typeof value.type !== 'string' || value.type.length === 0) return null

  return {
    schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
    timestamp: typeof value.timestamp === 'number' ? value.timestamp : Date.now(),
    conversationId,
    messageId: value.messageId,
    type: value.type as AgentEvent['type'],
    ...(value.data &&
      typeof value.data === 'object' && {
        data: value.data as Record<string, unknown>,
      }),
  }
}

function deriveTitle(message: PersistedMessage): string | null {
  if (message.role !== 'user') return null
  const text = message.blocks
    .filter((block): block is PersistedTextBlock => block.type === 'text')
    .map((block) => block.content)
    .join('')
    .trim()
  if (!text) return null
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text
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
      if (message) messages.push(message)
    } catch {
      // skip malformed line — keeps the rest of the conversation readable
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
    title: DEFAULT_TITLE,
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
  await appendFile(logPath(id), `${JSON.stringify(preparePersistedMessage(message))}\n`, 'utf-8')
  const current = await readMeta(id)
  const next: ConversationMeta = {
    ...current,
    updatedAt: Date.now(),
  }
  if (current.title === DEFAULT_TITLE) {
    const derived = deriveTitle(message)
    if (derived) next.title = derived
  }
  await writeMeta(next)
  return next
}

export async function appendAgentEvent(
  id: string,
  event: AgentEvent,
): Promise<PersistedAgentEvent> {
  await ensureDir()
  const prepared = prepareAgentEvent(event)
  await appendFile(eventLogPath(id), `${JSON.stringify(prepared)}\n`, 'utf-8')
  return prepared
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
      if (event) events.push(event)
    } catch {
      // skip malformed line
    }
  }
  return events.sort((a, b) => a.timestamp - b.timestamp)
}

export async function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  const current = await readMeta(id)
  const next: ConversationMeta = {
    ...current,
    title: title.trim() || DEFAULT_TITLE,
    updatedAt: Date.now(),
  }
  await writeMeta(next)
  return next
}

export async function setConversationUsage(
  id: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
): Promise<ConversationSummary> {
  const current = await readMeta(id)
  const next: ConversationMeta = {
    ...current,
    usage: { ...usage, updatedAt: Date.now() },
  }
  await writeMeta(next)
  return next
}

export async function deleteConversation(id: string): Promise<void> {
  await Promise.all([
    rm(metaPath(id), { force: true }),
    rm(logPath(id), { force: true }),
    rm(eventLogPath(id), { force: true }),
  ])
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
        let nextDocId: string | null = null
        for (const r of rewrites) {
          if (r.isFolder) {
            if (docId === r.oldPath || docId.startsWith(`${r.oldPath}/`)) {
              nextDocId = `${r.newPath}${docId.slice(r.oldPath.length)}`
              break
            }
          } else if (docId === r.oldPath) {
            nextDocId = r.newPath
            break
          }
        }
        if (nextDocId === null) return
        const next: ConversationMeta = { ...meta, docId: nextDocId }
        await writeFile(path, JSON.stringify(next, null, 2), 'utf-8')
        updated.push(next)
      }),
  )
  return updated
}
