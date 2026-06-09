/**
 * Image-generation dispatcher. Each chat tool call resolves the API key per
 * call (mirroring providers.ts) and routes to the right adapter — adding a
 * provider is one new file + one switch arm.
 */

import { createNodeImageGenerator } from '@aila/agent/node'
import type { Settings } from '../settings'
import type { ImageGenerateRequest, ImageResult } from './types'

export type { ImageGenerateRequest, ImageRequest, ImageResult } from './types'

export async function generateImage(
  req: ImageGenerateRequest,
  settings: Settings,
): Promise<ImageResult> {
  return createNodeImageGenerator()(req, settings)
}
