import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDocumentsDir } from './paths'

export interface DocRecord {
  id: string
  title: string
  content: unknown
  createdAt: number
  updatedAt: number
}

export type DocSummary = Pick<DocRecord, 'id' | 'title' | 'createdAt' | 'updatedAt'>

const DEFAULT_TITLE = '无标题文档'

const EMPTY_CONTENT: unknown = [{ type: 'p', children: [{ text: '' }] }]

async function ensureDir(): Promise<string> {
  const dir = getDocumentsDir()
  await mkdir(dir, { recursive: true })
  return dir
}

function pathFor(id: string): string {
  return join(getDocumentsDir(), `${id}.json`)
}

async function readDoc(id: string): Promise<DocRecord> {
  const raw = await readFile(pathFor(id), 'utf-8')
  return JSON.parse(raw) as DocRecord
}

async function writeDoc(record: DocRecord): Promise<void> {
  await ensureDir()
  await writeFile(pathFor(record.id), JSON.stringify(record, null, 2), 'utf-8')
}

export async function listDocs(): Promise<DocSummary[]> {
  await ensureDir()
  const entries = await readdir(getDocumentsDir())
  const records = await Promise.all(
    entries
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const raw = await readFile(join(getDocumentsDir(), name), 'utf-8')
          const record = JSON.parse(raw) as DocRecord
          return {
            id: record.id,
            title: record.title,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          }
        } catch {
          return null
        }
      }),
  )
  return records
    .filter((record): record is DocSummary => record !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getDoc(id: string): Promise<DocRecord> {
  return readDoc(id)
}

export async function createDoc(): Promise<DocRecord> {
  const now = Date.now()
  const record: DocRecord = {
    id: randomUUID(),
    title: DEFAULT_TITLE,
    content: EMPTY_CONTENT,
    createdAt: now,
    updatedAt: now,
  }
  await writeDoc(record)
  return record
}

export async function updateDoc(
  id: string,
  patch: Partial<Pick<DocRecord, 'title' | 'content'>>,
): Promise<DocRecord> {
  const current = await readDoc(id)
  const next: DocRecord = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  }
  await writeDoc(next)
  return next
}

export async function deleteDoc(id: string): Promise<void> {
  await rm(pathFor(id), { force: true })
}
