'use client'

import { ImagePlugin } from '@platejs/media/react'
import { TrailingBlockPlugin } from '@platejs/utils'
import { KEYS } from 'platejs'
import { ImageElement } from '@/components/ui/image-node'

function decodeDataUrl(dataUrl: string): { bytes: ArrayBuffer; subtype: string } | null {
  const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/)
  if (!match) return null
  const [, mime, base64, payload] = match
  const subtype = mime.split('/')[1]?.split('+')[0] ?? 'png'
  const decoded = base64
    ? Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload))
  return { bytes: decoded.buffer as ArrayBuffer, subtype }
}

async function uploadDataUrl(dataUrl: string): Promise<string> {
  const decoded = decodeDataUrl(dataUrl)
  if (!decoded) return dataUrl
  const { url } = await window.api.images.save(decoded.bytes, `paste.${decoded.subtype}`)
  return url
}

async function uploadBuffer(buf: ArrayBuffer): Promise<string> {
  const { url } = await window.api.images.save(buf, 'paste.png')
  return url
}

export const MediaKit = () => [
  ImagePlugin.configure({
    options: {
      uploadImage: async (input) => {
        if (typeof input === 'string') {
          if (!input.startsWith('data:')) return input
          return uploadDataUrl(input)
        }
        return uploadBuffer(input)
      },
    },
    render: { node: ImageElement },
  }),
  TrailingBlockPlugin.configure({ options: { type: KEYS.p } }),
]

export async function pickImageFiles(): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.style.position = 'fixed'
    input.style.opacity = '0'
    input.style.pointerEvents = 'none'
    document.body.appendChild(input)

    let settled = false
    const cleanup = (): void => {
      if (settled) return
      settled = true
      input.remove()
    }

    input.addEventListener('change', () => {
      const files = input.files
      cleanup()
      resolve(files && files.length > 0 ? files : null)
    })
    input.addEventListener('cancel', () => {
      cleanup()
      resolve(null)
    })
    window.addEventListener(
      'focus',
      () => {
        // Fallback in case the cancel event isn't fired by the platform.
        setTimeout(() => {
          if (!settled) {
            cleanup()
            resolve(null)
          }
        }, 300)
      },
      { once: true },
    )

    input.click()
  })
}
