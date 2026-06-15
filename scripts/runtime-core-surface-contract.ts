import {
  type AgentContextAutoCompactReason,
  type AgentContextBudgetPlan,
  type AgentContextBudgetPressure,
  type AgentContextCompactionPlan,
  type AgentContextPlan,
  type AgentContextPlanSection,
  type AgentContextRecommendedCheckpoint,
  type AgentContextSectionCachePolicy,
  type AgentContextSectionMetadata,
  type AgentContextSectionSource,
  type AgentEvent,
  AgentRuntime,
  type AgentRuntimeApi,
  type AgentRuntimeConversationApi,
  type AgentRuntimeEvent,
  type AgentRuntimeExtensionApi,
  type AgentRuntimeHost,
  type AgentRuntimeStore,
  type AgentRuntimeTurnApi,
  AILA_RUNTIME_EVENT_SCHEMA_VERSION,
  AILA_RUNTIME_EVENT_TYPES,
  AILA_RUNTIME_SDK_VERSION,
  type ChatMessage,
  ContextBudgetManager,
  type ContextBudgetManagerInput,
  type ContextBudgetSnapshot,
  type ConversationContextCheckpoint,
  type ConversationContextState,
  type ConversationRecord,
  type ConversationRuntimeReplayState,
  type ConversationSummary,
  type ConversationUsage,
  createInMemoryRuntimeStore,
  createRuntimeEvent,
  createSkillToolPack,
  createToolPolicy,
  findModel,
  type ImageGenerateRequest,
  type ImageResult,
  isRuntimeEventType,
  MODEL_CATALOG,
  type ModelSelection,
  type PersistedMessage,
  type PersistedToolResultRef,
  parseSkillDocument,
  type RuntimeModelInfoResolver,
  type RuntimeStableInstructionsInput,
  type RuntimeStreamChat,
  requestToolApprovalWithActivity,
  type Settings,
  type ToolApprovalMode,
  type ToolApprovalRequest,
  type ToolApprovalRequestPayload,
  ToolApprovalStore,
  type ToolContext,
  type ToolPack,
  type ToolRegistry,
  type ToolShellRequest,
  type ToolWebSearchRequest,
} from '@aila/agent'

export type RuntimeCorePublicSurfaceContract = {
  agentEvent: AgentEvent
  agentContextPlan: AgentContextPlan
  agentContextPlanSection: AgentContextPlanSection
  agentContextAutoCompactReason: AgentContextAutoCompactReason
  agentContextBudgetPlan: AgentContextBudgetPlan
  agentContextBudgetPressure: AgentContextBudgetPressure
  agentContextCompactionPlan: AgentContextCompactionPlan
  agentContextRecommendedCheckpoint: AgentContextRecommendedCheckpoint
  agentContextSectionCachePolicy: AgentContextSectionCachePolicy
  agentContextSectionMetadata: AgentContextSectionMetadata
  agentContextSectionSource: AgentContextSectionSource
  api: AgentRuntimeApi
  chatMessage: ChatMessage
  conversationApi: AgentRuntimeConversationApi
  conversationRecord: ConversationRecord
  conversationRuntimeState: ConversationRuntimeReplayState
  conversationSummary: ConversationSummary
  conversationUsage: ConversationUsage
  conversationContextCheckpoint: ConversationContextCheckpoint
  conversationContextState: ConversationContextState
  contextBudgetManagerInput: ContextBudgetManagerInput
  contextBudgetSnapshot: ContextBudgetSnapshot
  event: AgentRuntimeEvent
  extensionApi: AgentRuntimeExtensionApi
  host: AgentRuntimeHost
  imageRequest: ImageGenerateRequest
  imageResult: ImageResult
  modelInfoResolver: RuntimeModelInfoResolver
  modelSelection: ModelSelection
  persistedMessage: PersistedMessage
  persistedToolResultRef: PersistedToolResultRef
  runtime: AgentRuntime
  stableInstructionsInput: RuntimeStableInstructionsInput
  settings: Settings
  shellRequest: ToolShellRequest
  store: AgentRuntimeStore
  streamChat: RuntimeStreamChat
  toolApprovalPayload: ToolApprovalRequestPayload
  toolApprovalMode: ToolApprovalMode
  toolApprovalRequest: ToolApprovalRequest
  toolContext: ToolContext
  toolPack: ToolPack
  toolRegistry: ToolRegistry
  turnApi: AgentRuntimeTurnApi
  webSearchRequest: ToolWebSearchRequest
}

export const runtimeCorePublicValueSurfaceContract = {
  eventSchemaVersion: AILA_RUNTIME_EVENT_SCHEMA_VERSION,
  eventTypes: AILA_RUNTIME_EVENT_TYPES,
  findModel,
  isRuntimeEventType,
  modelCatalog: MODEL_CATALOG,
  contextBudgetManager: ContextBudgetManager,
  runtime: AgentRuntime,
  runtimeEvent: createRuntimeEvent,
  sdkVersion: AILA_RUNTIME_SDK_VERSION,
  toolApprovalStore: ToolApprovalStore,
  createToolPolicy,
  createInMemoryRuntimeStore,
  createSkillToolPack,
  parseSkillDocument,
  requestToolApprovalWithActivity,
} satisfies Record<string, unknown>
