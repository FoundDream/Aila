import type { ProviderId } from '../../types'

export type BlockType = 'text' | 'reasoning' | 'tool_call' | 'image' | 'file'

export interface TextBlock {
  type: 'text' | 'reasoning'
  content: string
}

export interface ToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error'
  result?: string
  resultRef?: PersistedToolResultRef
}

export interface PersistedToolResultRef {
  kind: 'file'
  path: string
  relativePath: string
  sizeChars: number
  preview: string
}

export interface ImageBlock {
  type: 'image'
  url: string
  mime: string
  prompt?: string
}

export interface FileBlock {
  type: 'file'
  name: string
  content: string
}

export type Block = TextBlock | ToolCallBlock | ImageBlock | FileBlock

export interface Message {
  id: string
  role: 'user' | 'assistant'
  blocks: Block[]
  status: 'streaming' | 'queued' | 'done' | 'error'
  error?: string
  model?: { providerId: ProviderId; modelId: string }
}
