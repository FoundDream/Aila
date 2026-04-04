export type Block =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'tool'
      id: string
      name: string
      args: Record<string, unknown>
      result?: string
      isError?: boolean
      status: 'running' | 'done'
    }

export type MessageStatus = 'queued' | 'streaming' | 'done'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content?: string
  blocks?: Block[]
  status?: MessageStatus
}

export interface QueuedPromptDraft {
  id: string
  text: string
}

export interface ChatConfig {
  hasApiKey: boolean
}
