import type {
  PersistedBlock,
  PersistedFileBlock,
  PersistedImageBlock,
  PersistedMessage,
  PersistedTextBlock,
  PersistedToolCallBlock,
  PersistedToolResultRef,
} from '../../types'

export type Block = PersistedBlock
export type TextBlock = PersistedTextBlock
export type ToolCallBlock = PersistedToolCallBlock
export type ImageBlock = PersistedImageBlock
export type FileBlock = PersistedFileBlock
export type { PersistedToolResultRef }

// The chat view widens message status with the renderer-only 'queued' state;
// schemaVersion stays behind the wire boundary.
export interface Message extends Omit<PersistedMessage, 'schemaVersion' | 'status'> {
  status: PersistedMessage['status'] | 'queued'
}
