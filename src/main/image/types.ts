import type { ProviderId } from '@aila/agent'

export interface ImageRequest {
  prompt: string
  modelId: string
  signal?: AbortSignal
}

export interface ImageResult {
  bytes: ArrayBuffer | Uint8Array
  mime: string
}

export interface ImageAdapter {
  generate(req: ImageRequest, apiKey: string): Promise<ImageResult>
}

export interface ImageGenerateRequest extends ImageRequest {
  providerId: ProviderId
}
