export type BlockType = 'text' | 'reasoning' | 'tool_call'

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
}

export type Block = TextBlock | ToolCallBlock

export interface Message {
  id: string
  role: 'user' | 'assistant'
  blocks: Block[]
  status: 'streaming' | 'done' | 'error'
  error?: string
}
