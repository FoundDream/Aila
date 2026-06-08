import * as agent from '@aila/agent'

// @ts-expect-error runtime internals are not package exports.
export type AgentInternalPackageExportMustNotResolve = typeof import('@aila/agent/internal')
// @ts-expect-error node/desktop host adapters are intentionally not package exports.
export type AgentNodePackageExportMustNotResolve = typeof import('@aila/agent/node')

// @ts-expect-error tool execution helpers are internal, not public package API.
export const packageExecuteToolMustNotExist = agent.executeTool
// @ts-expect-error raw persisted conversation helpers are not package API.
export const packageCreateConversationMustNotExist = agent.createConversation
// @ts-expect-error Desktop docs APIs are not agent package API.
export const packageCreateDocMustNotExist = agent.createDoc
// @ts-expect-error Desktop host adapters stay in the app, not @aila/agent.
export const packageConfigureDataDirMustNotExist = agent.configureDataDir

export type AgentPackageConsumerContract = {
  activityEvent: agent.AgentEvent
  api: agent.AgentRuntimeApi
  conversation: agent.ConversationRecord
  event: agent.AgentRuntimeEvent
  host: agent.AgentRuntimeHost
  model: agent.ModelSelection
  provider: agent.ProviderId
  settings: agent.Settings
  store: agent.AgentRuntimeStore
  stream: agent.RuntimeStreamChat
  toolPack: agent.ToolPack
}

export const agentPackageValueContract = {
  AgentRuntime: agent.AgentRuntime,
  ToolApprovalStore: agent.ToolApprovalStore,
  createInMemoryRuntimeStore: agent.createInMemoryRuntimeStore,
  createRuntimeEvent: agent.createRuntimeEvent,
  createSkillToolPack: agent.createSkillToolPack,
  findModel: agent.findModel,
  isRuntimeEventType: agent.isRuntimeEventType,
  parseSkillDocument: agent.parseSkillDocument,
  requestToolApprovalWithActivity: agent.requestToolApprovalWithActivity,
} satisfies Record<string, unknown>
