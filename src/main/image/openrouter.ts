/**
 * OpenRouter image-generation adapter.
 *
 * Uses the chat-completions endpoint with `modalities: ['image', 'text']`.
 * Different OpenRouter-fronted models return images in different shapes, so we
 * probe several known fields before giving up.
 */

import type { ImageAdapter, ImageRequest, ImageResult } from './types'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const APP_NAME = process.env.OPENROUTER_APP_NAME || 'Aila'

interface OpenRouterImagePart {
  type?: string
  image_url?: { url?: string }
}

interface OpenRouterMessage {
  content?: string | OpenRouterImagePart[]
  images?: Array<{ image_url?: { url?: string } | string; type?: string }>
}

interface OpenRouterChoice {
  message?: OpenRouterMessage
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[]
  error?: { message?: string }
}

function extractImageUrl(data: OpenRouterResponse): string | null {
  const message = data.choices?.[0]?.message
  if (!message) return null

  // Shape 1: `message.images[].image_url.url` (gpt-image-1, some Gemini routes)
  for (const img of message.images ?? []) {
    const u = typeof img.image_url === 'string' ? img.image_url : img.image_url?.url
    if (u) return u
  }

  // Shape 2: structured `message.content[]` with `type: 'image_url'` parts
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'image_url' && part.image_url?.url) return part.image_url.url
    }
  }

  return null
}

function decodeImageUrl(url: string): { bytes: Buffer; mime: string } | null {
  // data:<mime>;base64,<payload>
  const match = url.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mime: match[1] ?? 'image/png', bytes: Buffer.from(match[2] ?? '', 'base64') }
}

async function fetchImageUrl(url: string, signal?: AbortSignal): Promise<ImageResult> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Failed to fetch generated image: ${response.status} ${response.statusText}`)
  }
  const mime = response.headers.get('content-type') ?? 'image/png'
  const buf = Buffer.from(await response.arrayBuffer())
  return { bytes: buf, mime: mime.split(';')[0] ?? 'image/png' }
}

async function generate(req: ImageRequest, apiKey: string): Promise<ImageResult> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    signal: req.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': APP_NAME,
      'X-Title': APP_NAME,
    },
    body: JSON.stringify({
      model: req.modelId,
      messages: [{ role: 'user', content: req.prompt }],
      modalities: ['image', 'text'],
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenRouter ${response.status}: ${text || response.statusText}`)
  }

  const data = (await response.json()) as OpenRouterResponse
  if (data.error?.message) throw new Error(`OpenRouter: ${data.error.message}`)

  const url = extractImageUrl(data)
  if (!url) {
    throw new Error('OpenRouter returned no image. The model may not support image output.')
  }

  const inline = decodeImageUrl(url)
  if (inline) return inline
  return fetchImageUrl(url, req.signal)
}

export const openrouterImageAdapter: ImageAdapter = { generate }
