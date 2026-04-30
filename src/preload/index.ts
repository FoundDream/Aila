import { contextBridge, ipcRenderer } from 'electron'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
  onDone: (cb: (full: { text: string; reasoning: string }) => void) =>
    on<{ text: string; reasoning: string }>('chat:done', cb),
  onError: (cb: (message: string) => void) => on<string>('chat:error', cb),
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
