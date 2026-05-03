import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '@shared/models'
import { getConversationsDir } from './paths'

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
  id: string
  title: string
  createdAt: number
  updatedAt: number
  usage?: ConversationUsage
  // When set, this conversation is the AI sidebar attached to a specific doc.
  // The chat tab filters these out; doc context is prepended to each request
  // by the chat:send handler at send time (read fresh from disk, not cached).
  docId?: string | null
}

export type ConversationSummary = ConversationMeta

export interface ConversationRecord {
  meta: ConversationMeta
  messages: PersistedMessage[]
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

function metaPath(id: string): string {
  return join(getConversationsDir(), `${id}.meta.json`)
}

async function readMeta(id: string): Promise<ConversationMeta> {
  const raw = await readFile(metaPath(id), 'utf-8')
  return JSON.parse(raw) as ConversationMeta
}

async function writeMeta(meta: ConversationMeta): Promise<void> {
  await ensureDir()
  await writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf-8')
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
          return JSON.parse(raw) as ConversationMeta
        } catch {
          return null
        }
      }),
  )
  return records
    .filter((record): record is ConversationMeta => record !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
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
      messages.push(JSON.parse(trimmed) as PersistedMessage)
    } catch {
      // skip malformed line — keeps the rest of the conversation readable
    }
  }
  return { meta, messages }
}

export async function createConversation(): Promise<ConversationSummary> {
  await ensureDir()
  const now = Date.now()
  const meta: ConversationMeta = {
    id: randomUUID(),
    title: DEFAULT_TITLE,
    createdAt: now,
    updatedAt: now,
  }
  await writeMeta(meta)
  await writeFile(logPath(meta.id), '', 'utf-8')
  return meta
}

// Doc-bound conversation: one per doc, lazily created on first sidebar use.
// Title is fixed (the doc owns its own title); listConversations returns it
// alongside chat-tab conversations and the renderer filters by docId.
export async function getOrCreateDocConversation(docId: string): Promise<ConversationSummary> {
  const list = await listConversations()
  const existing = list.find((meta) => meta.docId === docId)
  if (existing) return existing

  await ensureDir()
  const now = Date.now()
  const meta: ConversationMeta = {
    id: randomUUID(),
    title: 'Doc chat',
    createdAt: now,
    updatedAt: now,
    docId,
  }
  await writeMeta(meta)
  await writeFile(logPath(meta.id), '', 'utf-8')
  return meta
}

export async function appendMessage(
  id: string,
  message: PersistedMessage,
): Promise<ConversationSummary> {
  await ensureDir()
  await appendFile(logPath(id), `${JSON.stringify(message)}\n`, 'utf-8')
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
  await Promise.all([rm(metaPath(id), { force: true }), rm(logPath(id), { force: true })])
}
