import * as runtimePackage from '@aila/runtime'
import * as runtimeCore from '@aila/runtime/core'
import * as runtimeNode from '@aila/runtime/node'

// @ts-expect-error runtime internals are not package exports in the dry run.
export type RuntimeInternalPackageExportMustNotResolve = typeof import('@aila/runtime/internal')

// @ts-expect-error tool execution helpers are internal, not public core API.
export const coreExecuteToolMustNotExist = runtimeCore.executeTool
// @ts-expect-error tool execution helpers are internal, not compatibility API.
export const packageExecuteToolMustNotExist = runtimePackage.executeTool
// @ts-expect-error raw persisted conversation helpers are not package API.
export const packageCreateConversationMustNotExist = runtimePackage.createConversation
// @ts-expect-error Desktop docs APIs are not runtime node package API.
export const nodeCreateDocMustNotExist = runtimeNode.createDoc
// @ts-expect-error Desktop docs APIs are not compatibility package API.
export const packageCreateDocMustNotExist = runtimePackage.createDoc

export type RuntimePackageCoreConsumerContract = {
  activityEvent: runtimeCore.AgentEvent
  api: runtimeCore.AgentRuntimeApi
  conversation: runtimeCore.ConversationRecord
  event: runtimeCore.AgentRuntimeEvent
  host: runtimeCore.AgentRuntimeHost
  model: runtimeCore.ModelSelection
  settings: runtimeCore.Settings
  store: runtimeCore.AgentRuntimeStore
  stream: runtimeCore.RuntimeStreamChat
  toolPack: runtimeCore.ToolPack
}

export type RuntimePackageNodeConsumerContract = {
  extensionReport: runtimeNode.ExtensionReport
  settings: runtimeNode.Settings
  skillLoadResult: runtimeNode.SkillLoadResult
  toolPackManifest: runtimeNode.ToolPackManifest
}

export type RuntimePackageCompatibilityConsumerContract = {
  api: runtimePackage.AgentRuntimeApi
  conversation: runtimePackage.ConversationRecord
  extensionReport: runtimePackage.ExtensionReport
  host: runtimePackage.AgentRuntimeHost
  settings: runtimePackage.Settings
  toolPack: runtimePackage.ToolPack
}

export const runtimePackageCoreValueContract = {
  AgentRuntime: runtimeCore.AgentRuntime,
  ToolApprovalStore: runtimeCore.ToolApprovalStore,
  createInMemoryRuntimeStore: runtimeCore.createInMemoryRuntimeStore,
  createRuntimeEvent: runtimeCore.createRuntimeEvent,
  createSkillToolPack: runtimeCore.createSkillToolPack,
  findModel: runtimeCore.findModel,
  isRuntimeEventType: runtimeCore.isRuntimeEventType,
  parseSkillDocument: runtimeCore.parseSkillDocument,
  requestToolApprovalWithActivity: runtimeCore.requestToolApprovalWithActivity,
} satisfies Record<string, unknown>

export const runtimePackageNodeValueContract = {
  configureDataDir: runtimeNode.configureDataDir,
  createDefaultRuntimeHost: runtimeNode.createDefaultRuntimeHost,
  createPersistedAgentRuntime: runtimeNode.createPersistedAgentRuntime,
  createPersistedRuntimeStore: runtimeNode.createPersistedRuntimeStore,
  getDataDir: runtimeNode.getDataDir,
  getExtensionReport: runtimeNode.getExtensionReport,
  loadSettings: runtimeNode.loadSettings,
  loadSkillsFromDir: runtimeNode.loadSkillsFromDir,
  loadToolPacksFromDir: runtimeNode.loadToolPacksFromDir,
} satisfies Record<string, unknown>

export const runtimePackageCompatibilityValueContract = {
  AgentRuntime: runtimePackage.AgentRuntime,
  configureDataDir: runtimePackage.configureDataDir,
  createInMemoryRuntimeStore: runtimePackage.createInMemoryRuntimeStore,
  createPersistedAgentRuntime: runtimePackage.createPersistedAgentRuntime,
  createRuntimeEvent: runtimePackage.createRuntimeEvent,
  getExtensionReport: runtimePackage.getExtensionReport,
  loadSettings: runtimePackage.loadSettings,
} satisfies Record<string, unknown>
