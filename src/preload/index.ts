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

export interface ToolCallArgsDeltaEvent extends ChatStreamEventBase {
  toolCallId: string
  delta: string
}

export interface ToolCallResultEvent extends ChatStreamEventBase {
  toolCallId: string
  result: string
  isError: boolean
}

export interface DocRecord {
  // Vault-relative posix path WITHOUT .md extension (e.g. "notes/Foo"). Filename
  // is the doc's identity — title is derived from the basename.
  path: string
  folderPath: string | null
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

export type DocSummary = Pick<
  DocRecord,
  'path' | 'folderPath' | 'title' | 'createdAt' | 'updatedAt'
>

export interface FolderSummary {
  path: string
  name: string
  parentPath: string | null
}

export interface DocsListResult {
  folders: FolderSummary[]
  docs: DocSummary[]
}

export type DocPatch = Partial<Pick<DocRecord, 'folderPath' | 'title' | 'content'>>

export interface DocEditFindReplace {
  old_string: string
  new_string: string
}

export interface DocEditPatch {
  index: number
  from: number
  to: number
  oldLength: number
  newLength: number
  oldPreview: string
  newPreview: string
  diffPreview: string
}

export interface DocEditRequestEvent {
  requestId: string
  docPath: string
  edits: DocEditFindReplace[]
  reason?: string
}

export type DocEditResult =
  | { ok: true; title: string; appliedCount: number; patches: DocEditPatch[]; diffPreview: string }
  | { ok: false; error: string; conflicts?: string[] }

export type DocEditResponse = DocEditResult & { requestId: string }

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

export interface PersistedImageBlock {
  type: 'image'
  url: string
  mime: string
  prompt?: string
}

export type PersistedBlock = PersistedTextBlock | PersistedToolCallBlock | PersistedImageBlock

export interface ImageBlockEvent extends ChatStreamEventBase {
  block: PersistedImageBlock
}

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
  defaultImageModel?: ModelSelection | null
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
  // Set when this conversation is the AI sidebar of a specific doc. The chat
  // tab filters these out; doc context is injected by main on each send.
  docId?: string | null
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
  onToolCallArgsDelta: (cb: (event: ToolCallArgsDeltaEvent) => void) =>
    on<ToolCallArgsDeltaEvent>('chat:tool-call-args-delta', cb),
  onToolCallResult: (cb: (event: ToolCallResultEvent) => void) =>
    on<ToolCallResultEvent>('chat:tool-call-result', cb),
  onImageBlock: (cb: (event: ImageBlockEvent) => void) =>
    on<ImageBlockEvent>('chat:image-block', cb),
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
    list: (): Promise<DocsListResult> => ipcRenderer.invoke('docs:list'),
    get: (docPath: string): Promise<DocRecord> => ipcRenderer.invoke('docs:get', docPath),
    create: (folderPath?: string | null): Promise<DocRecord> =>
      ipcRenderer.invoke('docs:create', folderPath ?? null),
    update: (docPath: string, patch: DocPatch): Promise<DocRecord> =>
      ipcRenderer.invoke('docs:update', docPath, patch),
    delete: (docPath: string): Promise<void> => ipcRenderer.invoke('docs:delete', docPath),
    // Subscribed by the active DocEditor: each event represents an edit_doc
    // tool call that needs to be applied via the live CodeMirror view.
    onEditRequest: (cb: (event: DocEditRequestEvent) => void) =>
      on<DocEditRequestEvent>('docs:edit-request', cb),
    sendEditResponse: (response: DocEditResponse): void => {
      ipcRenderer.send('docs:edit-response', response)
    },
    // Disk-only find/replace for docs that aren't currently mounted in the
    // editor. The renderer falls back to this when an edit_doc tool call
    // targets an inactive doc.
    applyEditDirect: (docPath: string, edits: DocEditFindReplace[]): Promise<DocEditResult> =>
      ipcRenderer.invoke('docs:apply-edit-direct', { docPath, edits }),
  },
  folders: {
    create: (parentPath: string | null, name: string): Promise<FolderSummary> =>
      ipcRenderer.invoke('folders:create', parentPath, name),
    rename: (path: string, newName: string): Promise<FolderSummary> =>
      ipcRenderer.invoke('folders:rename', path, newName),
    move: (path: string, newParentPath: string | null): Promise<FolderSummary> =>
      ipcRenderer.invoke('folders:move', path, newParentPath),
    delete: (path: string): Promise<void> => ipcRenderer.invoke('folders:delete', path),
  },
  images: {
    save: (bytes: ArrayBuffer, filename: string): Promise<{ url: string }> =>
      ipcRenderer.invoke('images:save', bytes, filename),
  },
  conversations: {
    list: (): Promise<ConversationSummary[]> => ipcRenderer.invoke('conversations:list'),
    get: (id: string): Promise<ConversationRecord> => ipcRenderer.invoke('conversations:get', id),
    create: (docPath?: string): Promise<ConversationSummary> =>
      ipcRenderer.invoke('conversations:create', docPath),
    listForDoc: (docPath: string): Promise<ConversationSummary[]> =>
      ipcRenderer.invoke('conversations:list-for-doc', docPath),
    rename: (id: string, title: string): Promise<ConversationSummary> =>
      ipcRenderer.invoke('conversations:rename', id, title),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('conversations:delete', id),
    onUpdated: (cb: (summary: ConversationSummary) => void) =>
      on<ConversationSummary>('conversations:updated', cb),
  },
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
