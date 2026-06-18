import type {
  AilaExecutionMode,
  ConversationWorkspaceRef,
  PlanArtifact,
  ProviderId,
  RuntimeApprovePlanInput,
  RuntimeCancelPlanInput,
  RuntimeRevisePlanInput,
  RuntimeSavePlanMarkdownInput,
} from '@aila/agent'
import { contextBridge, ipcRenderer } from 'electron'
import type { OrCatalog } from '../shared/openrouter'

export type { OrCatalog, OrFamily, OrModel } from '../shared/openrouter'
export type {
  AilaExecutionMode,
  ConversationWorkspaceRef,
  PlanArtifact,
  ProviderId,
  RuntimeApprovePlanInput,
  RuntimeCancelPlanInput,
  RuntimeRevisePlanInput,
  RuntimeSavePlanMarkdownInput,
}

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
  | 'context:compacting'
  | 'context:compacted'
  | 'tool.requested'
  | 'tool.input.delta'
  | 'tool.input.completed'
  | 'tool.execution.started'
  | 'tool.execution.completed'
  | 'tool.execution.failed'
  | 'tool.result.returned'
  | 'tool.approval.requested'
  | 'tool.approval.resolved'
  | 'plan.started'
  | 'plan.exploring'
  | 'plan.question.requested'
  | 'plan.question.answered'
  | 'plan.updated'
  | 'plan.ready'
  | 'plan.approved'
  | 'plan.rejected'
  | 'plan.cancelled'
  | 'plan.implementation.started'
  | 'plan.task.started'
  | 'plan.task.completed'
  | 'plan.task.blocked'
  | 'plan.drift.detected'
  | 'plan.completed'

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
  resultRef?: PersistedToolResultRef
}

export interface PersistedToolResultRef {
  kind: 'file'
  path: string
  relativePath: string
  sizeChars: number
  preview: string
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

export type ExtensionReportErrorKind = 'toolPacks' | 'skills' | 'mcp'

export interface ExtensionReportError {
  kind: ExtensionReportErrorKind
  message: string
}

export interface ExtensionSkillReport {
  name: string
  description: string
  directory: string
  skillPath: string
}

export interface ExtensionToolPackReport {
  id: string
  name: string
  directory: string
  manifestPath: string
  tools: string[]
}

export interface ExtensionMcpServerReport {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  source: 'project' | 'claude-json' | 'claude-settings' | 'user'
  sourcePath: string
  enabled: boolean
  status: 'connected' | 'connecting' | 'failed' | 'disabled' | 'not_connected'
  tools: string[]
  command?: string
  args?: string[]
  url?: string
  integrationId?: string
  auth?: ExtensionMcpOAuthReport
  error?: string
}

export interface ExtensionMcpOAuthReport {
  type: 'oauth'
  configured: boolean
  authorized: boolean
  hasRefreshToken: boolean
  scopes: string[]
  clientIdSuffix?: string
  redirectUri?: string
  lastAuthorizedAt?: number
  updatedAt?: number
}

export interface ExtensionIntegrationReport {
  id: string
  label: string
  provider: string
  mcpServerName: string
  endpoint: string
  requiredScopes: string[]
  configured: boolean
  docsUrl: string
  server?: ExtensionMcpServerReport
}

export interface ExtensionReport {
  ok: boolean
  dataDir: string
  toolPacksDir: string
  skillsDir: string
  mcpConfigPath: string
  projectMcpConfigPath: string
  toolPacks: ExtensionToolPackReport[]
  skills: ExtensionSkillReport[]
  integrations: ExtensionIntegrationReport[]
  mcpServers: ExtensionMcpServerReport[]
  errors: ExtensionReportError[]
}

export interface ExtensionReloadResult {
  toolCount: number
  skillCount: number
  report: ExtensionReport
}

export type ExtensionMcpTransport = 'stdio' | 'http' | 'sse' | 'streamable-http'
export type ExtensionMcpApprovalPolicy = 'ask' | 'auto' | 'deny'

export interface ExtensionMcpToolPolicyInput {
  approval?: ExtensionMcpApprovalPolicy
}

export interface ExtensionMcpServerConfigInput {
  type?: ExtensionMcpTransport
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  envHttpHeaders?: Record<string, string>
  bearerTokenEnvVar?: string
  enabled?: boolean
  integrationId?: string
  auth?: ExtensionMcpOAuthConfigInput
  approval?: ExtensionMcpApprovalPolicy
  tools?: Record<string, ExtensionMcpToolPolicyInput>
  startupTimeoutMs?: number
  toolTimeoutMs?: number
}

export interface ExtensionMcpOAuthConfigInput {
  type: 'oauth'
  clientId?: string
  clientSecret?: string
  scopes?: string[]
  redirectUri?: string
  clientName?: string
  authorizationParams?: Record<string, string>
  tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'none'
}

export interface ExtensionMcpSaveRequest {
  name: string
  server: ExtensionMcpServerConfigInput
}

export interface ExtensionMcpTestResult {
  ok: boolean
  tools: string[]
  error?: string
}

export interface ExtensionIntegrationDefinition {
  id: string
  label: string
  provider: string
  mcpServerName: string
  endpoint: string
  transport: 'http'
  requiredScopes: string[]
  tools: Array<{ name: string; approval: ExtensionMcpApprovalPolicy; risk: 'read' | 'write' }>
  docsUrl: string
}

export interface ExtensionIntegrationSaveRequest {
  id: 'gmail'
  oauth?: {
    clientId?: string
    clientSecret?: string
    redirectUri?: string
    scopes?: string[]
  }
}

export interface ConversationUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  updatedAt: number
  turnCount?: number
  cumulativePromptTokens?: number
  cumulativeCompletionTokens?: number
  cumulativeTotalTokens?: number
}

export interface ConversationCompactFileArtifact {
  path: string
  mentions: number
}

export interface ConversationCompactToolActivity {
  name: string
  count: number
}

export interface ConversationCompactToolResultArtifact {
  toolCallId: string
  toolName: string
  sizeChars: number
  preview: string
  path?: string
  relativePath?: string
}

export interface ConversationCompactArtifact {
  schemaVersion: 1
  summary: string
  userRequests: string[]
  decisions: string[]
  files: ConversationCompactFileArtifact[]
  toolActivity: ConversationCompactToolActivity[]
  toolResults: ConversationCompactToolResultArtifact[]
  nextSteps: string[]
}

export interface ConversationContextCheckpoint {
  schemaVersion: 1
  id: string
  createdAt: number
  boundaryMessageId: string
  sourceMessageIds: string[]
  omittedRoundCount: number
  summary: string
  charCost: number
  artifact?: ConversationCompactArtifact
}

export interface ConversationContextLedgerSection {
  kind: string
  messageCount: number
  charCost: number
  estimatedTokens: number
}

export interface ConversationContextTokenPreflight {
  inputTokens: number
  method: string
  providerId?: ProviderId | 'unknown'
  model?: string
  countedAt: number
}

export interface ConversationContextTurnLedgerEntry {
  schemaVersion: 1
  messageId: string
  createdAt: number
  providerId: ProviderId
  modelId: string
  estimatedInputTokens: number
  inputBudgetTokens: number
  remainingInputTokens: number
  sectionCount: number
  sections: ConversationContextLedgerSection[]
  preflight?: ConversationContextTokenPreflight
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  compaction: {
    activeCheckpointId: string | null
    recommendedCheckpointId: string | null
    omittedRoundCount: number
    shouldAutoCompact: boolean
  }
}

export interface ConversationContextState {
  checkpoint?: ConversationContextCheckpoint
  turns?: ConversationContextTurnLedgerEntry[]
}

export type ConversationActivityState =
  | 'planning'
  | 'plan_ready'
  | 'implementing_plan'
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
  | 'planning'
  | 'plan_ready'
  | 'implementing_plan'
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

export interface ConversationRuntimeReplayPlan {
  planId: string
  status?: string
  title?: string
  updatedAt: number
  taskId?: string
  questionId?: string
  driftId?: string
}

export interface ConversationRuntimeReplayState {
  phase: ConversationRuntimeStatePhase
  active: boolean
  turn?: ConversationRuntimeReplayTurn
  plan?: ConversationRuntimeReplayPlan
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
  context?: ConversationContextState
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
  mode?: AilaExecutionMode
  planId?: string
  attachments?: ChatAttachmentInput[]
}

export interface RuntimeRetryLastRequest {
  conversationId: string
  selection: ModelSelection
  mode?: AilaExecutionMode
  planId?: string
}

export interface RuntimeCompactConversationRequest {
  conversationId: string
  selection: ModelSelection
}

export interface RuntimeCompactConversationResult {
  compacted: boolean
  summary: ConversationSummary
  checkpoint?: ConversationContextCheckpoint
  reason?: 'nothing_to_compact'
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
  plans: PlanArtifact[]
}

export interface TerminalCreateRequest {
  cwd?: string | null
  cols?: number
  rows?: number
}

export interface TerminalSessionCreated {
  id: string
  cwd: string
  shell: string
  pid: number
}

export interface TerminalDataEvent {
  id: string
  data: string
}

export interface TerminalExitEvent {
  id: string
  exitCode: number
  signal?: number
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
    compactConversation: (
      request: RuntimeCompactConversationRequest,
    ): Promise<RuntimeCompactConversationResult> =>
      ipcRenderer.invoke('runtime:compact-conversation', request),
    abort: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke('runtime:abort', conversationId),
    listActiveTurns: (): Promise<ActiveAssistantTurn[]> =>
      ipcRenderer.invoke('runtime:list-active-turns'),
    hydrateConversation: (conversationId: string): Promise<RuntimeConversationHydration> =>
      ipcRenderer.invoke('runtime:hydrate-conversation', conversationId),
    listRuntimeStates: (docId: string | null = null): Promise<ConversationRuntimeStateSnapshot[]> =>
      ipcRenderer.invoke('runtime:conversations:list-runtime-states', docId),
    listPlans: (conversationId: string): Promise<PlanArtifact[]> =>
      ipcRenderer.invoke('runtime:plans:list', conversationId),
    getPlan: (conversationId: string, planId: string): Promise<PlanArtifact> =>
      ipcRenderer.invoke('runtime:plans:get', conversationId, planId),
    savePlanMarkdown: (request: RuntimeSavePlanMarkdownInput): Promise<PlanArtifact> =>
      ipcRenderer.invoke('runtime:plans:save-markdown', request),
    revisePlan: (request: RuntimeRevisePlanInput): Promise<SendResult> =>
      ipcRenderer.invoke('runtime:plans:revise', request),
    approvePlan: (request: RuntimeApprovePlanInput): Promise<SendResult> =>
      ipcRenderer.invoke('runtime:plans:approve', request),
    cancelPlan: (request: RuntimeCancelPlanInput): Promise<PlanArtifact> =>
      ipcRenderer.invoke('runtime:plans:cancel', request),
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
  terminal: {
    create: (request: TerminalCreateRequest): Promise<TerminalSessionCreated> =>
      ipcRenderer.invoke('terminal:create', request),
    write: (id: string, data: string): void => {
      ipcRenderer.send('terminal:write', { id, data })
    },
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
    close: (id: string): Promise<void> => ipcRenderer.invoke('terminal:close', id),
    onData: (cb: (event: TerminalDataEvent) => void) => on<TerminalDataEvent>('terminal:data', cb),
    onExit: (cb: (event: TerminalExitEvent) => void) => on<TerminalExitEvent>('terminal:exit', cb),
  },
  openrouter: {
    listModels: (): Promise<OrCatalog> => ipcRenderer.invoke('openrouter:list-models'),
  },
  extensions: {
    report: (): Promise<ExtensionReport> => ipcRenderer.invoke('extensions:report'),
    reload: (): Promise<ExtensionReloadResult> => ipcRenderer.invoke('extensions:reload'),
    listIntegrations: (): Promise<ExtensionIntegrationDefinition[]> =>
      ipcRenderer.invoke('extensions:integrations-list'),
    saveIntegration: (request: ExtensionIntegrationSaveRequest): Promise<ExtensionReloadResult> =>
      ipcRenderer.invoke('extensions:integration-save', request),
    installSkill: (): Promise<ExtensionReloadResult | null> =>
      ipcRenderer.invoke('extensions:install-skill'),
    saveMcpServer: (request: ExtensionMcpSaveRequest): Promise<ExtensionReloadResult> =>
      ipcRenderer.invoke('extensions:mcp-save', request),
    deleteMcpServer: (name: string): Promise<ExtensionReloadResult> =>
      ipcRenderer.invoke('extensions:mcp-delete', name),
    setMcpServerEnabled: (name: string, enabled: boolean): Promise<ExtensionReloadResult> =>
      ipcRenderer.invoke('extensions:mcp-set-enabled', name, enabled),
    testMcpServer: (name: string): Promise<ExtensionMcpTestResult> =>
      ipcRenderer.invoke('extensions:mcp-test', name),
    testMcpServerDraft: (request: ExtensionMcpSaveRequest): Promise<ExtensionMcpTestResult> =>
      ipcRenderer.invoke('extensions:mcp-test-draft', request),
    startMcpOAuth: (name: string): Promise<ExtensionReloadResult> =>
      ipcRenderer.invoke('extensions:mcp-oauth-start', name),
    clearMcpOAuth: (name: string): Promise<ExtensionReloadResult> =>
      ipcRenderer.invoke('extensions:mcp-oauth-clear', name),
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
