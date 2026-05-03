import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, posix as pathPosix, relative, sep } from 'node:path'
import matter from 'gray-matter'
import { imageNameFromUrl } from './images'
import { getDocumentsDir, getImagesDir } from './paths'

export interface DocRecord {
  id: string
  folderPath: string | null
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

export type DocSummary = Pick<DocRecord, 'id' | 'folderPath' | 'title' | 'createdAt' | 'updatedAt'>

export interface FolderSummary {
  path: string
  name: string
  parentPath: string | null
}

const DEFAULT_TITLE = '无标题文档'
const EMPTY_CONTENT = ''

const IMAGE_URL_RE = /aila-image:\/\/i\/[A-Za-z0-9._-]+/g

// Folder names get raw user input. Reject path traversal, empty strings, and
// platform-illegal characters before they can hit fs.
const FOLDER_NAME_BAD = /[\\/<>:"|?*]/

// Source-of-truth FS paths use posix-style separators internally so the values
// are stable across renderer ↔ main and easy to compare/prefix-check.
function toPosix(p: string): string {
  return p.split(sep).join('/')
}

function fromPosix(p: string): string {
  return p.split('/').join(sep)
}

async function ensureRoot(): Promise<string> {
  const dir = getDocumentsDir()
  await mkdir(dir, { recursive: true })
  return dir
}

function validateFolderPath(rel: string | null): string | null {
  if (rel === null) return null
  const trimmed = rel.replace(/^\/+|\/+$/g, '')
  if (trimmed.length === 0) return null
  // path.posix.normalize collapses '.' and '..'; reject anything that starts
  // with '..' afterwards (would escape the root).
  const normalized = pathPosix.normalize(trimmed)
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`invalid folder path: ${rel}`)
  }
  for (const part of normalized.split('/')) {
    if (part.length === 0 || part === '.' || part === '..') {
      throw new Error(`invalid folder path: ${rel}`)
    }
    if (FOLDER_NAME_BAD.test(part)) {
      throw new Error(`folder name contains illegal characters: ${part}`)
    }
  }
  return normalized
}

function validateFolderName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new Error('folder name cannot be empty')
  if (trimmed === '.' || trimmed === '..') throw new Error(`invalid folder name: ${trimmed}`)
  if (FOLDER_NAME_BAD.test(trimmed)) {
    throw new Error(`folder name contains illegal characters: ${trimmed}`)
  }
  return trimmed
}

function absFolderPath(folderPath: string | null): string {
  return folderPath ? join(getDocumentsDir(), fromPosix(folderPath)) : getDocumentsDir()
}

function docPath(id: string, folderPath: string | null): string {
  return join(absFolderPath(folderPath), `${id}.md`)
}

interface ParsedDoc {
  data: Record<string, unknown>
  body: string
}

function parseDoc(raw: string): ParsedDoc {
  const parsed = matter(raw)
  return { data: parsed.data ?? {}, body: parsed.content ?? '' }
}

function serializeDoc(record: Omit<DocRecord, 'folderPath'>): string {
  const frontmatter = {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  return matter.stringify(record.content, frontmatter)
}

interface ParsedFrontmatter {
  id: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

function normalizeFromParsed(parsed: ParsedDoc): ParsedFrontmatter {
  const data = parsed.data
  const id = typeof data.id === 'string' ? data.id : null
  const createdAt = typeof data.createdAt === 'number' ? data.createdAt : null
  const updatedAt = typeof data.updatedAt === 'number' ? data.updatedAt : null
  if (!id || createdAt === null || updatedAt === null) {
    throw new Error('Invalid document record: missing id/createdAt/updatedAt in frontmatter')
  }
  const title = typeof data.title === 'string' && data.title.length > 0 ? data.title : DEFAULT_TITLE
  return { id, title, content: parsed.body, createdAt, updatedAt }
}

interface WalkResult {
  folders: FolderSummary[]
  docs: Array<DocSummary & { absPath: string }>
}

async function walk(): Promise<WalkResult> {
  const root = await ensureRoot()
  const folders: FolderSummary[] = []
  const docs: Array<DocSummary & { absPath: string }> = []

  async function visit(absDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true })
    for (const entry of entries) {
      const absChild = join(absDir, entry.name)
      if (entry.isDirectory()) {
        const relPath = toPosix(relative(root, absChild))
        const parentRel = toPosix(relative(root, absDir))
        folders.push({
          path: relPath,
          name: entry.name,
          parentPath: parentRel.length === 0 ? null : parentRel,
        })
        await visit(absChild)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const raw = await readFile(absChild, 'utf-8')
          const fm = normalizeFromParsed(parseDoc(raw))
          const folderRel = toPosix(relative(root, absDir))
          docs.push({
            id: fm.id,
            folderPath: folderRel.length === 0 ? null : folderRel,
            title: fm.title,
            createdAt: fm.createdAt,
            updatedAt: fm.updatedAt,
            absPath: absChild,
          })
        } catch {
          // Skip unparseable .md files (legacy docs without v2 frontmatter,
          // hand-written notes that don't follow our schema, etc.). They stay
          // on disk untouched.
        }
      }
    }
  }

  await visit(root)
  return { folders, docs }
}

// In-memory id→absolutePath cache. Built lazily and invalidated on every
// mutating call so subsequent get/update/delete don't have to re-walk.
let idIndex: Map<string, string> | null = null

function invalidateIndex(): void {
  idIndex = null
}

async function getIndex(): Promise<Map<string, string>> {
  if (idIndex) return idIndex
  const { docs } = await walk()
  const next = new Map<string, string>()
  for (const doc of docs) next.set(doc.id, doc.absPath)
  idIndex = next
  return next
}

async function pathForId(id: string): Promise<string> {
  const index = await getIndex()
  const path = index.get(id)
  if (!path) throw new Error(`doc not found: ${id}`)
  return path
}

async function readDocAt(absPath: string): Promise<DocRecord> {
  const raw = await readFile(absPath, 'utf-8')
  const fm = normalizeFromParsed(parseDoc(raw))
  const root = getDocumentsDir()
  const folderRel = toPosix(relative(root, join(absPath, '..')))
  return {
    id: fm.id,
    folderPath: folderRel.length === 0 ? null : folderRel,
    title: fm.title,
    content: fm.content,
    createdAt: fm.createdAt,
    updatedAt: fm.updatedAt,
  }
}

async function writeDocAt(absPath: string, record: DocRecord): Promise<void> {
  await mkdir(join(absPath, '..'), { recursive: true })
  const { folderPath: _drop, ...rest } = record
  await writeFile(absPath, serializeDoc(rest), 'utf-8')
}

export async function listAll(): Promise<{ folders: FolderSummary[]; docs: DocSummary[] }> {
  const { folders, docs } = await walk()
  // Refresh the index opportunistically — we just walked everything anyway.
  const next = new Map<string, string>()
  for (const doc of docs) next.set(doc.id, doc.absPath)
  idIndex = next
  const summaries: DocSummary[] = docs
    .map((d) => ({
      id: d.id,
      folderPath: d.folderPath,
      title: d.title,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  folders.sort((a, b) => a.path.localeCompare(b.path))
  return { folders, docs: summaries }
}

export async function getDoc(id: string): Promise<DocRecord> {
  const path = await pathForId(id)
  return readDocAt(path)
}

export async function createDoc(folderPath: string | null = null): Promise<DocRecord> {
  await ensureRoot()
  const normalized = validateFolderPath(folderPath)
  if (normalized) {
    // Folder must exist before we can drop a doc into it.
    try {
      const s = await stat(absFolderPath(normalized))
      if (!s.isDirectory()) throw new Error(`folder is not a directory: ${normalized}`)
    } catch {
      throw new Error(`folder not found: ${normalized}`)
    }
  }
  const now = Date.now()
  const record: DocRecord = {
    id: randomUUID(),
    folderPath: normalized,
    title: DEFAULT_TITLE,
    content: EMPTY_CONTENT,
    createdAt: now,
    updatedAt: now,
  }
  await writeDocAt(docPath(record.id, normalized), record)
  invalidateIndex()
  return record
}

export interface DocPatch {
  title?: string
  content?: string
  folderPath?: string | null
}

export async function updateDoc(id: string, patch: DocPatch): Promise<DocRecord> {
  const currentPath = await pathForId(id)
  const current = await readDocAt(currentPath)

  const nextFolderPath =
    patch.folderPath === undefined ? current.folderPath : validateFolderPath(patch.folderPath)

  if (patch.folderPath !== undefined && nextFolderPath !== current.folderPath) {
    if (nextFolderPath !== null) {
      try {
        const s = await stat(absFolderPath(nextFolderPath))
        if (!s.isDirectory()) throw new Error(`folder is not a directory: ${nextFolderPath}`)
      } catch {
        throw new Error(`folder not found: ${nextFolderPath}`)
      }
    }
  }

  const next: DocRecord = {
    id: current.id,
    folderPath: nextFolderPath,
    title: patch.title ?? current.title,
    content: patch.content ?? current.content,
    createdAt: current.createdAt,
    updatedAt: Date.now(),
  }

  const nextPath = docPath(next.id, nextFolderPath)
  if (nextPath !== currentPath) {
    // Move first, then rewrite at the new location. fs.rename is atomic on
    // the same filesystem and avoids leaving two copies on a crash.
    await mkdir(join(nextPath, '..'), { recursive: true })
    await rename(currentPath, nextPath)
  }
  await writeDocAt(nextPath, next)
  invalidateIndex()
  return next
}

function collectImageUrlsFromBody(body: string, out: Set<string>): void {
  for (const match of body.matchAll(IMAGE_URL_RE)) out.add(match[0])
}

async function cleanupImageUrls(urls: Set<string>): Promise<void> {
  if (urls.size === 0) return
  const imagesDir = getImagesDir()
  await Promise.all(
    [...urls].map(async (url) => {
      const name = imageNameFromUrl(url)
      if (!name) return
      await rm(join(imagesDir, name), { force: true }).catch(() => {})
    }),
  )
}

export async function deleteDoc(id: string): Promise<void> {
  const path = await pathForId(id)
  const imageUrls = new Set<string>()
  try {
    const doc = await readDocAt(path)
    collectImageUrlsFromBody(doc.content, imageUrls)
  } catch {
    // Doc unreadable — skip image collection.
  }
  await rm(path, { force: true })
  await cleanupImageUrls(imageUrls)
  invalidateIndex()
}

export async function createFolder(
  parentPath: string | null,
  name: string,
): Promise<FolderSummary> {
  await ensureRoot()
  const cleanName = validateFolderName(name)
  const normalizedParent = validateFolderPath(parentPath)
  if (normalizedParent) {
    try {
      const s = await stat(absFolderPath(normalizedParent))
      if (!s.isDirectory()) throw new Error(`parent is not a directory: ${normalizedParent}`)
    } catch {
      throw new Error(`parent folder not found: ${normalizedParent}`)
    }
  }
  const relPath = normalizedParent ? `${normalizedParent}/${cleanName}` : cleanName
  const abs = absFolderPath(relPath)
  try {
    await stat(abs)
    throw new Error(`folder already exists: ${relPath}`)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('folder already exists')) throw err
    // Otherwise it's the expected ENOENT — proceed.
  }
  await mkdir(abs, { recursive: false })
  invalidateIndex()
  return { path: relPath, name: cleanName, parentPath: normalizedParent }
}

export async function renameFolder(path: string, newName: string): Promise<FolderSummary> {
  const normalized = validateFolderPath(path)
  if (!normalized) throw new Error('cannot rename the root')
  const cleanName = validateFolderName(newName)
  const lastSlash = normalized.lastIndexOf('/')
  const parentPath = lastSlash === -1 ? null : normalized.slice(0, lastSlash)
  if (cleanName === normalized.slice(lastSlash + 1)) {
    return { path: normalized, name: cleanName, parentPath }
  }
  const nextPath = parentPath ? `${parentPath}/${cleanName}` : cleanName
  const fromAbs = absFolderPath(normalized)
  const toAbs = absFolderPath(nextPath)
  try {
    await stat(toAbs)
    throw new Error(`folder already exists: ${nextPath}`)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('folder already exists')) throw err
  }
  await rename(fromAbs, toAbs)
  invalidateIndex()
  return { path: nextPath, name: cleanName, parentPath }
}

export async function moveFolder(
  path: string,
  newParentPath: string | null,
): Promise<FolderSummary> {
  const normalizedSrc = validateFolderPath(path)
  if (!normalizedSrc) throw new Error('cannot move the root')
  const normalizedParent = validateFolderPath(newParentPath)
  // Cycle check: target must not be the source itself or a descendant.
  if (normalizedParent !== null) {
    if (normalizedParent === normalizedSrc) {
      throw new Error('cannot move a folder into itself')
    }
    if (normalizedParent.startsWith(`${normalizedSrc}/`)) {
      throw new Error('cannot move a folder into one of its descendants')
    }
    try {
      const s = await stat(absFolderPath(normalizedParent))
      if (!s.isDirectory()) throw new Error(`parent is not a directory: ${normalizedParent}`)
    } catch {
      throw new Error(`parent folder not found: ${normalizedParent}`)
    }
  }
  const lastSlash = normalizedSrc.lastIndexOf('/')
  const name = lastSlash === -1 ? normalizedSrc : normalizedSrc.slice(lastSlash + 1)
  const nextPath = normalizedParent ? `${normalizedParent}/${name}` : name
  if (nextPath === normalizedSrc) {
    return { path: normalizedSrc, name, parentPath: normalizedParent }
  }
  const fromAbs = absFolderPath(normalizedSrc)
  const toAbs = absFolderPath(nextPath)
  try {
    await stat(toAbs)
    throw new Error(`folder already exists at destination: ${nextPath}`)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('folder already exists')) throw err
  }
  await rename(fromAbs, toAbs)
  invalidateIndex()
  return { path: nextPath, name, parentPath: normalizedParent }
}

export async function deleteFolder(path: string): Promise<void> {
  const normalized = validateFolderPath(path)
  if (!normalized) throw new Error('cannot delete the root')
  const abs = absFolderPath(normalized)
  // Walk every .md under this folder and harvest image URLs before rm -r so
  // we can clean up orphaned images afterwards.
  const imageUrls = new Set<string>()
  async function harvest(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!entries) return
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        await harvest(child)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const raw = await readFile(child, 'utf-8')
          const { body } = parseDoc(raw)
          collectImageUrlsFromBody(body, imageUrls)
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  await harvest(abs)
  await rm(abs, { recursive: true, force: true })
  await cleanupImageUrls(imageUrls)
  invalidateIndex()
}

// Returned for cascade convenience: lets the IPC delete handler sweep
// orphaned doc-bound conversations whose docs lived under this folder.
export async function listDocIdsUnderFolder(path: string): Promise<string[]> {
  const normalized = validateFolderPath(path)
  if (!normalized) return []
  const { docs } = await walk()
  const prefix = `${normalized}/`
  return docs
    .filter((d) => d.folderPath === normalized || d.folderPath?.startsWith(prefix))
    .map((d) => d.id)
}
