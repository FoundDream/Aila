/**
 * JSONL session store — append-only, one entry per line.
 *
 * File layout:
 *   Line 1: SessionHeader
 *   Line 2..N: SessionEntry records (message, model_change, ...)
 *
 * Writes use appendFileSync so each append is atomic at the OS level and a
 * crash between two lines leaves a recoverable file. Reads parse line-by-line
 * and silently skip malformed lines (but throw if the header is unreadable).
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import type {
  Message,
  ModelChangeEntry,
  SessionEntry,
  SessionFileLine,
  SessionHeader,
  SessionInfo,
  SessionMessageEntry,
} from '../agent-core/types'
import { SESSION_FILE_VERSION } from '../agent-core/types'

function serializeLine(record: SessionFileLine): string {
  return `${JSON.stringify(record)}\n`
}

function parseLines(raw: string): SessionFileLine[] {
  const out: SessionFileLine[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as SessionFileLine)
    } catch {
      // skip malformed line
    }
  }
  return out
}

function extractFirstUserMessageText(entries: SessionEntry[]): string {
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const msg = entry.message
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content.trim()
    const text = msg.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
      .trim()
    const imageCount = msg.content.filter((part) => part.type === 'image').length
    if (text) return text
    if (imageCount > 0) return `${imageCount} image${imageCount === 1 ? '' : 's'}`
  }
  return ''
}

function countMessages(entries: SessionEntry[]): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message.role !== 'toolResult') {
      count += 1
    }
  }
  return count
}

export class SessionStore {
  private entries: SessionEntry[]

  private constructor(
    readonly path: string,
    readonly header: SessionHeader,
    entries: SessionEntry[],
  ) {
    this.entries = entries
  }

  /** Create a brand-new session file under `sessionDir`. */
  static create(sessionDir: string, cwd: string, id?: string): SessionStore {
    mkdirSync(sessionDir, { recursive: true })

    const sessionId = id ?? randomUUID()
    const path = join(sessionDir, `${sessionId}.jsonl`)
    const header: SessionHeader = {
      type: 'session',
      version: SESSION_FILE_VERSION,
      id: sessionId,
      cwd,
      createdAt: new Date().toISOString(),
    }

    writeFileSync(path, serializeLine(header), 'utf8')
    return new SessionStore(path, header, [])
  }

  /** Load an existing session file. Throws if the header is missing or invalid. */
  static open(path: string): SessionStore {
    const raw = readFileSync(path, 'utf8')
    const lines = parseLines(raw)

    const first = lines[0]
    if (!first || (first as { type: string }).type !== 'session') {
      throw new Error(`Session file "${path}" is missing a header`)
    }

    const header = first as SessionHeader
    if (header.version !== SESSION_FILE_VERSION) {
      throw new Error(
        `Session file "${path}" uses version ${header.version}, expected ${SESSION_FILE_VERSION}`,
      )
    }

    const entries: SessionEntry[] = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] as SessionEntry
      if (line?.type === 'message' || line?.type === 'model_change') {
        entries.push(line)
      }
    }

    return new SessionStore(path, header, entries)
  }

  /** List every session file in `sessionDir`, optionally filtered by cwd. */
  static list(sessionDir: string, cwd?: string): SessionInfo[] {
    if (!existsSync(sessionDir)) return []

    const results: SessionInfo[] = []
    const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))

    for (const file of files) {
      const path = join(sessionDir, file)
      let header: SessionHeader
      let entries: SessionEntry[]
      let modified: Date
      try {
        const raw = readFileSync(path, 'utf8')
        const lines = parseLines(raw)
        const first = lines[0]
        if (!first || (first as { type: string }).type !== 'session') continue
        header = first as SessionHeader
        if (header.version !== SESSION_FILE_VERSION) continue
        if (cwd && header.cwd !== cwd) continue
        entries = lines
          .slice(1)
          .filter((l): l is SessionEntry => l?.type === 'message' || l?.type === 'model_change')
        modified = statSync(path).mtime
      } catch {
        continue
      }

      results.push({
        path,
        id: header.id,
        cwd: header.cwd,
        createdAt: header.createdAt,
        modified,
        messageCount: countMessages(entries),
        firstMessage: extractFirstUserMessageText(entries),
        name: header.name,
      })
    }

    results.sort((a, b) => b.modified.getTime() - a.modified.getTime())
    return results
  }

  static delete(path: string): void {
    if (existsSync(path)) {
      unlinkSync(path)
    }
  }

  get sessionId(): string {
    return this.header.id
  }

  get cwd(): string {
    return this.header.cwd
  }

  get name(): string | undefined {
    return this.header.name
  }

  get filename(): string {
    return basename(this.path)
  }

  appendMessage(message: Message): SessionMessageEntry {
    const entry: SessionMessageEntry = {
      type: 'message',
      id: `entry-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      message,
    }
    this.entries.push(entry)
    appendFileSync(this.path, serializeLine(entry), 'utf8')
    return entry
  }

  appendModelChange(providerId: string, modelId: string): ModelChangeEntry {
    const entry: ModelChangeEntry = {
      type: 'model_change',
      id: `entry-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      providerId,
      modelId,
    }
    this.entries.push(entry)
    appendFileSync(this.path, serializeLine(entry), 'utf8')
    return entry
  }

  getEntries(): readonly SessionEntry[] {
    return this.entries
  }

  /** Extract just the Message[] from entries, in canonical order. */
  getMessages(): Message[] {
    const out: Message[] = []
    for (const entry of this.entries) {
      if (entry.type === 'message') {
        out.push(entry.message)
      }
    }
    return out
  }

  summary(): SessionInfo {
    let modified: Date
    try {
      modified = statSync(this.path).mtime
    } catch {
      modified = new Date(this.header.createdAt)
    }
    return {
      path: this.path,
      id: this.header.id,
      cwd: this.header.cwd,
      createdAt: this.header.createdAt,
      modified,
      messageCount: countMessages(this.entries),
      firstMessage: extractFirstUserMessageText(this.entries),
      name: this.header.name,
    }
  }
}
