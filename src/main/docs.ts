import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { imageNameFromUrl } from './images'
import { getDocumentsDir, getImagesDir } from './paths'

export interface DocRecord {
  id: string
  parentId: string | null
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

export type DocSummary = Pick<DocRecord, 'id' | 'parentId' | 'title' | 'createdAt' | 'updatedAt'>

const DEFAULT_TITLE = '无标题文档'
const EMPTY_CONTENT = ''

const IMAGE_URL_RE = /aila-image:\/\/i\/[A-Za-z0-9._-]+/g

async function ensureDir(): Promise<string> {
  const dir = getDocumentsDir()
  await mkdir(dir, { recursive: true })
  return dir
}

function pathFor(id: string): string {
  return join(getDocumentsDir(), `${id}.md`)
}

interface ParsedDoc {
  data: Record<string, unknown>
  body: string
}

function parseDoc(raw: string): ParsedDoc {
  const parsed = matter(raw)
  return { data: parsed.data ?? {}, body: parsed.content ?? '' }
}

function serializeDoc(record: DocRecord): string {
  const frontmatter = {
    id: record.id,
    parentId: record.parentId,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  return matter.stringify(record.content, frontmatter)
}

function normalizeFromParsed(parsed: ParsedDoc): DocRecord {
  const data = parsed.data
  const id = typeof data.id === 'string' ? data.id : null
  const createdAt = typeof data.createdAt === 'number' ? data.createdAt : null
  const updatedAt = typeof data.updatedAt === 'number' ? data.updatedAt : null
  if (!id || createdAt === null || updatedAt === null) {
    throw new Error('Invalid document record: missing id/createdAt/updatedAt in frontmatter')
  }

  const parentRaw = data.parentId
  const parentId =
    typeof parentRaw === 'string' && parentRaw.length > 0 ? parentRaw : null
  const title = typeof data.title === 'string' && data.title.length > 0 ? data.title : DEFAULT_TITLE

  return {
    id,
    parentId,
    title,
    content: parsed.body,
    createdAt,
    updatedAt,
  }
}

async function readDoc(id: string): Promise<DocRecord> {
  const raw = await readFile(pathFor(id), 'utf-8')
  return normalizeFromParsed(parseDoc(raw))
}

async function writeDoc(record: DocRecord): Promise<void> {
  await ensureDir()
  await writeFile(pathFor(record.id), serializeDoc(record), 'utf-8')
}

export async function listDocs(): Promise<DocSummary[]> {
  // PERF: full file read per doc. gray-matter parses the body too, but the
  // dominant cost is readdir+readFile syscalls. Revisit (frontmatter-only
  // fast path) if doc count grows past a few hundred and the sidebar feels
  // sluggish.
  await ensureDir()
  const entries = await readdir(getDocumentsDir())
  const records = await Promise.all(
    entries
      .filter((name) => name.endsWith('.md'))
      .map(async (name) => {
        try {
          const raw = await readFile(join(getDocumentsDir(), name), 'utf-8')
          const record = normalizeFromParsed(parseDoc(raw))
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

function collectImageUrls(body: string, out: Set<string>): void {
  for (const match of body.matchAll(IMAGE_URL_RE)) out.add(match[0])
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

  const imageUrls = new Set<string>()
  await Promise.all(
    [...idsToDelete].map(async (docId) => {
      try {
        const doc = await readDoc(docId)
        collectImageUrls(doc.content, imageUrls)
      } catch {
        // Doc unreadable — skip image collection for it.
      }
    }),
  )

  await Promise.all([...idsToDelete].map((docId) => rm(pathFor(docId), { force: true })))

  if (imageUrls.size === 0) return
  const imagesDir = getImagesDir()
  await Promise.all(
    [...imageUrls].map(async (url) => {
      const name = imageNameFromUrl(url)
      if (!name) return
      await rm(join(imagesDir, name), { force: true }).catch(() => {})
    }),
  )
}

