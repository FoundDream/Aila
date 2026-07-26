import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getImagesDir,
  IMAGE_HOST,
  IMAGE_PROTOCOL,
  isAllowedImageName,
  mimeForImageName,
} from '@aila/agent-node/app'
import { protocol } from 'electron'

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
          'Content-Type': mimeForImageName(name),
          'Cache-Control': 'no-cache',
        },
      })
    } catch (err) {
      console.error('[images] failed to serve', request.url, err)
      return new Response('Not Found', { status: 404 })
    }
  })
}
