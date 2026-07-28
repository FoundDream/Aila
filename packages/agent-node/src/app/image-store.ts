import type { ConversationRecord } from '@aila/agent'
import { AILA_IMAGE_HOST, AILA_IMAGE_PROTOCOL, createNodeImageStore } from '../node/image-store'
import { getDataDir } from './paths'

export { imageNameFromUrl, isAllowedImageName, mimeForImageName } from '../node/image-store'

export const IMAGE_PROTOCOL = AILA_IMAGE_PROTOCOL
export const IMAGE_HOST = AILA_IMAGE_HOST

// The data dir is resolved per call so configureDataDir() keeps working after
// module load.
export function saveImage(
  bytes: ArrayBuffer | Uint8Array,
  filename: string,
): Promise<{ url: string }> {
  return createNodeImageStore(getDataDir()).saveImage(bytes, filename)
}

export function cleanupConversationImages(record: ConversationRecord): Promise<void> {
  return createNodeImageStore(getDataDir()).cleanupConversationImages(record)
}
