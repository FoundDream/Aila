/**
 * Vertex AI Imagen adapter.
 *
 * Hits the project-scoped `:predict` REST endpoint. Auth uses an SA-bound API
 * key sent as `x-goog-api-key` — the Vercel SDK's apiKey path forces the
 * Express Mode endpoint, which doesn't authorize :predict, so we go direct.
 */

import { resolveVertexConfig, type Settings } from '../settings'
import type { ImageRequest, ImageResult } from './types'

interface ImagenPrediction {
  bytesBase64Encoded?: string
  mimeType?: string
}

interface ImagenResponse {
  predictions?: ImagenPrediction[]
  error?: { message?: string }
}

export async function generateVertexImage(
  req: ImageRequest,
  apiKey: string,
  settings: Settings,
): Promise<ImageResult> {
  const cfg = resolveVertexConfig(settings)
  if (!cfg) {
    throw new Error(
      'Vertex Imagen needs project + location. Open Settings and fill in both fields under Google Vertex.',
    )
  }
  const { project, location } = cfg

  const host =
    location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`
  const url =
    `https://${host}/v1/projects/${project}/locations/${location}` +
    `/publishers/google/models/${req.modelId}:predict`

  const response = await fetch(url, {
    method: 'POST',
    signal: req.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      instances: [{ prompt: req.prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: '1:1',
      },
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Vertex Imagen ${response.status}: ${text || response.statusText}`)
  }

  const data = (await response.json()) as ImagenResponse
  if (data.error?.message) throw new Error(`Vertex Imagen: ${data.error.message}`)

  const prediction = data.predictions?.[0]
  if (!prediction?.bytesBase64Encoded) {
    throw new Error('Vertex Imagen returned no image (likely safety-blocked or quota error).')
  }

  return {
    bytes: Buffer.from(prediction.bytesBase64Encoded, 'base64'),
    mime: prediction.mimeType ?? 'image/png',
  }
}
