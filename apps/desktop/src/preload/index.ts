import type {
  ActiveAssistantTurn,
  BlobGarbageCollectionResult,
  DoneEvent as ChatDoneEvent,
  ErrorEvent as ChatErrorEvent,
  ConnectionModelDiscoveryResult,
  ConnectionProfile,
  ConnectionTestResult,
  ConversationRecord,
  ConversationRuntimeStateSnapshot,
  ConversationSummary,
  ConversationWorkspaceRef,
  ImageBlockEvent,
  ModelInfo,
  PersistedMessage,
  PersistedRunEvent,
  ProviderConnectionSnapshot,
  ProviderId,
  RunPayload,
  RunSnapshot,
  RuntimeCompactConversationInput as RuntimeCompactConversationRequest,
  RuntimeCompactConversationResult,
  ConversationRuntimeHydration as RuntimeConversationHydration,
  RuntimeForkRunInput,
  RuntimeForkSessionInput,
  RuntimeNavigateSessionInput,
  RuntimeRetryLastInput as RuntimeRetryLastRequest,
  RuntimeRunControlInput,
  RuntimeRunInspection,
  RuntimeRunPayloadInput,
  RuntimeRunSummary,
  RuntimeSendInput as RuntimeSendRequest,
  RuntimeSessionAvailability,
  RuntimeSendResult as SendResult,
  SessionTree,
  Settings,
  ToolApprovalRequestPayload as ToolApprovalRequestEvent,
  ToolApprovalResolvedPayload as ToolApprovalResolvedEvent,
  ToolCallArgsDeltaEvent,
  ToolResultEvent as ToolCallResultEvent,
  ToolCallEvent as ToolCallStartEvent,
} from '@aila/agent'
import type {
  IntegrationDefinition as ExtensionIntegrationDefinition,
  SaveIntegrationRequest as ExtensionIntegrationSaveRequest,
  McpServerProbeResult as ExtensionMcpTestResult,
  ExtensionReport,
  TokenUsageStats,
} from '@aila/agent-node/app'
import { contextBridge, ipcRenderer } from 'electron'
import type { OrCatalog } from '../shared/openrouter'

export type {
  ActiveAssistantTurn,
  BlobGarbageCollectionResult,
  ChatAttachmentInput,
  ChatMessage,
  ConnectionCredentialStatus,
  ConnectionModel,
  ConnectionModelDiscoveryResult,
  ConnectionProfile,
  ConnectionTestErrorClass,
  ConnectionTestResult,
  ConversationActivity,
  ConversationActivityState,
  ConversationCompactArtifact,
  ConversationCompactFileArtifact,
  ConversationCompactToolActivity,
  ConversationCompactToolResultArtifact,
  ConversationContextCheckpoint,
  ConversationContextLedgerSection,
  ConversationContextState,
  ConversationContextTokenPreflight,
  ConversationContextTurnLedgerEntry,
  ConversationRecord,
  ConversationRuntimeHydration as RuntimeConversationHydration,
  ConversationRuntimePendingApproval,
  ConversationRuntimeReplayState,
  ConversationRuntimeReplayTurn,
  ConversationRuntimeStatePhase,
  ConversationRuntimeStateSnapshot,
  ConversationSummary,
  ConversationUsage,
  ConversationWorkspaceRef,
  DoneEvent as ChatDoneEvent,
  ErrorEvent as ChatErrorEvent,
  ImageBlockEvent,
  ModelInfo,
  ModelSelection,
  PersistedBlock,
  PersistedFileBlock,
  PersistedImageBlock,
  PersistedMessage,
  PersistedRunEvent,
  PersistedTextBlock,
  PersistedToolCallBlock,
  PersistedToolResultRef,
  PromptCacheMode,
  PromptCacheSettings,
  PromptCacheTtl,
  ProviderConnectionSnapshot,
  ProviderDefinition,
  ProviderId,
  RunEventType,
  RunPayload,
  RunSnapshot,
  RuntimeCompactConversationInput as RuntimeCompactConversationRequest,
  RuntimeCompactConversationResult,
  RuntimeCreateConversationInput as RuntimeCreateConversationRequest,
  RuntimeForkRunInput,
  RuntimeForkSessionInput,
  RuntimeNavigateSessionInput,
  RuntimeRetryLastInput as RuntimeRetryLastRequest,
  RuntimeRunControlInput,
  RuntimeRunInspection,
  RuntimeRunPayloadDescriptor,
  RuntimeRunPayloadInput,
  RuntimeRunSummary,
  RuntimeSendInput as RuntimeSendRequest,
  RuntimeSendResult as SendResult,
  RuntimeSessionAvailability,
  SessionTree,
  Settings,
  ToolApprovalRequestPayload as ToolApprovalRequestEvent,
  ToolApprovalResolvedPayload as ToolApprovalResolvedEvent,
  ToolCall as ToolCallPayload,
  ToolCallArgsDeltaEvent,
  ToolCallEvent as ToolCallStartEvent,
  ToolResultEvent as ToolCallResultEvent,
  UsageInfo,
  WebSearchSettings,
} from '@aila/agent'

// App-host types owned by the Node package (allowed for preload; the renderer
// still may not import @aila/agent-node).
export type {
  ExtensionIntegrationReport,
  ExtensionMcpServerReport,
  ExtensionReport,
  ExtensionReportError,
  ExtensionReportErrorKind,
  ExtensionSkillReport,
  IntegrationDefinition as ExtensionIntegrationDefinition,
  McpServerProbeResult as ExtensionMcpTestResult,
  PublicMcpOAuthStatus as ExtensionMcpOAuthReport,
  SaveIntegrationRequest as ExtensionIntegrationSaveRequest,
  TokenUsageDay,
  TokenUsageStats,
} from '@aila/agent-node/app'
export type { OrCatalog, OrFamily, OrModel } from '../shared/openrouter'

// --- Genuinely preload-local shapes (IPC wire contracts) ---

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

export interface ToolApprovalResponse {
  requestId: string
  approved: boolean
}

export interface SettingsState {
  settings: Settings
  configuredProviders: ProviderId[]
  connections: ProviderConnectionSnapshot[]
}

export interface SaveProviderConnectionRequest {
  profile: ConnectionProfile
  credential?: string
  clearCredential?: boolean
}

export interface ProviderConnectionEffectRequest {
  profile: ConnectionProfile
  credential?: string
  modelId?: string
}

export interface ProviderModelDiscoveryResponse extends SettingsState {
  result: ConnectionModelDiscoveryResult
}

export interface ProviderAccountImportResponse extends SettingsState {
  source: string
  discoveredModels: number
}

export interface RuntimeAppendMessageRequest {
  conversationId: string
  message: PersistedMessage
}

// MCP save/config inputs stay local: the desktop settings UI accepts a wider
// transport union ('streamable-http') than the loaded-config types expose.
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

/** Composed in main (extensions:reload); wider than the agent-node reload result. */
export interface ExtensionReloadResult {
  toolCount: number
  skillCount: number
  report: ExtensionReport
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
    appendPlaygroundMessage: (request: RuntimeAppendMessageRequest): Promise<string> =>
      ipcRenderer.invoke('runtime:messages:append', request),
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
    getSessionTree: (conversationId: string): Promise<SessionTree> =>
      ipcRenderer.invoke('runtime:sessions:tree', conversationId),
    getAvailability: (conversationId: string): Promise<RuntimeSessionAvailability> =>
      ipcRenderer.invoke('runtime:availability:get', conversationId),
    onAvailability: (cb: (availability: RuntimeSessionAvailability) => void) =>
      on<RuntimeSessionAvailability>('session:availability', cb),
    navigateSession: (request: RuntimeNavigateSessionInput): Promise<ConversationRecord> =>
      ipcRenderer.invoke('runtime:sessions:navigate', request),
    forkSession: (request: RuntimeForkSessionInput): Promise<ConversationSummary> =>
      ipcRenderer.invoke('runtime:sessions:fork', request),
    collectSessionGarbage: (conversationId: string): Promise<BlobGarbageCollectionResult> =>
      ipcRenderer.invoke('runtime:sessions:collect-garbage', conversationId),
    listRuns: (conversationId: string): Promise<RunSnapshot[]> =>
      ipcRenderer.invoke('runtime:runs:list', conversationId),
    listRunSummaries: (conversationId: string): Promise<RuntimeRunSummary[]> =>
      ipcRenderer.invoke('runtime:runs:list-summaries', conversationId),
    inspectRun: (request: RuntimeRunControlInput): Promise<RuntimeRunInspection> =>
      ipcRenderer.invoke('runtime:runs:inspect', request),
    getRunPayload: (request: RuntimeRunPayloadInput): Promise<RunPayload> =>
      ipcRenderer.invoke('runtime:runs:get-payload', request),
    stepRun: (request: RuntimeRunControlInput): Promise<SendResult> =>
      ipcRenderer.invoke('runtime:runs:step', request),
    continueRun: (request: RuntimeRunControlInput): Promise<SendResult> =>
      ipcRenderer.invoke('runtime:runs:continue', request),
    resumeRun: (request: RuntimeRunControlInput): Promise<SendResult> =>
      ipcRenderer.invoke('runtime:runs:resume', request),
    abortRun: (request: RuntimeRunControlInput): Promise<RunSnapshot> =>
      ipcRenderer.invoke('runtime:runs:abort', request),
    forkRun: (request: RuntimeForkRunInput): Promise<RunSnapshot> =>
      ipcRenderer.invoke('runtime:runs:fork', request),
    listRuntimeStates: (): Promise<ConversationRuntimeStateSnapshot[]> =>
      ipcRenderer.invoke('runtime:conversations:list-runtime-states'),
    getTokenUsageStats: (): Promise<TokenUsageStats> =>
      ipcRenderer.invoke('runtime:token-usage-stats'),
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
    onRunEvent: (cb: (event: PersistedRunEvent) => void) => on<PersistedRunEvent>('run:event', cb),
    conversations: {
      list: (): Promise<ConversationSummary[]> => ipcRenderer.invoke('runtime:conversations:list'),
      get: (id: string): Promise<ConversationRecord> =>
        ipcRenderer.invoke('runtime:conversations:get', id),
      create: (): Promise<ConversationSummary> =>
        ipcRenderer.invoke('runtime:conversations:create', {}),
      createForWorkspace: (workspace: ConversationWorkspaceRef): Promise<ConversationSummary> =>
        ipcRenderer.invoke('runtime:conversations:create', { workspace }),
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
  providers: {
    save: (request: SaveProviderConnectionRequest): Promise<SettingsState> =>
      ipcRenderer.invoke('providers:save', request),
    remove: (connectionId: ProviderId): Promise<SettingsState> =>
      ipcRenderer.invoke('providers:remove', connectionId),
    importAccount: (
      connectionId: ProviderId,
      providerType: string,
    ): Promise<ProviderAccountImportResponse> =>
      ipcRenderer.invoke('providers:import-account', connectionId, providerType),
    test: (request: ProviderConnectionEffectRequest): Promise<ConnectionTestResult> =>
      ipcRenderer.invoke('providers:test', request),
    discover: (request: ProviderConnectionEffectRequest): Promise<ProviderModelDiscoveryResponse> =>
      ipcRenderer.invoke('providers:discover', request),
  },
  workspaces: {
    pickDirectory: (): Promise<ConversationWorkspaceRef | null> =>
      ipcRenderer.invoke('workspaces:pick-directory'),
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
  images: {
    save: (bytes: ArrayBuffer, filename: string): Promise<{ url: string }> =>
      ipcRenderer.invoke('images:save', bytes, filename),
  },
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
