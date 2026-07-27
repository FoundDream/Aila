import {
  Agent,
  type AgentContextAutoCompactReason,
  type AgentContextBudgetPlan,
  type AgentContextBudgetPressure,
  type AgentContextCompactionPlan,
  type AgentContextMicrocompactPlan,
  type AgentContextPlan,
  type AgentContextPlanSection,
  type AgentContextRecommendedCheckpoint,
  type AgentContextSectionCachePolicy,
  type AgentContextSectionMetadata,
  type AgentContextSectionSource,
  type AgentContextTokenLedger,
  type AgentContextTokenLedgerEntry,
  type AgentContextTokenPreflight,
  type AgentEvent,
  AILA_RUNTIME_SDK_VERSION,
  AILA_WORKBENCH_EVENT_SCHEMA_VERSION,
  AILA_WORKBENCH_EVENT_TYPES,
  type ChatMessage,
  ContextBudgetManager,
  type ContextBudgetManagerInput,
  type ContextBudgetSnapshot,
  type ContextTokenEstimate,
  type ContextTokenEstimateMethod,
  ContextTokenEstimator,
  type ContextTokenEstimatorSnapshot,
  type ConversationCompactArtifact,
  type ConversationCompactFileArtifact,
  type ConversationCompactToolActivity,
  type ConversationCompactToolResultArtifact,
  type ConversationContextCheckpoint,
  type ConversationContextLedgerSection,
  type ConversationContextState,
  type ConversationContextTokenPreflight,
  type ConversationContextTurnLedgerEntry,
  type ConversationRecord,
  type ConversationRuntimeReplayState,
  type ConversationSummary,
  type ConversationUsage,
  createInMemoryRuntimeStore,
  createSkillToolPack,
  createToolPolicy,
  createWorkbenchEvent,
  type DurableRunExecutor,
  findModel,
  type ImageGenerateRequest,
  type ImageResult,
  isWorkbenchEventType,
  MODEL_CATALOG,
  type ModelSelection,
  type PersistedMessage,
  type PersistedToolResultRef,
  parseSkillDocument,
  type RunEvent,
  type RunIdentity,
  type RuntimeCompactConversationInput,
  type RuntimeCompactConversationResult,
  type RuntimeContextCompactArtifactInput,
  type RuntimeContextCompactArtifactResult,
  type RuntimeContextTokenCountInput,
  type RuntimeContextTokenCountResult,
  type RuntimeModelInfoResolver,
  type RuntimeStableInstructionsInput,
  requestToolApprovalWithActivity,
  SessionRuntime,
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
  type Turn,
  type Workbench,
  type WorkbenchEvent,
  type WorkbenchHost,
  WorkbenchRuntime,
  type WorkbenchStore,
} from '@aila/agent'

export type RuntimeCorePublicSurfaceContract = {
  agent: Agent
  agentEvent: AgentEvent
  turn: Turn
  runEvent: RunEvent
  agentRunIdentity: RunIdentity
  agentContextPlan: AgentContextPlan
  agentContextPlanSection: AgentContextPlanSection
  agentContextAutoCompactReason: AgentContextAutoCompactReason
  agentContextBudgetPlan: AgentContextBudgetPlan
  agentContextBudgetPressure: AgentContextBudgetPressure
  agentContextCompactionPlan: AgentContextCompactionPlan
  agentContextMicrocompactPlan: AgentContextMicrocompactPlan
  agentContextRecommendedCheckpoint: AgentContextRecommendedCheckpoint
  agentContextSectionCachePolicy: AgentContextSectionCachePolicy
  agentContextSectionMetadata: AgentContextSectionMetadata
  agentContextSectionSource: AgentContextSectionSource
  agentContextTokenLedger: AgentContextTokenLedger
  agentContextTokenLedgerEntry: AgentContextTokenLedgerEntry
  agentContextTokenPreflight: AgentContextTokenPreflight
  api: Workbench
  chatMessage: ChatMessage
  conversationRecord: ConversationRecord
  conversationRuntimeState: ConversationRuntimeReplayState
  conversationSummary: ConversationSummary
  conversationUsage: ConversationUsage
  conversationContextCheckpoint: ConversationContextCheckpoint
  conversationContextLedgerSection: ConversationContextLedgerSection
  conversationContextState: ConversationContextState
  conversationContextTokenPreflight: ConversationContextTokenPreflight
  conversationContextTurnLedgerEntry: ConversationContextTurnLedgerEntry
  contextBudgetManagerInput: ContextBudgetManagerInput
  contextBudgetSnapshot: ContextBudgetSnapshot
  contextTokenEstimate: ContextTokenEstimate
  contextTokenEstimateMethod: ContextTokenEstimateMethod
  contextTokenEstimatorSnapshot: ContextTokenEstimatorSnapshot
  event: WorkbenchEvent
  host: WorkbenchHost
  imageRequest: ImageGenerateRequest
  imageResult: ImageResult
  modelInfoResolver: RuntimeModelInfoResolver
  modelSelection: ModelSelection
  conversationCompactArtifact: ConversationCompactArtifact
  conversationCompactFileArtifact: ConversationCompactFileArtifact
  conversationCompactToolActivity: ConversationCompactToolActivity
  conversationCompactToolResultArtifact: ConversationCompactToolResultArtifact
  persistedMessage: PersistedMessage
  persistedToolResultRef: PersistedToolResultRef
  runtime: WorkbenchRuntime
  sessionRuntime: SessionRuntime
  runtimeCompactConversationInput: RuntimeCompactConversationInput
  runtimeCompactConversationResult: RuntimeCompactConversationResult
  runtimeContextCompactArtifactInput: RuntimeContextCompactArtifactInput
  runtimeContextCompactArtifactResult: RuntimeContextCompactArtifactResult
  runtimeContextTokenCountInput: RuntimeContextTokenCountInput
  runtimeContextTokenCountResult: RuntimeContextTokenCountResult
  stableInstructionsInput: RuntimeStableInstructionsInput
  settings: Settings
  shellRequest: ToolShellRequest
  store: WorkbenchStore
  runAgent: DurableRunExecutor
  toolApprovalPayload: ToolApprovalRequestPayload
  toolApprovalMode: ToolApprovalMode
  toolApprovalRequest: ToolApprovalRequest
  toolContext: ToolContext
  toolPack: ToolPack
  toolRegistry: ToolRegistry
  webSearchRequest: ToolWebSearchRequest
}

export const runtimeCorePublicValueSurfaceContract = {
  eventSchemaVersion: AILA_WORKBENCH_EVENT_SCHEMA_VERSION,
  eventTypes: AILA_WORKBENCH_EVENT_TYPES,
  findModel,
  isWorkbenchEventType,
  modelCatalog: MODEL_CATALOG,
  contextBudgetManager: ContextBudgetManager,
  contextTokenEstimator: ContextTokenEstimator,
  runtime: WorkbenchRuntime,
  sessionRuntime: SessionRuntime,
  runtimeEvent: createWorkbenchEvent,
  sdkVersion: AILA_RUNTIME_SDK_VERSION,
  toolApprovalStore: ToolApprovalStore,
  createToolPolicy,
  createInMemoryRuntimeStore,
  createSkillToolPack,
  parseSkillDocument,
  requestToolApprovalWithActivity,
  agent: Agent,
} satisfies Record<string, unknown>
