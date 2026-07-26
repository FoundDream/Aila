import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolPack } from '@aila/agent'
import { createToolRegistry } from '@aila/agent/host'
import { getToolPacksDir } from './paths'

export const AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION = 1
export const AILA_TOOL_PACK_MANIFEST_FILE = 'aila-tool-pack.json'

export interface ToolPackManifest {
  schemaVersion: typeof AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION
  id: string
  name: string
  description?: string
  entry: string
  enabled?: boolean
}

export interface LoadedToolPack {
  directory: string
  manifestPath: string
  manifest: ToolPackManifest
  toolPack: ToolPack
}

type ToolPackFactory = () => ToolPack | Promise<ToolPack>

const TOOL_PACK_IMPORT_CACHE_DIR = 'aila-tool-pack-import-cache'
const HASH_EXCLUDED_DIRECTORIES = new Set(['.git'])

interface ToolPackModule {
  default?: ToolPack | ToolPackFactory
  toolPack?: ToolPack | ToolPackFactory
  createToolPack?: ToolPackFactory
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

function assertSafeRelativePath(value: string, label: string): void {
  if (isAbsolute(value)) throw new Error(`${label} must be relative`)
  const normalized = resolve('/', value)
  if (!normalized.startsWith('/')) throw new Error(`${label} is invalid`)
  if (value.split(/[\\/]/).includes('..')) {
    throw new Error(`${label} must not traverse parent directories`)
  }
}

export function parseToolPackManifest(value: unknown): ToolPackManifest {
  assertObject(value, 'tool pack manifest')
  if (value.schemaVersion !== AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `unsupported tool pack manifest schemaVersion: ${String(value.schemaVersion ?? 'missing')}`,
    )
  }
  assertNonEmptyString(value.id, 'manifest.id')
  assertNonEmptyString(value.name, 'manifest.name')
  assertNonEmptyString(value.entry, 'manifest.entry')
  assertSafeRelativePath(value.entry, 'manifest.entry')
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new Error('manifest.description must be a string')
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error('manifest.enabled must be a boolean')
  }

  return {
    schemaVersion: AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION,
    id: value.id,
    name: value.name,
    entry: value.entry,
    ...(value.description !== undefined && { description: value.description }),
    ...(value.enabled !== undefined && { enabled: value.enabled }),
  }
}

export async function loadToolPackManifest(manifestPath: string): Promise<ToolPackManifest> {
  const raw = await readFile(manifestPath, 'utf-8')
  return parseToolPackManifest(JSON.parse(raw))
}

function resolveEntryPath(directory: string, entry: string): string {
  const resolved = resolve(directory, entry)
  const rel = relative(directory, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`tool pack entry must stay inside pack directory: ${entry}`)
  }
  return resolved
}

function selectToolPackExport(module: ToolPackModule): ToolPack | ToolPackFactory {
  if (module.default) return module.default
  if (module.toolPack) return module.toolPack
  if (module.createToolPack) return module.createToolPack
  throw new Error('tool pack module must export default, toolPack, or createToolPack')
}

async function getEntryImportHref(entryPath: string): Promise<string> {
  return pathToFileURL(entryPath).href
}

function sanitizeCacheSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

async function updateDirectoryHash(
  hash: ReturnType<typeof createHash>,
  root: string,
  directory: string,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && HASH_EXCLUDED_DIRECTORIES.has(entry.name)) continue

    const path = join(directory, entry.name)
    const relativePath = relative(root, path)

    if (entry.isDirectory()) {
      hash.update(`dir:${relativePath}\0`)
      await updateDirectoryHash(hash, root, path)
      continue
    }

    if (entry.isFile()) {
      hash.update(`file:${relativePath}\0`)
      hash.update(await readFile(path))
      hash.update('\0')
    }
  }
}

async function getToolPackSourceDigest(directory: string): Promise<string> {
  const hash = createHash('sha256')
  await updateDirectoryHash(hash, directory, directory)
  return hash.digest('hex')
}

async function prepareCachedEntryPath(
  directory: string,
  manifest: ToolPackManifest,
): Promise<string> {
  const digest = await getToolPackSourceDigest(directory)
  const cacheDir = join(
    tmpdir(),
    TOOL_PACK_IMPORT_CACHE_DIR,
    `${sanitizeCacheSegment(manifest.id)}-${digest}`,
  )
  const cachedEntryPath = resolveEntryPath(cacheDir, manifest.entry)

  try {
    await stat(cachedEntryPath)
  } catch {
    await mkdir(cacheDir, { recursive: true })
    await cp(directory, cacheDir, { recursive: true, force: true })
  }

  return cachedEntryPath
}

async function materializeToolPack(exported: ToolPack | ToolPackFactory): Promise<ToolPack> {
  return typeof exported === 'function' ? await exported() : exported
}

function validateLoadedToolPack(manifest: ToolPackManifest, toolPack: ToolPack): ToolPack {
  assertObject(toolPack, 'tool pack')
  assertNonEmptyString(toolPack.id, 'toolPack.id')
  assertNonEmptyString(toolPack.name, 'toolPack.name')
  if (toolPack.id !== manifest.id) {
    throw new Error(`tool pack id mismatch: manifest "${manifest.id}", module "${toolPack.id}"`)
  }
  if (toolPack.name !== manifest.name) {
    throw new Error(
      `tool pack name mismatch: manifest "${manifest.name}", module "${toolPack.name}"`,
    )
  }
  if (!Array.isArray(toolPack.tools) || toolPack.tools.length === 0) {
    throw new Error(`tool pack "${manifest.id}" must define at least one tool`)
  }
  createToolRegistry([toolPack])
  return toolPack
}

export async function loadToolPackFromManifest(manifestPath: string): Promise<LoadedToolPack> {
  const manifest = await loadToolPackManifest(manifestPath)
  const directory = dirname(resolve(manifestPath))
  if (manifest.enabled === false) {
    throw new Error(`tool pack is disabled: ${manifest.id}`)
  }

  const entryPath = await prepareCachedEntryPath(directory, manifest)
  const module = (await import(await getEntryImportHref(entryPath))) as ToolPackModule
  const toolPack = validateLoadedToolPack(
    manifest,
    await materializeToolPack(selectToolPackExport(module)),
  )

  return {
    directory,
    manifestPath,
    manifest,
    toolPack,
  }
}

export async function loadToolPacksFromDir(dir = getToolPacksDir()): Promise<LoadedToolPack[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const loaded: LoadedToolPack[] = []
  for (const entry of entries.sort()) {
    const directory = join(dir, entry)
    try {
      const info = await stat(directory)
      if (!info.isDirectory()) continue
      const manifestPath = join(directory, AILA_TOOL_PACK_MANIFEST_FILE)
      const manifest = await loadToolPackManifest(manifestPath)
      if (manifest.enabled === false) continue
      loaded.push(await loadToolPackFromManifest(manifestPath))
    } catch (error) {
      throw new Error(
        `failed to load tool pack "${entry}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return loaded
}
