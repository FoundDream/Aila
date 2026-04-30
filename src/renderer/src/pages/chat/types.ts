export type BlockType = 'text' | 'reasoning'

export interface Block {
  type: BlockType
  content: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  blocks: Block[]
  status: 'streaming' | 'done' | 'error'
  error?: string
}
