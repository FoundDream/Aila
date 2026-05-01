import { contextBridge, ipcRenderer } from 'electron'

export interface ToolCallPayload {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCallPayload[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ToolCallStartEvent {
  id: string
  name: string
  arguments: string
}

export interface ToolCallResultEvent {
  id: string
  result: string
  isError: boolean
}

export interface DocRecord {
  id: string
  title: string
  content: unknown
  createdAt: number
  updatedAt: number
}

export type DocSummary = Pick<DocRecord, 'id' | 'title' | 'createdAt' | 'updatedAt'>

export type DocPatch = Partial<Pick<DocRecord, 'title' | 'content'>>

export interface PersistedTextBlock {
  type: 'text' | 'reasoning'
  content: string
}

export interface PersistedToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error'
  result?: string
}

export type PersistedBlock = PersistedTextBlock | PersistedToolCallBlock

export interface PersistedMessage {
  id: string
  role: 'user' | 'assistant'
  blocks: PersistedBlock[]
  status: 'streaming' | 'done' | 'error'
  error?: string
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface ConversationRecord {
  meta: ConversationSummary
  messages: PersistedMessage[]
}

function on<T>(channel: string, callback: (data: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: T): void => callback(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  send: (messages: ChatMessage[]): Promise<void> => ipcRenderer.invoke('chat:send', messages),
  abort: (): Promise<void> => ipcRenderer.invoke('chat:abort'),
  onTextDelta: (cb: (delta: string) => void) => on<string>('chat:text-delta', cb),
  onReasoningDelta: (cb: (delta: string) => void) => on<string>('chat:reasoning-delta', cb),
  onToolCallStart: (cb: (event: ToolCallStartEvent) => void) =>
    on<ToolCallStartEvent>('chat:tool-call-start', cb),
  onToolCallResult: (cb: (event: ToolCallResultEvent) => void) =>
    on<ToolCallResultEvent>('chat:tool-call-result', cb),
  onDone: (cb: (full: { text: string; reasoning: string }) => void) =>
    on<{ text: string; reasoning: string }>('chat:done', cb),
  onError: (cb: (message: string) => void) => on<string>('chat:error', cb),
  docs: {
    list: (): Promise<DocSummary[]> => ipcRenderer.invoke('docs:list'),
    get: (id: string): Promise<DocRecord> => ipcRenderer.invoke('docs:get', id),
    create: (): Promise<DocRecord> => ipcRenderer.invoke('docs:create'),
    update: (id: string, patch: DocPatch): Promise<DocRecord> =>
      ipcRenderer.invoke('docs:update', id, patch),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('docs:delete', id),
  },
  conversations: {
    list: (): Promise<ConversationSummary[]> => ipcRenderer.invoke('conversations:list'),
    get: (id: string): Promise<ConversationRecord> => ipcRenderer.invoke('conversations:get', id),
    create: (): Promise<ConversationSummary> => ipcRenderer.invoke('conversations:create'),
    append: (id: string, message: PersistedMessage): Promise<ConversationSummary> =>
      ipcRenderer.invoke('conversations:append', id, message),
    rename: (id: string, title: string): Promise<ConversationSummary> =>
      ipcRenderer.invoke('conversations:rename', id, title),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('conversations:delete', id),
  },
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
