import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { protocol } from 'electron'
import { getImagesDir } from './paths'

export const IMAGE_PROTOCOL = 'aila-image'
const IMAGE_HOST = 'i'
const URL_PREFIX = `${IMAGE_PROTOCOL}://${IMAGE_HOST}/`

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const MAX_BYTES = 10 * 1024 * 1024

function pickExtension(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return ALLOWED_EXTENSIONS.has(ext) ? ext : '.png'
}

function isAllowedImageName(name: string): boolean {
  if (!name) return false
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
  return ALLOWED_EXTENSIONS.has(extname(name).toLowerCase())
}

function mimeForExt(name: string): string {
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

export async function saveImage(
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
  const dir = getImagesDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), buf)
  return { url: `${URL_PREFIX}${name}` }
}

export function imageNameFromUrl(url: string): string | null {
  if (!url.startsWith(URL_PREFIX)) return null
  const name = url.slice(URL_PREFIX.length)
  return isAllowedImageName(name) ? name : null
}

export function registerImageProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMAGE_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ])
}

export function handleImageProtocol(): void {
  protocol.handle(IMAGE_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== IMAGE_HOST) {
        return new Response('Not Found', { status: 404 })
      }
      const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!isAllowedImageName(name)) {
        return new Response('Forbidden', { status: 403 })
      }
      const data = await readFile(join(getImagesDir(), name))
      return new Response(data, {
        headers: {
          'Content-Type': mimeForExt(name),
          'Cache-Control': 'no-cache',
        },
      })
    } catch (err) {
      console.error('[images] failed to serve', request.url, err)
      return new Response('Not Found', { status: 404 })
    }
  })
}
