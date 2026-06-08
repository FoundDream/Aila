import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix as pathPosix, relative, sep } from 'node:path'
import type { ConversationSummary } from '../runtime/core'
import { type DocRefRewrite, rewriteDocRefs as rewritePersistedDocRefs } from './conversations'
import { imageNameFromUrl } from './image-store'
import { getDocumentsDir, getImagesDir } from './paths'

// Vault philosophy (Obsidian-style): the on-disk filename IS the doc's identity.
// `path` is the vault-relative posix path WITHOUT the .md extension. Title is
// always derived from the basename. createdAt/updatedAt come from fs.stat —
// no frontmatter is written by the app.
export interface DocRecord {
  path: string
  folderPath: string | null
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

export type DocSummary = Pick<
  DocRecord,
  'path' | 'folderPath' | 'title' | 'createdAt' | 'updatedAt'
>

export interface FolderSummary {
  path: string
  name: string
  parentPath: string | null
}

export type DocConversationRefRewriter = (
  rewrites: readonly DocRefRewrite[],
) => Promise<readonly ConversationSummary[]>

const DEFAULT_TITLE = '无标题文档'
const EMPTY_CONTENT = ''
const TITLE_MAX_LEN = 200
const MAX_SUFFIX_TRIES = 10000

const IMAGE_URL_RE = /aila-image:\/\/i\/[A-Za-z0-9._-]+/g
const defaultDocConversationRefRewriter: DocConversationRefRewriter = (rewrites) =>
  rewritePersistedDocRefs([...rewrites])
let docConversationRefRewriter = defaultDocConversationRefRewriter

export function configureDocConversationRefRewriter(rewriter?: DocConversationRefRewriter): void {
  docConversationRefRewriter = rewriter ?? defaultDocConversationRefRewriter
}

function rewriteDocRefs(
  rewrites: readonly DocRefRewrite[],
): Promise<readonly ConversationSummary[]> {
  return docConversationRefRewriter(rewrites)
}

// Forbids path/separator chars, shell-glob & filesystem-illegal chars (Windows
// is the strict superset), and ASCII control chars. Used for both folder names
// and doc titles — single source of truth.
// biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly forbidding control chars in filenames
const NAME_BAD = /[\\/<>:"|?*\x00-\x1f]/

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

function validateNameSegment(name: string, kind: 'folder' | 'doc'): string {
  // Trim then strip trailing dots and spaces — both are valid in user input
  // but the underlying FS (Windows especially) silently mangles them on rename.
  const trimmed = name.trim().replace(/[. ]+$/, '')
  if (trimmed.length === 0) throw new Error(`${kind} name cannot be empty`)
  if (trimmed === '.' || trimmed === '..') throw new Error(`invalid ${kind} name: ${trimmed}`)
  if (trimmed.startsWith('.')) throw new Error(`${kind} name cannot start with a dot`)
  if (NAME_BAD.test(trimmed)) {
    throw new Error(`${kind} name contains illegal characters: ${trimmed}`)
  }
  if (trimmed.length > TITLE_MAX_LEN) {
    throw new Error(`${kind} name too long (max ${TITLE_MAX_LEN} characters)`)
  }
  return trimmed
}

function validateFolderName(name: string): string {
  return validateNameSegment(name, 'folder')
}

function validateTitle(name: string): string {
  return validateNameSegment(name, 'doc')
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
    validateNameSegment(part, 'folder')
  }
  return normalized
}

// Parse a vault doc path into (folderPath, title). Used by getDoc/updateDoc to
// validate inbound IPC payloads.
function parseDocPath(rel: string): { folderPath: string | null; title: string } {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error('doc path cannot be empty')
  }
  const trimmed = rel.replace(/^\/+|\/+$/g, '')
  if (trimmed.length === 0) throw new Error('doc path cannot be empty')
  const normalized = pathPosix.normalize(trimmed)
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`invalid doc path: ${rel}`)
  }
  const parts = normalized.split('/')
  for (let i = 0; i < parts.length; i++) {
    validateNameSegment(parts[i], i === parts.length - 1 ? 'doc' : 'folder')
  }
  const title = parts[parts.length - 1]
  const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : null
  return { folderPath, title }
}

function absFolderPath(folderPath: string | null): string {
  return folderPath ? join(getDocumentsDir(), fromPosix(folderPath)) : getDocumentsDir()
}

function docAbsPath(docPath: string): string {
  return join(getDocumentsDir(), `${fromPosix(docPath)}.md`)
}

export function getDocFilePath(docPath: string): string {
  parseDocPath(docPath)
  return docAbsPath(docPath)
}

function joinDocPath(folderPath: string | null, title: string): string {
  return folderPath ? `${folderPath}/${title}` : title
}

// Pre-vault docs were written with YAML frontmatter (id/title/createdAt/
// updatedAt). The new code never writes frontmatter, but legacy files on disk
// still have it. Strip on read so it doesn't render in the editor; the next
// save (which writes only the stripped body back) makes the cleanup permanent.
function stripLeadingFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? raw.slice(match[0].length) : raw
}

async function readDocRecord(docPath: string): Promise<DocRecord> {
  const abs = docAbsPath(docPath)
  const [raw, st] = await Promise.all([readFile(abs, 'utf-8'), stat(abs)])
  const { folderPath, title } = parseDocPath(docPath)
  return {
    path: docPath,
    folderPath,
    title,
    content: stripLeadingFrontmatter(raw),
    createdAt: Number(st.birthtimeMs) || Number(st.ctimeMs) || Number(st.mtimeMs),
    updatedAt: Number(st.mtimeMs),
  }
}

interface WalkResult {
  folders: FolderSummary[]
  docs: DocSummary[]
}

async function walk(): Promise<WalkResult> {
  const root = await ensureRoot()
  const folders: FolderSummary[] = []
  const docs: DocSummary[] = []

  async function visit(absDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true })
    for (const entry of entries) {
      // Skip hidden files (.DS_Store, .git, etc.) — they're not user docs.
      if (entry.name.startsWith('.')) continue
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
          const st = await stat(absChild)
          const folderRel = toPosix(relative(root, absDir))
          const title = entry.name.slice(0, -3)
          const folderPath = folderRel.length === 0 ? null : folderRel
          const docPath = joinDocPath(folderPath, title)
          docs.push({
            path: docPath,
            folderPath,
            title,
            createdAt: Number(st.birthtimeMs) || Number(st.ctimeMs) || Number(st.mtimeMs),
            updatedAt: Number(st.mtimeMs),
          })
        } catch {
          // Stat failed — skip this entry.
        }
      }
    }
  }

  await visit(root)
  return { folders, docs }
}

export async function listAll(): Promise<{ folders: FolderSummary[]; docs: DocSummary[] }> {
  const { folders, docs } = await walk()
  docs.sort((a, b) => b.updatedAt - a.updatedAt)
  folders.sort((a, b) => a.path.localeCompare(b.path))
  return { folders, docs }
}

export async function getDoc(docPath: string): Promise<DocRecord> {
  parseDocPath(docPath)
  return readDocRecord(docPath)
}

// Atomic create via O_EXCL + auto-suffix loop. Returns the absolute path of
// the new empty file. macOS-style suffixing: "Foo.md", "Foo 2.md", "Foo 3.md", …
async function createUniqueEmptyDoc(folderPath: string | null, baseTitle: string): Promise<string> {
  const folderAbs = absFolderPath(folderPath)
  for (let n = 0; n < MAX_SUFFIX_TRIES; n++) {
    const candidate = n === 0 ? `${baseTitle}.md` : `${baseTitle} ${n + 1}.md`
    const abs = join(folderAbs, candidate)
    try {
      const handle = await open(abs, 'wx')
      try {
        await handle.writeFile(EMPTY_CONTENT, 'utf-8')
      } finally {
        await handle.close()
      }
      return abs
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
    }
  }
  throw new Error(`exhausted ${MAX_SUFFIX_TRIES} suffix tries for "${baseTitle}"`)
}

export async function createDoc(folderPath: string | null = null): Promise<DocRecord> {
  await ensureRoot()
  const normalized = validateFolderPath(folderPath)
  if (normalized) {
    try {
      const s = await stat(absFolderPath(normalized))
      if (!s.isDirectory()) throw new Error(`folder is not a directory: ${normalized}`)
    } catch {
      throw new Error(`folder not found: ${normalized}`)
    }
  }
  const abs = await createUniqueEmptyDoc(normalized, DEFAULT_TITLE)
  const title = basename(abs).slice(0, -3)
  return readDocRecord(joinDocPath(normalized, title))
}

export interface DocPatch {
  title?: string
  content?: string
  folderPath?: string | null
}

export async function updateDoc(docPath: string, patch: DocPatch): Promise<DocRecord> {
  const { folderPath: currentFolder, title: currentTitle } = parseDocPath(docPath)
  const currentAbs = docAbsPath(docPath)

  const nextTitle = patch.title === undefined ? currentTitle : validateTitle(patch.title)
  const nextFolder =
    patch.folderPath === undefined ? currentFolder : validateFolderPath(patch.folderPath)

  if (patch.folderPath !== undefined && nextFolder !== currentFolder && nextFolder !== null) {
    try {
      const s = await stat(absFolderPath(nextFolder))
      if (!s.isDirectory()) throw new Error(`folder is not a directory: ${nextFolder}`)
    } catch {
      throw new Error(`folder not found: ${nextFolder}`)
    }
  }

  const nextDocPath = joinDocPath(nextFolder, nextTitle)
  const nextAbs = docAbsPath(nextDocPath)

  if (nextAbs !== currentAbs) {
    // Rename collision is a user-visible error, not auto-suffixed — matches
    // Obsidian's rename UX.
    try {
      await stat(nextAbs)
      throw new Error('A note with that name already exists in this folder')
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('A note with that name')) throw err
      // Otherwise ENOENT, expected.
    }
    await mkdir(dirname(nextAbs), { recursive: true })
    await rename(currentAbs, nextAbs)
    // Cascade conversation refs from old path → new path. If this fails, the
    // file rename has already committed; affected doc-bound chats lose their
    // binding and surface as orphans on the next sweep.
    try {
      await rewriteDocRefs([{ oldPath: docPath, newPath: nextDocPath }])
    } catch (err) {
      console.error('[docs] cascade rewrite failed after rename', err)
    }
  }

  if (patch.content !== undefined) {
    await writeFile(nextAbs, patch.content, 'utf-8')
  }

  return readDocRecord(nextDocPath)
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

export async function deleteDoc(docPath: string): Promise<void> {
  parseDocPath(docPath)
  const abs = docAbsPath(docPath)
  const imageUrls = new Set<string>()
  try {
    const content = await readFile(abs, 'utf-8')
    collectImageUrlsFromBody(content, imageUrls)
  } catch {
    // Doc unreadable — skip image collection.
  }
  await rm(abs, { force: true })
  await cleanupImageUrls(imageUrls)
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
  }
  await mkdir(abs, { recursive: false })
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
  try {
    await rewriteDocRefs([{ oldPath: normalized, newPath: nextPath, isFolder: true }])
  } catch (err) {
    console.error('[docs] cascade rewrite failed after folder rename', err)
  }
  return { path: nextPath, name: cleanName, parentPath }
}

export async function moveFolder(
  path: string,
  newParentPath: string | null,
): Promise<FolderSummary> {
  const normalizedSrc = validateFolderPath(path)
  if (!normalizedSrc) throw new Error('cannot move the root')
  const normalizedParent = validateFolderPath(newParentPath)
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
  try {
    await rewriteDocRefs([{ oldPath: normalizedSrc, newPath: nextPath, isFolder: true }])
  } catch (err) {
    console.error('[docs] cascade rewrite failed after folder move', err)
  }
  return { path: nextPath, name, parentPath: normalizedParent }
}

export async function deleteFolder(path: string): Promise<void> {
  const normalized = validateFolderPath(path)
  if (!normalized) throw new Error('cannot delete the root')
  const abs = absFolderPath(normalized)
  // Walk every .md under this folder and harvest image URLs before rm -r so
  // we can clean up orphaned images afterwards.
  const imageUrls = new Set<string>()
  async function collect(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        await collect(child)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const body = await readFile(child, 'utf-8')
          collectImageUrlsFromBody(body, imageUrls)
        } catch {
          // ignore unreadable
        }
      }
    }
  }
  try {
    await collect(abs)
  } catch {
    // folder might already be gone
  }
  await rm(abs, { recursive: true, force: true })
  await cleanupImageUrls(imageUrls)
}
