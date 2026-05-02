import type { ProviderId } from '@shared/models'
import type { OrCatalog } from '@shared/openrouter'
import { contextBridge, ipcRenderer } from 'electron'

export type { OrCatalog, OrFamily, OrModel } from '@shared/openrouter'
export type { ProviderId }

export interface ToolCallPayload {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCallPayload[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ChatStreamEventBase {
  conversationId: string
  messageId: string
}

export interface TextDeltaEvent extends ChatStreamEventBase {
  delta: string
}

export interface ReasoningDeltaEvent extends ChatStreamEventBase {
  delta: string
}

export interface ToolCallStartEvent extends ChatStreamEventBase {
  toolCallId: string
  name: string
  arguments: string
}

export interface ToolCallResultEvent extends ChatStreamEventBase {
  toolCallId: string
  result: string
  isError: boolean
}

export interface DocRecord {
  id: string
  parentId: string | null
  title: string
  content: unknown
  createdAt: number
  updatedAt: number
}

export type DocSummary = Pick<DocRecord, 'id' | 'parentId' | 'title' | 'createdAt' | 'updatedAt'>

export type DocPatch = Partial<Pick<DocRecord, 'parentId' | 'title' | 'content'>>

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

export interface ModelSelection {
  providerId: ProviderId
  modelId: string
}

export interface PersistedMessage {
  id: string
  role: 'user' | 'assistant'
  blocks: PersistedBlock[]
  status: 'streaming' | 'done' | 'error'
  error?: string
  model?: ModelSelection
}

export interface Settings {
  apiKeys: {
    anthropic?: string
    openai?: string
    google?: string
    openrouter?: string
  }
  defaultModel: ModelSelection | null
  recentOpenRouterModels?: string[]
}

export interface SettingsState {
  settings: Settings
  configuredProviders: ProviderId[]
}

export interface ConversationUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  updatedAt: number
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  usage?: ConversationUsage
}

export interface UsageInfo {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ChatDoneEvent extends ChatStreamEventBase {
  message: PersistedMessage
  usage?: UsageInfo
}

export interface ChatErrorEvent extends ChatStreamEventBase {
  error: string
  message: PersistedMessage
}

export interface SendResult {
  userMessage: PersistedMessage
  assistantMessageId: string
}

export interface ModelInfo {
  model: string
  contextLength: number | null
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
  send: (
    conversationId: string,
    userText: string,
    selection: ModelSelection,
  ): Promise<SendResult> => ipcRenderer.invoke('chat:send', conversationId, userText, selection),
  abort: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke('chat:abort', conversationId),
  onTextDelta: (cb: (event: TextDeltaEvent) => void) => on<TextDeltaEvent>('chat:text-delta', cb),
  onReasoningDelta: (cb: (event: ReasoningDeltaEvent) => void) =>
    on<ReasoningDeltaEvent>('chat:reasoning-delta', cb),
  onToolCallStart: (cb: (event: ToolCallStartEvent) => void) =>
    on<ToolCallStartEvent>('chat:tool-call-start', cb),
  onToolCallResult: (cb: (event: ToolCallResultEvent) => void) =>
    on<ToolCallResultEvent>('chat:tool-call-result', cb),
  onDone: (cb: (event: ChatDoneEvent) => void) => on<ChatDoneEvent>('chat:done', cb),
  onError: (cb: (event: ChatErrorEvent) => void) => on<ChatErrorEvent>('chat:error', cb),
  getModelInfo: (providerId: ProviderId, modelId: string): Promise<ModelInfo> =>
    ipcRenderer.invoke('chat:get-model-info', providerId, modelId),
  settings: {
    get: (): Promise<SettingsState> => ipcRenderer.invoke('settings:get'),
    set: (settings: Settings): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:set', settings),
  },
  openrouter: {
    listModels: (): Promise<OrCatalog> => ipcRenderer.invoke('openrouter:list-models'),
  },
  docs: {
    list: (): Promise<DocSummary[]> => ipcRenderer.invoke('docs:list'),
    get: (id: string): Promise<DocRecord> => ipcRenderer.invoke('docs:get', id),
    create: (parentId?: string | null): Promise<DocRecord> =>
      ipcRenderer.invoke('docs:create', parentId ?? null),
    update: (id: string, patch: DocPatch): Promise<DocRecord> =>
      ipcRenderer.invoke('docs:update', id, patch),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('docs:delete', id),
  },
  conversations: {
    list: (): Promise<ConversationSummary[]> => ipcRenderer.invoke('conversations:list'),
    get: (id: string): Promise<ConversationRecord> => ipcRenderer.invoke('conversations:get', id),
    create: (): Promise<ConversationSummary> => ipcRenderer.invoke('conversations:create'),
    rename: (id: string, title: string): Promise<ConversationSummary> =>
      ipcRenderer.invoke('conversations:rename', id, title),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('conversations:delete', id),
    onUpdated: (cb: (summary: ConversationSummary) => void) =>
      on<ConversationSummary>('conversations:updated', cb),
  },
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
