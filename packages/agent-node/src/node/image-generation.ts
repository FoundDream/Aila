import type { ImageGenerateRequest, ImageResult, Settings } from '@aila/agent'
import { MissingApiKeyError, type NodeAuthInput, resolveApiKey } from './auth'
import type { CredentialResolver } from './credential-resolver'
import type { ModelRegistry } from './model-registry'

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

interface OpenRouterImagePart {
  type?: string
  image_url?: { url?: string }
}

interface OpenRouterMessage {
  content?: string | OpenRouterImagePart[]
  images?: Array<{ image_url?: { url?: string } | string; type?: string }>
}

interface OpenRouterResponse {
  choices?: Array<{ message?: OpenRouterMessage }>
  error?: { message?: string }
}

interface NodeImageGeneratorInput extends NodeAuthInput {
  credentialResolver?: CredentialResolver
  modelRegistry?: ModelRegistry
}

export function createNodeImageGenerator(input: NodeImageGeneratorInput = {}) {
  return async (req: ImageGenerateRequest, settings: Settings): Promise<ImageResult> => {
    const descriptor = input.modelRegistry?.resolve({
      providerId: req.providerId,
      modelId: req.modelId,
    })
    const apiKey =
      descriptor && input.credentialResolver
        ? (await input.credentialResolver.resolve({ descriptor, settings })).value
        : resolveApiKey(req.providerId, { ...input, settings })
    if (!apiKey) throw new MissingApiKeyError(req.providerId)

    switch (req.providerId) {
      case 'openrouter':
        return generateOpenRouterImage(req, apiKey)
      default:
        throw new Error(`Image generation is not yet supported for provider "${req.providerId}".`)
    }
  }
}

async function generateOpenRouterImage(
  req: ImageGenerateRequest,
  apiKey: string,
): Promise<ImageResult> {
  const response = await fetch(OPENROUTER_ENDPOINT, {
    method: 'POST',
    signal: req.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_APP_NAME || 'Aila',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'Aila',
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
  if (!url) throw new Error('OpenRouter returned no image. The model may not support image output.')
  const inline = decodeImageUrl(url)
  if (inline) return inline
  return fetchImageUrl(url, req.signal)
}

function extractImageUrl(data: OpenRouterResponse): string | null {
  const message = data.choices?.[0]?.message
  if (!message) return null

  for (const img of message.images ?? []) {
    const u = typeof img.image_url === 'string' ? img.image_url : img.image_url?.url
    if (u) return u
  }

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'image_url' && part.image_url?.url) return part.image_url.url
    }
  }

  return null
}

function decodeImageUrl(url: string): { bytes: Buffer; mime: string } | null {
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
