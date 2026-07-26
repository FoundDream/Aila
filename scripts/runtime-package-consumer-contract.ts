import * as agent from '@aila/agent'
import * as agentHost from '@aila/agent/host'
import * as agentNode from '@aila/agent-node'

// @ts-expect-error runtime internals are not package exports.
export type AgentInternalPackageExportMustNotResolve = typeof import('@aila/agent/internal')
// @ts-expect-error raw persisted conversation helpers are not package API.
export const packageCreateConversationMustNotExist = agent.createConversation
// @ts-expect-error Desktop docs APIs are not agent package API.
export const packageCreateDocMustNotExist = agent.createDoc
// @ts-expect-error Desktop host adapters stay in the app, not @aila/agent.
export const packageConfigureDataDirMustNotExist = agent.configureDataDir

export type AgentPackageConsumerContract = {
  activityEvent: agent.AgentEvent
  api: agent.AgentRuntimeApi
  budgetPlan: agent.AgentContextBudgetPlan
  compactArtifact: agent.ConversationCompactArtifact
  conversation: agent.ConversationRecord
  contextCheckpoint: agent.ConversationContextCheckpoint
  contextLedgerEntry: agent.ConversationContextTurnLedgerEntry
  contextLedger: agent.AgentContextTokenLedger
  contextPreflight: agent.AgentContextTokenPreflight
  event: agent.AgentRuntimeEvent
  host: agent.AgentRuntimeHost
  model: agent.ModelSelection
  approvalMode: agent.ToolApprovalMode
  persistedToolResultRef: agent.PersistedToolResultRef
  provider: agent.ProviderId
  settings: agent.Settings
  store: agent.AgentRuntimeStore
  stream: agent.RuntimeStreamChat
  tokenCountInput: agent.RuntimeContextTokenCountInput
  toolPack: agent.ToolPack
}

export const agentPackageValueContract = {
  AgentRuntime: agent.AgentRuntime,
  ToolApprovalStore: agent.ToolApprovalStore,
  createInMemoryRuntimeStore: agent.createInMemoryRuntimeStore,
  ContextBudgetManager: agent.ContextBudgetManager,
  ContextTokenEstimator: agent.ContextTokenEstimator,
  createRuntimeEvent: agent.createRuntimeEvent,
  createToolPolicy: agent.createToolPolicy,
  createSkillToolPack: agent.createSkillToolPack,
  findModel: agent.findModel,
  isRuntimeEventType: agent.isRuntimeEventType,
  parseSkillDocument: agent.parseSkillDocument,
  requestToolApprovalWithActivity: agent.requestToolApprovalWithActivity,
} satisfies Record<string, unknown>

export const agentHostPackageValueContract = {
  createToolRegistry: agentHost.createToolRegistry,
  executeTool: agentHost.executeTool,
  getToolDefinitions: agentHost.getToolDefinitions,
} satisfies Record<string, unknown>

export type AgentNodePackageConsumerContract = {
  host: agent.AgentRuntimeHost
  stream: agent.RuntimeStreamChat
  tokenCounter: ReturnType<typeof agentNode.createNodeContextTokenCounter>
  semanticCompactGenerator: ReturnType<typeof agentNode.createNodeSemanticCompactGenerator>
  toolResultStore: agentNode.ToolResultStore
}

export const agentNodePackageValueContract = {
  createDefaultNodeRuntimeHost: agentNode.createDefaultNodeRuntimeHost,
  createNodeAgentRuntime: agentNode.createNodeAgentRuntime,
  createProviderStreamChat: agentNode.createProviderStreamChat,
  createNodeContextTokenCounter: agentNode.createNodeContextTokenCounter,
  createNodeSemanticCompactGenerator: agentNode.createNodeSemanticCompactGenerator,
  createNodeToolResultStore: agentNode.createNodeToolResultStore,
  createModelRegistry: agentNode.createModelRegistry,
  createProtocolRegistry: agentNode.createProtocolRegistry,
  createFileRuntimeStore: agentNode.createFileRuntimeStore,
  getNodeToolResultsDir: agentNode.getNodeToolResultsDir,
  createDefaultWebSearch: agentNode.createDefaultWebSearch,
  createWebSearchRegistry: agentNode.createWebSearchRegistry,
  WebSearchRegistry: agentNode.WebSearchRegistry,
  registerBuiltInWebSearchProviders: agentNode.registerBuiltInWebSearchProviders,
} satisfies Record<string, unknown>
