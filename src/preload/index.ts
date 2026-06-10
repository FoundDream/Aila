import type { ConversationWorkspaceRef, ProviderId } from '@aila/agent'
import { contextBridge, ipcRenderer } from 'electron'
import type { OrCatalog } from '../shared/openrouter'

export type { OrCatalog, OrFamily, OrModel } from '../shared/openrouter'
export type { ConversationWorkspaceRef, ProviderId }

export const AILA_CONVERSATION_META_SCHEMA_VERSION = 1
export const AILA_PERSISTED_MESSAGE_SCHEMA_VERSION = 1

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
  name?: string
  result: string
  isError: boolean
}

export interface ToolApprovalRequestEvent {
  requestId: string
  name: string
  args: Record<string, unknown>
  conversationId?: string
  messageId?: string
  toolCallId?: string
  requestedAt: number
  expiresAt: number
  metadata: {
    name: string
    readOnly: boolean
    destructive: boolean
    requiresApproval: boolean
    access: string[]
    scope: string[]
    maxResultBytes?: number
  }
}

export interface ToolApprovalResponse {
  requestId: string
  approved: boolean
}

export interface ToolApprovalResolvedEvent {
  requestId: string
  approved: boolean
  reason: 'user' | 'timeout' | 'shutdown' | 'cancelled'
}

export type AgentEventType =
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'turn.interrupted'
  | 'tool.requested'
  | 'tool.input.delta'
  | 'tool.input.completed'
  | 'tool.execution.started'
  | 'tool.execution.completed'
  | 'tool.execution.failed'
  | 'tool.result.returned'
  | 'tool.approval.requested'
  | 'tool.approval.resolved'

export interface PersistedAgentEvent {
  schemaVersion: number
  timestamp: number
  conversationId: string
  messageId: string
  type: AgentEventType
  data?: Record<string, unknown>
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

/** A text file (or doc reference) the user attached to their message. */
export interface PersistedFileBlock {
  type: 'file'
  name: string
  content: string
}

export type PersistedBlock =
  | PersistedTextBlock
  | PersistedToolCallBlock
  | PersistedImageBlock
  | PersistedFileBlock

/** Attachment payload sent with a user message. */
export interface ChatAttachmentInput {
  kind: 'image' | 'text'
  name: string
  mime: string
  /** kind 'image': base64-encoded bytes (no data: prefix). kind 'text': raw content. */
  data: string
}

export interface ImageBlockEvent extends ChatStreamEventBase {
  block: PersistedImageBlock
}

export interface ModelSelection {
  providerId: ProviderId
  modelId: string
}

export interface PersistedMessage {
  schemaVersion: typeof AILA_PERSISTED_MESSAGE_SCHEMA_VERSION
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
  approvalMode?: 'safe' | 'yolo'
  webSearch?: WebSearchSettings
  recentOpenRouterModels?: string[]
}

export interface WebSearchSettings {
  providers?: {
    tavily?: { apiKey?: string }
    searxng?: { baseUrl?: string }
    brave?: { apiKey?: string }
    google?: { apiKey?: string; cx?: string }
    duckduckgo?: { enabled?: boolean }
    wikimedia?: { enabled?: boolean }
    hackernews?: { enabled?: boolean }
    arxiv?: { enabled?: boolean }
    stackexchange?: { enabled?: boolean; site?: string }
  }
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

export type ConversationActivityState =
  | 'running'
  | 'approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ConversationActivity {
  state: ConversationActivityState
  title: string
  updatedAt: number
  eventType: AgentEventType
  messageId: string
  detail?: string
  toolName?: string
}

export type ConversationRuntimeStatePhase =
  | 'idle'
  | 'running'
  | 'approval'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ConversationRuntimePendingApproval {
  requestedAt: number
  requestId?: string
  toolCallId?: string
  toolName?: string
}

export interface ConversationRuntimeReplayTurn {
  conversationId: string
  assistantMessageId: string
  updatedAt: number
  eventType: AgentEventType
  startedAt?: number
  selection?: ModelSelection
  pendingApproval?: ConversationRuntimePendingApproval
}

export interface ConversationRuntimeReplayState {
  phase: ConversationRuntimeStatePhase
  active: boolean
  turn?: ConversationRuntimeReplayTurn
}

export interface ConversationRuntimeStateSnapshot {
  conversationId: string
  state: ConversationRuntimeReplayState
}

export interface ConversationSummary {
  schemaVersion: typeof AILA_CONVERSATION_META_SCHEMA_VERSION
  id: string
  title: string
  createdAt: number
  updatedAt: number
  usage?: ConversationUsage
  activity?: ConversationActivity
  // Set when Desktop owns this conversation as the AI sidebar of a specific
  // doc. Runtime treats it as ordinary conversation metadata.
  docId?: string | null
  // Optional chat session workspace affinity used by Desktop grouping.
  workspace?: ConversationWorkspaceRef | null
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

export interface RuntimeSendRequest {
  conversationId: string
  userText: string
  selection: ModelSelection
  attachments?: ChatAttachmentInput[]
}

export interface RuntimeRetryLastRequest {
  conversationId: string
  selection: ModelSelection
}

export interface RuntimeCreateConversationRequest {
  docId?: string | null
  workspace?: ConversationWorkspaceRef | null
}

export interface ActiveAssistantTurn {
  conversationId: string
  assistantMessageId: string
  selection: ModelSelection
}

export interface ModelInfo {
  model: string
  contextLength: number | null
}

export interface ConversationRecord {
  meta: ConversationSummary
  messages: PersistedMessage[]
}

export interface RuntimeConversationHydration {
  record: ConversationRecord
  events: PersistedAgentEvent[]
  runtimeState: ConversationRuntimeReplayState
  activeTurn: ActiveAssistantTurn | null
}

function on<T>(channel: string, callback: (data: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: T): void => callback(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  runtime: {
    send: (request: RuntimeSendRequest): Promise<SendResult> =>
      ipcRenderer.invoke('runtime:send', request),
    retryLast: (request: RuntimeRetryLastRequest): Promise<SendResult> =>
      ipcRenderer.invoke('runtime:retry-last', request),
    abort: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke('runtime:abort', conversationId),
    listActiveTurns: (): Promise<ActiveAssistantTurn[]> =>
      ipcRenderer.invoke('runtime:list-active-turns'),
    hydrateConversation: (conversationId: string): Promise<RuntimeConversationHydration> =>
      ipcRenderer.invoke('runtime:hydrate-conversation', conversationId),
    listRuntimeStates: (docId: string | null = null): Promise<ConversationRuntimeStateSnapshot[]> =>
      ipcRenderer.invoke('runtime:conversations:list-runtime-states', docId),
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
    onAgentEvent: (cb: (event: PersistedAgentEvent) => void) =>
      on<PersistedAgentEvent>('agent:event', cb),
    conversations: {
      list: (): Promise<ConversationSummary[]> =>
        ipcRenderer.invoke('runtime:conversations:list', null),
      get: (id: string): Promise<ConversationRecord> =>
        ipcRenderer.invoke('runtime:conversations:get', id),
      create: (docPath?: string): Promise<ConversationSummary> =>
        ipcRenderer.invoke('runtime:conversations:create', { docId: docPath ?? null }),
      createForWorkspace: (workspace: ConversationWorkspaceRef): Promise<ConversationSummary> =>
        ipcRenderer.invoke('runtime:conversations:create', { workspace }),
      listForDoc: (docPath: string): Promise<ConversationSummary[]> =>
        ipcRenderer.invoke('runtime:conversations:list', docPath),
      rename: (id: string, title: string): Promise<ConversationSummary> =>
        ipcRenderer.invoke('runtime:conversations:rename', id, title),
      delete: (id: string): Promise<void> => ipcRenderer.invoke('runtime:conversations:delete', id),
      onUpdated: (cb: (summary: ConversationSummary) => void) =>
        on<ConversationSummary>('conversations:updated', cb),
    },
  },
  getModelInfo: (providerId: ProviderId, modelId: string): Promise<ModelInfo> =>
    ipcRenderer.invoke('chat:get-model-info', providerId, modelId),
  settings: {
    get: (): Promise<SettingsState> => ipcRenderer.invoke('settings:get'),
    set: (settings: Settings): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:set', settings),
  },
  workspaces: {
    pickDirectory: (): Promise<ConversationWorkspaceRef | null> =>
      ipcRenderer.invoke('workspaces:pick-directory'),
  },
  openrouter: {
    listModels: (): Promise<OrCatalog> => ipcRenderer.invoke('openrouter:list-models'),
  },
  tools: {
    listPendingApprovals: (): Promise<ToolApprovalRequestEvent[]> =>
      ipcRenderer.invoke('tools:list-pending-approvals'),
    onApprovalRequest: (cb: (event: ToolApprovalRequestEvent) => void) =>
      on<ToolApprovalRequestEvent>('tools:approval-request', cb),
    onApprovalResolved: (cb: (event: ToolApprovalResolvedEvent) => void) =>
      on<ToolApprovalResolvedEvent>('tools:approval-resolved', cb),
    sendApprovalResponse: (response: ToolApprovalResponse): void => {
      ipcRenderer.send('tools:approval-response', response)
    },
  },
  docs: {
    list: (): Promise<DocsListResult> => ipcRenderer.invoke('docs:list'),
    get: (docPath: string): Promise<DocRecord> => ipcRenderer.invoke('docs:get', docPath),
    create: (folderPath?: string | null): Promise<DocRecord> =>
      ipcRenderer.invoke('docs:create', folderPath ?? null),
    update: (docPath: string, patch: DocPatch): Promise<DocRecord> =>
      ipcRenderer.invoke('docs:update', docPath, patch),
    delete: (docPath: string): Promise<void> => ipcRenderer.invoke('docs:delete', docPath),
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
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
