import type { ChatMessage, DurableRunExecutor, RuntimeModelInfoResolver } from '../agent-protocol'
import type {
  ConversationRecord,
  ConversationRuntimeReplayState,
  ConversationSummary,
  PersistedMessage,
  PersistedRunEvent,
} from '../conversation-core'
import type { RunPayload, RunSnapshot } from '../run-persistence'
import type {
  BlobGarbageCollectionResult,
  SessionProjectionOptions,
  SessionTree,
} from '../session-journal'
import type { Settings } from '../settings-types'
import type { LoadedSkill } from '../skills'
import type { ToolContext, ToolPack, ToolRegistry } from '../tools'
import type {
  SessionInputQueueMode,
  SessionInputQueueState,
  WorkbenchEvent,
} from '../workbench-events'
import type {
  ActiveAssistantTurn,
  ConversationAbortReason,
  ConversationRuntimeHydration,
  ConversationRuntimeStateSnapshot,
  RuntimeAppendSessionCustomInput,
  RuntimeAppendSessionCustomMessageInput,
  RuntimeAppendUserMessageInput,
  RuntimeAttachmentBlock,
  RuntimeCompactConversationInput,
  RuntimeCompactConversationResult,
  RuntimeContextCompactArtifactInput,
  RuntimeContextCompactArtifactResult,
  RuntimeContextTokenCountInput,
  RuntimeContextTokenCountResult,
  RuntimeCreateConversationInput,
  RuntimeExecuteToolInput,
  RuntimeForkRunInput,
  RuntimeForkSessionInput,
  RuntimeNavigateSessionInput,
  RuntimePersistAttachmentInput,
  RuntimeQueueControlInput,
  RuntimeRecordRunEventInput,
  RuntimeResolveConversationInput,
  RuntimeResolveConversationResult,
  RuntimeResumeRunInput,
  RuntimeRetryLastInput,
  RuntimeRunControlInput,
  RuntimeRunInspection,
  RuntimeRunPayloadInput,
  RuntimeRunSummary,
  RuntimeSendInput,
  RuntimeSendResult,
  RuntimeSessionAvailability,
  RuntimeStableInstructionsInput,
  RuntimeToolPackLoadInput,
  RuntimeTransientContextInput,
  RuntimeWorkspaceResolverInput,
} from './api-types'
import type { WorkbenchStore } from './repositories'
import type { SessionRuntime } from './session-runtime'

export type MaybePromise<T> = T | Promise<T>

export interface WorkbenchHost {
  createId?: () => string
  createRunId?: () => string
  createEventId?: () => string
  now?: () => number
  onEvent?: (event: WorkbenchEvent) => void
  onToolPolicy?: ToolContext['onToolPolicy']
  onToolApproval?: ToolContext['onToolApproval']
  onConversationAbort?: (
    conversationId: string,
    reason: ConversationAbortReason,
  ) => MaybePromise<void>
  cleanupConversationAssets?: (record: ConversationRecord) => MaybePromise<void>
  persistAttachment?: (input: RuntimePersistAttachmentInput) => MaybePromise<RuntimeAttachmentBlock>
  toolPacks?: readonly ToolPack[]
  loadToolPacks?: (input?: RuntimeToolPackLoadInput) => Promise<readonly ToolPack[]>
  skills?: readonly LoadedSkill[]
  loadSkills?: () => Promise<readonly LoadedSkill[]>
  loadSettings?: () => MaybePromise<Settings>
  loadStableInstructions?: (
    input: RuntimeStableInstructionsInput,
  ) => MaybePromise<ChatMessage[] | undefined>
  loadTransientContext?: (
    input: RuntimeTransientContextInput,
  ) => MaybePromise<ChatMessage[] | undefined>
  countContextTokens?: (
    input: RuntimeContextTokenCountInput,
  ) => MaybePromise<RuntimeContextTokenCountResult | null | undefined>
  generateContextCompactArtifact?: (
    input: RuntimeContextCompactArtifactInput,
  ) => MaybePromise<RuntimeContextCompactArtifactResult | null | undefined>
  webSearch?: ToolContext['webSearch']
  generateImage?: ToolContext['generateImage']
  saveImage?: ToolContext['saveImage']
  runShell?: ToolContext['runShell']
  fileSystem?: ToolContext['fileSystem']
  path?: ToolContext['path']
  workspaceRoots?:
    | ToolContext['workspaceRoots']
    | ((input: RuntimeWorkspaceResolverInput) => ToolContext['workspaceRoots'])
  shellCwd?:
    | ToolContext['shellCwd']
    | ((input: RuntimeWorkspaceResolverInput) => ToolContext['shellCwd'])
  getModelInfo?: RuntimeModelInfoResolver
  runAgent?: DurableRunExecutor
  sessionEntryTransforms?: SessionProjectionOptions['entryTransforms']
  sessionCustomEntryProjectors?: SessionProjectionOptions['customEntryProjectors']
  logger?: Pick<Console, 'error' | 'warn'>
}

export interface WorkbenchOptions extends WorkbenchHost {
  host?: WorkbenchHost
  store?: WorkbenchStore
  toolPacks?: readonly ToolPack[]
  skills?: readonly LoadedSkill[]
  abortAllCleanupTimeoutMs?: number
}

export interface WorkbenchSessionApi {
  getSessionRuntime(conversationId: string): SessionRuntime
  createConversation(input?: RuntimeCreateConversationInput): Promise<ConversationSummary>
  listConversations(): Promise<ConversationSummary[]>
  getConversation(conversationId: string): Promise<ConversationRecord>
  getSessionTree(conversationId: string): Promise<SessionTree>
  getAvailability(conversationId: string): Promise<RuntimeSessionAvailability>
  navigateSession(input: RuntimeNavigateSessionInput): Promise<ConversationRecord>
  forkSession(input: RuntimeForkSessionInput): Promise<ConversationSummary>
  collectSessionGarbage(conversationId: string): Promise<BlobGarbageCollectionResult>
  compactConversation(
    input: RuntimeCompactConversationInput,
  ): Promise<RuntimeCompactConversationResult>
  resolveConversation(
    input?: RuntimeResolveConversationInput,
  ): Promise<RuntimeResolveConversationResult>
  hydrateConversation(conversationId: string): Promise<ConversationRuntimeHydration>
  getConversationRuntimeState(conversationId: string): Promise<ConversationRuntimeReplayState>
  listConversationRuntimeStates(): Promise<ConversationRuntimeStateSnapshot[]>
  listRunEvents(conversationId: string): Promise<PersistedRunEvent[]>
  getRunSnapshot(conversationId: string, runId: string): Promise<RunSnapshot | null>
  listRunSnapshots(conversationId: string): Promise<RunSnapshot[]>
  listRunSummaries(conversationId: string): Promise<RuntimeRunSummary[]>
  inspectRun(input: RuntimeRunControlInput): Promise<RuntimeRunInspection>
  getRunPayload(input: RuntimeRunPayloadInput): Promise<RunPayload>
  appendUserMessage(input: RuntimeAppendUserMessageInput): Promise<PersistedMessage>
  appendSessionCustomEntry(input: RuntimeAppendSessionCustomInput): Promise<string>
  appendSessionCustomMessage(input: RuntimeAppendSessionCustomMessageInput): Promise<string>
  recordRunEvent(event: RuntimeRecordRunEventInput): Promise<boolean>
  renameConversation(conversationId: string, title: string): Promise<ConversationSummary>
  deleteConversation(conversationId: string): Promise<void>
}

export interface WorkbenchRunApi {
  send(input: RuntimeSendInput): Promise<RuntimeSendResult>
  retryLastUserMessage(input: RuntimeRetryLastInput): Promise<RuntimeSendResult>
  resumeRun(input: RuntimeResumeRunInput): Promise<RuntimeSendResult>
  stepRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult>
  continueRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult>
  abortRun(input: RuntimeRunControlInput): Promise<RunSnapshot>
  forkRun(input: RuntimeForkRunInput): Promise<RunSnapshot>
  abort(conversationId: string): Promise<void>
  steer(input: RuntimeQueueControlInput): Promise<string>
  followUp(input: RuntimeQueueControlInput): Promise<string>
  nextTurn(input: RuntimeQueueControlInput): Promise<string>
  getInputQueueState(conversationId: string): SessionInputQueueState
  clearInputQueue(conversationId: string): SessionInputQueueState
  setSteeringMode(conversationId: string, mode: SessionInputQueueMode): void
  setFollowUpMode(conversationId: string, mode: SessionInputQueueMode): void
  abortAll(reason?: ConversationAbortReason): Promise<void>
  shutdown(reason?: ConversationAbortReason): Promise<void>
  listActiveTurns(): ActiveAssistantTurn[]
  recoverInterruptedActivities(reason?: string): Promise<ConversationSummary[]>
}

export interface WorkbenchExtensionApi {
  getToolRegistry(input?: RuntimeToolPackLoadInput): Promise<ToolRegistry>
  getSkills(): Promise<LoadedSkill[]>
  reloadToolPacks(): Promise<ToolRegistry>
  executeTool(input: RuntimeExecuteToolInput): Promise<string>
}

export interface Workbench extends WorkbenchSessionApi, WorkbenchRunApi, WorkbenchExtensionApi {}

export function normalizeRuntimeHost(options: WorkbenchOptions): WorkbenchHost {
  const host: WorkbenchHost = {}
  if (options.createId) host.createId = options.createId
  if (options.createRunId) host.createRunId = options.createRunId
  if (options.createEventId) host.createEventId = options.createEventId
  if (options.now) host.now = options.now
  if (options.onEvent) host.onEvent = options.onEvent
  if (options.onToolPolicy) host.onToolPolicy = options.onToolPolicy
  if (options.onToolApproval) host.onToolApproval = options.onToolApproval
  if (options.onConversationAbort) host.onConversationAbort = options.onConversationAbort
  if (options.cleanupConversationAssets) {
    host.cleanupConversationAssets = options.cleanupConversationAssets
  }
  if (options.persistAttachment) host.persistAttachment = options.persistAttachment
  if (options.loadToolPacks) host.loadToolPacks = options.loadToolPacks
  if (options.loadSkills) host.loadSkills = options.loadSkills
  if (options.loadSettings) host.loadSettings = options.loadSettings
  if (options.loadStableInstructions) {
    host.loadStableInstructions = options.loadStableInstructions
  }
  if (options.loadTransientContext) host.loadTransientContext = options.loadTransientContext
  if (options.countContextTokens) host.countContextTokens = options.countContextTokens
  if (options.generateContextCompactArtifact) {
    host.generateContextCompactArtifact = options.generateContextCompactArtifact
  }
  if (options.webSearch) host.webSearch = options.webSearch
  if (options.generateImage) host.generateImage = options.generateImage
  if (options.saveImage) host.saveImage = options.saveImage
  if (options.runShell) host.runShell = options.runShell
  if (options.fileSystem) host.fileSystem = options.fileSystem
  if (options.path) host.path = options.path
  if (options.workspaceRoots !== undefined) host.workspaceRoots = options.workspaceRoots
  if (options.shellCwd !== undefined) host.shellCwd = options.shellCwd
  if (options.getModelInfo) host.getModelInfo = options.getModelInfo
  if (options.runAgent) host.runAgent = options.runAgent
  if (options.sessionEntryTransforms) {
    host.sessionEntryTransforms = options.sessionEntryTransforms
  }
  if (options.sessionCustomEntryProjectors) {
    host.sessionCustomEntryProjectors = options.sessionCustomEntryProjectors
  }
  if (options.logger) host.logger = options.logger

  if (!options.host) return host
  if (options.host.createId) host.createId = options.host.createId
  if (options.host.createRunId) host.createRunId = options.host.createRunId
  if (options.host.createEventId) host.createEventId = options.host.createEventId
  if (options.host.now) host.now = options.host.now
  if (options.host.onEvent) host.onEvent = options.host.onEvent
  if (options.host.onToolPolicy) host.onToolPolicy = options.host.onToolPolicy
  if (options.host.onToolApproval) host.onToolApproval = options.host.onToolApproval
  if (options.host.onConversationAbort) host.onConversationAbort = options.host.onConversationAbort
  if (options.host.cleanupConversationAssets) {
    host.cleanupConversationAssets = options.host.cleanupConversationAssets
  }
  if (options.host.persistAttachment) host.persistAttachment = options.host.persistAttachment
  if (options.host.loadToolPacks) host.loadToolPacks = options.host.loadToolPacks
  if (options.host.loadSkills) host.loadSkills = options.host.loadSkills
  if (options.host.loadSettings) host.loadSettings = options.host.loadSettings
  if (options.host.loadStableInstructions) {
    host.loadStableInstructions = options.host.loadStableInstructions
  }
  if (options.host.loadTransientContext) {
    host.loadTransientContext = options.host.loadTransientContext
  }
  if (options.host.countContextTokens) host.countContextTokens = options.host.countContextTokens
  if (options.host.generateContextCompactArtifact) {
    host.generateContextCompactArtifact = options.host.generateContextCompactArtifact
  }
  if (options.host.webSearch) host.webSearch = options.host.webSearch
  if (options.host.generateImage) host.generateImage = options.host.generateImage
  if (options.host.saveImage) host.saveImage = options.host.saveImage
  if (options.host.runShell) host.runShell = options.host.runShell
  if (options.host.fileSystem) host.fileSystem = options.host.fileSystem
  if (options.host.path) host.path = options.host.path
  if (options.host.workspaceRoots !== undefined) host.workspaceRoots = options.host.workspaceRoots
  if (options.host.shellCwd !== undefined) host.shellCwd = options.host.shellCwd
  if (options.host.getModelInfo) host.getModelInfo = options.host.getModelInfo
  if (options.host.runAgent) host.runAgent = options.host.runAgent
  if (options.host.sessionEntryTransforms) {
    host.sessionEntryTransforms = options.host.sessionEntryTransforms
  }
  if (options.host.sessionCustomEntryProjectors) {
    host.sessionCustomEntryProjectors = options.host.sessionCustomEntryProjectors
  }
  if (options.host.logger) host.logger = options.host.logger
  return host
}
