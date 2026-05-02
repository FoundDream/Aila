import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDocumentsDir } from './paths'

export interface DocRecord {
  id: string
  parentId: string | null
  title: string
  content: unknown
  createdAt: number
  updatedAt: number
}

export type DocSummary = Pick<DocRecord, 'id' | 'parentId' | 'title' | 'createdAt' | 'updatedAt'>

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
  return normalizeDoc(JSON.parse(raw) as Partial<DocRecord>)
}

async function writeDoc(record: DocRecord): Promise<void> {
  await ensureDir()
  await writeFile(pathFor(record.id), JSON.stringify(record, null, 2), 'utf-8')
}

function normalizeDoc(record: Partial<DocRecord>): DocRecord {
  if (!record.id || !record.createdAt || !record.updatedAt) {
    throw new Error('Invalid document record')
  }

  return {
    id: record.id,
    parentId: record.parentId ?? null,
    title: record.title ?? DEFAULT_TITLE,
    content: record.content ?? EMPTY_CONTENT,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
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
          const record = normalizeDoc(JSON.parse(raw) as Partial<DocRecord>)
          return {
            id: record.id,
            parentId: record.parentId,
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

export async function createDoc(parentId: string | null = null): Promise<DocRecord> {
  if (parentId) {
    await readDoc(parentId)
  }

  const now = Date.now()
  const record: DocRecord = {
    id: randomUUID(),
    parentId,
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
  patch: Partial<Pick<DocRecord, 'parentId' | 'title' | 'content'>>,
): Promise<DocRecord> {
  const current = await readDoc(id)
  if (patch.parentId === id) {
    throw new Error('A document cannot be nested under itself')
  }

  if (patch.parentId) {
    await readDoc(patch.parentId)
    const docs = await listDocs()
    const idsUnderCurrent = new Set<string>([id])
    let changed = true

    while (changed) {
      changed = false
      for (const doc of docs) {
        if (doc.parentId && idsUnderCurrent.has(doc.parentId) && !idsUnderCurrent.has(doc.id)) {
          idsUnderCurrent.add(doc.id)
          changed = true
        }
      }
    }

    if (idsUnderCurrent.has(patch.parentId)) {
      throw new Error('A document cannot be nested under one of its descendants')
    }
  }

  const next: DocRecord = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  }
  await writeDoc(next)
  return next
}

export async function deleteDoc(id: string): Promise<void> {
  const docs = await listDocs()
  const idsToDelete = new Set<string>([id])
  let changed = true

  while (changed) {
    changed = false
    for (const doc of docs) {
      if (doc.parentId && idsToDelete.has(doc.parentId) && !idsToDelete.has(doc.id)) {
        idsToDelete.add(doc.id)
        changed = true
      }
    }
  }

  await Promise.all([...idsToDelete].map((docId) => rm(pathFor(docId), { force: true })))
}
