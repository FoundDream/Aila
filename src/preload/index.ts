import { contextBridge, ipcRenderer } from 'electron'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

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
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
