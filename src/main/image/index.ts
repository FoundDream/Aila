/**
 * Image-generation dispatcher. Each chat tool call resolves the API key per
 * call (mirroring providers.ts) and routes to the right adapter — adding a
 * provider is one new file + one switch arm.
 */

import { MissingApiKeyError } from '../providers'
import { resolveApiKey, type Settings } from '../settings'
import { openrouterImageAdapter } from './openrouter'
import type { ImageGenerateRequest, ImageResult } from './types'
import { generateVertexImage } from './vertex'

export type { ImageGenerateRequest, ImageRequest, ImageResult } from './types'

export async function generateImage(
  req: ImageGenerateRequest,
  settings: Settings,
): Promise<ImageResult> {
  const apiKey = resolveApiKey(req.providerId, settings)
  if (!apiKey) throw new MissingApiKeyError(req.providerId)

  switch (req.providerId) {
    case 'openrouter':
      return openrouterImageAdapter.generate(req, apiKey)
    case 'vertex':
      return generateVertexImage(req, apiKey, settings)
    default:
      throw new Error(`Image generation is not yet supported for provider "${req.providerId}".`)
  }
}
