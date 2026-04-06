export interface ImageAttachment {
  id: string
  data: string
  mimeType: string
  name?: string
}

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
  images?: ImageAttachment[]
  blocks?: Block[]
  status?: MessageStatus
}

export interface PromptDraftValue {
  text: string
  images: ImageAttachment[]
}

export interface QueuedPromptDraft extends PromptDraftValue {
  id: string
}

export type SessionRunStatus = 'idle' | 'running' | 'error'

export interface SessionSummary {
  id: string
  runtimeId: string | null
  path: string | null
  name?: string
  modified: string
  messageCount: number
  firstMessage: string
  status: SessionRunStatus
  queuedCount: number
}

export interface ChatSessionState {
  sessionId: string
  sessionPath: string | null
  messages: Message[]
  isStreaming: boolean
  queuedPrompts: QueuedPromptDraft[]
  status: SessionRunStatus
}

export interface ChatConfig {
  hasApiKey: boolean
  activeModelSupportsImages: boolean
}
