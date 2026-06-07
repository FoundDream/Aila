import type { ProviderId } from '../../shared/models'

export interface ImageRequest {
  prompt: string
  modelId: string
  signal?: AbortSignal
}

export interface ImageResult {
  bytes: Buffer
  mime: string
}

export interface ImageAdapter {
  generate(req: ImageRequest, apiKey: string): Promise<ImageResult>
}

export interface ImageGenerateRequest extends ImageRequest {
  providerId: ProviderId
}
