import * as agent from '@aila/agent'
import * as agentHost from '@aila/agent/host'
import * as agentInternal from '@aila/agent/internal'
import * as agentNode from '@aila/agent-node'

// @ts-expect-error durable loop mechanics are not root package exports.
export const packageRunMachineMustNotExist = agent.runDurableRun
// @ts-expect-error raw persisted conversation helpers are not package API.
export const packageCreateConversationMustNotExist = agent.createConversation
// @ts-expect-error Desktop docs APIs are not agent package API.
export const packageCreateDocMustNotExist = agent.createDoc
// @ts-expect-error Desktop host adapters stay in the app, not @aila/agent.
export const packageConfigureDataDirMustNotExist = agent.configureDataDir

export type AgentPackageConsumerContract = {
  agent: agent.Agent
  agentEvent: agent.AgentEvent
  turn: agent.Turn
  activityEvent: agent.RunEvent
  api: agent.Workbench
  budgetPlan: agent.AgentContextBudgetPlan
  compactArtifact: agent.ConversationCompactArtifact
  conversation: agent.ConversationRecord
  contextCheckpoint: agent.ConversationContextCheckpoint
  contextLedgerEntry: agent.ConversationContextTurnLedgerEntry
  contextLedger: agent.AgentContextTokenLedger
  contextPreflight: agent.AgentContextTokenPreflight
  event: agent.WorkbenchEvent
  host: agent.WorkbenchHost
  model: agent.ModelSelection
  approvalMode: agent.ToolApprovalMode
  persistedToolResultRef: agent.PersistedToolResultRef
  provider: agent.ProviderId
  settings: agent.Settings
  store: agent.WorkbenchStore
  stream: agent.DurableRunExecutor
  tokenCountInput: agent.RuntimeContextTokenCountInput
  toolPack: agent.ToolPack
}

export const agentInternalPackageValueContract = {
  run: agentInternal.runDurableRun,
  advance: agentInternal.advanceRun,
} satisfies Record<string, unknown>

export const agentPackageValueContract = {
  WorkbenchRuntime: agent.WorkbenchRuntime,
  ToolApprovalStore: agent.ToolApprovalStore,
  createInMemoryRuntimeStore: agent.createInMemoryRuntimeStore,
  ContextBudgetManager: agent.ContextBudgetManager,
  ContextTokenEstimator: agent.ContextTokenEstimator,
  createWorkbenchEvent: agent.createWorkbenchEvent,
  createToolPolicy: agent.createToolPolicy,
  createSkillToolPack: agent.createSkillToolPack,
  findModel: agent.findModel,
  isWorkbenchEventType: agent.isWorkbenchEventType,
  parseSkillDocument: agent.parseSkillDocument,
  requestToolApprovalWithActivity: agent.requestToolApprovalWithActivity,
} satisfies Record<string, unknown>

export const agentHostPackageValueContract = {
  createToolRegistry: agentHost.createToolRegistry,
  executeTool: agentHost.executeTool,
  getToolDefinitions: agentHost.getToolDefinitions,
} satisfies Record<string, unknown>

export type AgentNodePackageConsumerContract = {
  host: agent.WorkbenchHost
  stream: agent.DurableRunExecutor
  tokenCounter: ReturnType<typeof agentNode.createNodeContextTokenCounter>
  semanticCompactGenerator: ReturnType<typeof agentNode.createNodeSemanticCompactGenerator>
  toolResultStore: agentNode.ToolResultStore
}

export const agentNodePackageValueContract = {
  createDefaultNodeRuntimeHost: agentNode.createDefaultNodeRuntimeHost,
  createNodeWorkbench: agentNode.createNodeWorkbench,
  createDurableRunExecutor: agentNode.createDurableRunExecutor,
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
