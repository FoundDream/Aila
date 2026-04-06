import { contextBridge, ipcRenderer } from 'electron'

type Callback<T = void> = T extends void ? () => void : (data: T) => void

function onChannel<T = void>(channel: string, callback: Callback<T>): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: T): void =>
    (callback as (data: T) => void)(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('api', {
  // --- Agent session (existing) ---
  prompt: (sessionId: string, text: string) => ipcRenderer.invoke('agent:prompt', sessionId, text),
  abort: (sessionId: string) => ipcRenderer.invoke('agent:abort', sessionId),
  newSession: () => ipcRenderer.invoke('agent:new-session'),
  getConfig: (): Promise<{ hasApiKey: boolean }> => ipcRenderer.invoke('agent:get-config'),

  // Session persistence
  listSessions: () => ipcRenderer.invoke('agent:list-sessions'),
  openSession: (target: { runtimeId?: string | null; path?: string | null }) =>
    ipcRenderer.invoke('agent:open-session', target),
  getSessionState: (sessionId: string) => ipcRenderer.invoke('agent:get-session-state', sessionId),
  editQueuedPrompt: (sessionId: string, promptId: string, currentDraft: string) =>
    ipcRenderer.invoke('agent:edit-queued-prompt', sessionId, promptId, currentDraft),
  removeQueuedPrompt: (sessionId: string, promptId: string) =>
    ipcRenderer.invoke('agent:remove-queued-prompt', sessionId, promptId),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  deleteSession: (target: { runtimeId?: string | null; path?: string | null }) =>
    ipcRenderer.invoke('agent:delete-session', target),

  // Agent push events
  onTextDelta: (cb: (data: { sessionId: string; delta: string }) => void) =>
    onChannel('agent:text-delta', cb),
  onThinkingDelta: (cb: (data: { sessionId: string; delta: string }) => void) =>
    onChannel('agent:thinking-delta', cb),
  onToolStart: (
    cb: (data: {
      sessionId: string
      id: string
      name: string
      args: Record<string, unknown>
    }) => void,
  ) =>
    onChannel('agent:tool-start', cb),
  onToolEnd: (
    cb: (data: {
      sessionId: string
      id: string
      name: string
      result: string
      isError: boolean
    }) => void,
  ) =>
    onChannel('agent:tool-end', cb),
  onComplete: (cb: (data: { sessionId: string }) => void) => onChannel('agent:complete', cb),
  onError: (cb: (data: { sessionId: string; message: string }) => void) =>
    onChannel('agent:error', cb),
  onSessionState: (cb: (data: unknown) => void) => onChannel('agent:session-state', cb),
  onSessionsChanged: (cb: () => void) => onChannel('agent:sessions-changed', cb),

  // --- Provider management ---
  getProviders: (): Promise<unknown[]> => ipcRenderer.invoke('provider:get-all'),
  saveProvider: (provider: unknown): Promise<void> => ipcRenderer.invoke('provider:save', provider),
  deleteProvider: (providerId: string): Promise<void> =>
    ipcRenderer.invoke('provider:delete', providerId),
  testConnection: (providerId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('provider:test-connection', providerId),
  getWebSearchConfig: (): Promise<{ hasTavilyApiKey: boolean }> =>
    ipcRenderer.invoke('websearch:get-config'),
  saveWebSearchConfig: (webSearch: { tavilyApiKey?: string }): Promise<void> =>
    ipcRenderer.invoke('websearch:save-config', webSearch),

  // --- Model management ---
  getModels: (): Promise<unknown[]> => ipcRenderer.invoke('provider:get-models'),
  getActiveModel: (): Promise<string | null> => ipcRenderer.invoke('model:get-active'),
  setActiveModel: (providerId: string, modelId: string): Promise<void> =>
    ipcRenderer.invoke('model:set-active', providerId, modelId),

  // --- Memory management ---
  listMemory: (): Promise<unknown[]> => ipcRenderer.invoke('memory:list'),
  updateMemory: (memory: { id: string; value: string; reason?: string | null }): Promise<void> =>
    ipcRenderer.invoke('memory:update', memory),
  deleteMemory: (id: string): Promise<void> => ipcRenderer.invoke('memory:delete', id),

  // Provider config change events
  onConfigChanged: (cb: () => void) => onChannel('provider:config-changed', cb),
})
