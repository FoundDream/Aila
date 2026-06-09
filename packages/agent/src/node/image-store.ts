import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { ConversationRecord, PersistedImageBlock } from '../conversation-core'

export const AILA_IMAGE_PROTOCOL = 'aila-image'
export const AILA_IMAGE_HOST = 'i'

const URL_PREFIX = `${AILA_IMAGE_PROTOCOL}://${AILA_IMAGE_HOST}/`
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const MAX_BYTES = 10 * 1024 * 1024

export function getNodeImagesDir(dataDir: string): string {
  return join(dataDir, 'images')
}

export interface NodeImageStoreOptions {
  dataDir: string
  imageDir?: string
}

export function isAllowedImageName(name: string): boolean {
  if (!name) return false
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
  return ALLOWED_EXTENSIONS.has(extname(name).toLowerCase())
}

export function imageNameFromUrl(url: string): string | null {
  if (!url.startsWith(URL_PREFIX)) return null
  const name = url.slice(URL_PREFIX.length)
  return isAllowedImageName(name) ? name : null
}

export function mimeForImageName(name: string): string {
  switch (extname(name).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

export function createNodeImageStore(input: string | NodeImageStoreOptions): {
  imageDir: string
  saveImage: (bytes: ArrayBuffer | Uint8Array, filename: string) => Promise<{ url: string }>
  cleanupConversationImages: (record: ConversationRecord) => Promise<void>
} {
  const imageDir =
    typeof input === 'string'
      ? getNodeImagesDir(input)
      : (input.imageDir ?? getNodeImagesDir(input.dataDir))
  return {
    imageDir,
    saveImage: (bytes, filename) => saveNodeImage(imageDir, bytes, filename),
    cleanupConversationImages: (record) => cleanupConversationImages(imageDir, record),
  }
}

async function saveNodeImage(
  imageDir: string,
  bytes: ArrayBuffer | Uint8Array,
  filename: string,
): Promise<{ url: string }> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (buf.byteLength === 0) throw new Error('Image is empty')
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`Image exceeds ${Math.round(MAX_BYTES / (1024 * 1024))}MB limit`)
  }
  const ext = pickExtension(filename)
  const name = `${randomUUID()}${ext}`
  await mkdir(imageDir, { recursive: true })
  await writeFile(join(imageDir, name), buf)
  return { url: `${URL_PREFIX}${name}` }
}

function pickExtension(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return ALLOWED_EXTENSIONS.has(ext) ? ext : '.png'
}

async function cleanupConversationImages(
  imageDir: string,
  record: ConversationRecord,
): Promise<void> {
  const filenames = record.messages.flatMap((message) =>
    message.blocks
      .filter((block): block is PersistedImageBlock => block.type === 'image')
      .map((block) => imageNameFromUrl(block.url))
      .filter((name): name is string => name !== null),
  )
  await Promise.all(filenames.map((name) => unlink(join(imageDir, name)).catch(() => {})))
}
