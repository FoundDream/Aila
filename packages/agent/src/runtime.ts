import type {
  ChatMessage,
  DurableRunExecutor,
  ModelInfo,
  ModelSelection,
  RunEvent,
  RuntimeModelInfoResolver,
  UsageInfo,
} from './agent-protocol'
import {
  type AgentContextPlan,
  type AgentContextRecommendedCheckpoint,
  type AgentContextTokenPreflight,
  applyAgentContextTokenPreflight,
  assembleAgentContext,
  recommendManualContextCheckpoint,
} from './context'
import {
  AILA_CONTEXT_CHECKPOINT_SCHEMA_VERSION,
  AILA_CONTEXT_TURN_LEDGER_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  type ConversationCompactArtifact,
  type ConversationContextCheckpoint,
  type ConversationContextTurnLedgerEntry,
  type ConversationRecord,
  type ConversationRuntimeReplayState,
  type ConversationSummary,
  type ConversationWorkspaceRef,
  createInterruptedConversationRecoveryEvent,
  normalizeConversationCompactArtifact,
  type PersistedBlock,
  type PersistedMessage,
  type PersistedRunEvent,
  type RunEventAppendResult,
  replayConversationActivity,
  replayConversationRuntimeState,
} from './conversation-core'
import type { RunIdentity, RunNextAction } from './run-machine'
import {
  AILA_RUN_PAYLOAD_SCHEMA_VERSION,
  prepareRunSnapshotForResume,
  type RunPayload,
  type RunPayloadKind,
  type RunSnapshot,
} from './run-persistence'
import { createInMemoryRuntimeStore } from './runtime/memory-store'
import type { WorkbenchStore } from './runtime/repositories'
import {
  type CoordinatedTurn,
  SessionTurnCoordinator,
  type TurnStartLock,
} from './runtime/turn-coordinator'
import {
  type BlobGarbageCollectionResult,
  type BlobRef,
  projectConversation,
  type SessionEntry,
  type SessionEntryInput,
  type SessionExtensionData,
  type SessionExtensionMessageData,
  type SessionPhase,
  type SessionProjectionOptions,
  type SessionTree,
  sessionRunEvents,
  sessionRunPayloads,
} from './session-journal'
import type { Settings } from './settings-types'
import { createSkillToolPack, type LoadedSkill } from './skills'
import {
  type AilaExecutionMode,
  createExecutionModeToolPolicy,
  isReadOnlyToolMetadata,
  normalizeAilaExecutionMode,
} from './tool-policy'
import {
  createDefaultToolRegistry,
  createToolRegistry,
  executeTool as executeRegisteredTool,
  type ToolContext,
  type ToolPack,
  type ToolRegistry,
} from './tools'
import {
  createWorkbenchEvent,
  type SessionInputQueueMode,
  type SessionInputQueueState,
  type WorkbenchEvent,
} from './workbench-events'

interface StreamSlot extends CoordinatedTurn {
  controller: AbortController
  cleanup: Promise<void>
  assistantMessageId: string
  run: RunIdentity
  selection: ModelSelection
  abortRecorded: boolean
  cleanupInterruptedRecorded: boolean
  turnStartLock: TurnStartLock
}

interface QueuedSessionInput {
  message: PersistedMessage
  chatMessage: ChatMessage
}

interface RuntimeToolContextInput {
  conversationId?: string
  record?: ConversationRecord
  messageId?: string
  toolCallId?: string
  mode?: AilaExecutionMode
  signal?: AbortSignal
}

export interface RuntimeToolPackLoadInput {
  conversationId?: string
  record?: ConversationRecord
}

type RuntimeCompactArtifactSource = 'model' | 'heuristic'
type RuntimeCompactArtifactFallbackReason =
  | 'missing_hook'
  | 'empty_result'
  | 'invalid_artifact'
  | 'error'

interface RuntimeSemanticCompactArtifact {
  artifact: ConversationCompactArtifact
  summary: string
  source: RuntimeCompactArtifactSource
  fallbackReason?: RuntimeCompactArtifactFallbackReason
}

type MaybePromise<T> = T | Promise<T>
export type RuntimeRecordRunEventInput = RunEvent
type RunEventInput = RuntimeRecordRunEventInput

export type ConversationAbortReason = 'user' | 'delete' | 'shutdown'

const DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS = 5_000
const EMPTY_RUNTIME_SETTINGS: Settings = { apiKeys: {}, defaultModel: null }
const FALLBACK_MODEL_CONTEXT: ModelInfo = { model: 'unknown', contextLength: null }
const TURN_LIFECYCLE_EVENTS = new Set<RunEvent['type']>([
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'turn.interrupted',
])

function defaultRuntimeNow(): number {
  return Date.now()
}

function defaultCreateRuntimeId(): string {
  const cryptoLike = (
    globalThis as typeof globalThis & {
      crypto?: { randomUUID?: () => string }
    }
  ).crypto
  return (
    cryptoLike?.randomUUID?.() ??
    `runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function runtimeRunAllowedControls(
  snapshot: RunSnapshot,
  active: boolean,
): RuntimeRunAllowedControls {
  const status = snapshot.loop.state.status
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
  const resumable = status === 'paused' && snapshot.recovery.strategy === 'automatic'
  return {
    step: resumable && !active,
    continue: resumable && !active,
    abort: !terminal,
    fork: !active && snapshot.loop.state.currentStep?.status !== 'running',
  }
}

function runPayloadLabel(payload: RunPayload): string {
  const data =
    payload.data && typeof payload.data === 'object'
      ? (payload.data as Record<string, unknown>)
      : undefined
  const toolName = typeof data?.toolName === 'string' ? data.toolName : undefined
  const outcome = typeof data?.outcome === 'string' ? data.outcome : undefined
  if (payload.kind === 'model_request') return 'Model request'
  if (payload.kind === 'model_response')
    return outcome ? `Model response · ${outcome}` : 'Model response'
  if (payload.kind === 'tool_request')
    return toolName ? `Tool request · ${toolName}` : 'Tool request'
  if (payload.kind === 'tool_result') {
    return [toolName ? `Tool result · ${toolName}` : 'Tool result', outcome]
      .filter(Boolean)
      .join(' · ')
  }
  if (payload.kind === 'tool_batch') return 'Tool batch summary'
  if (payload.kind === 'compaction') return 'Context compaction'
  return payload.kind.replaceAll('_', ' ')
}

function runPayloadDescriptor(payload: RunPayload): RuntimeRunPayloadDescriptor {
  const { data, ...metadata } = payload
  let size = 0
  try {
    size = JSON.stringify(data).length
  } catch {
    size = String(data).length
  }
  return {
    ...cloneRuntimeValue(metadata),
    label: runPayloadLabel(payload),
    size,
  }
}

interface RunContextBlobData {
  messages: ChatMessage[]
  contextPlan: AgentContextPlan
}

function isRunContextBlobData(value: unknown): value is RunContextBlobData {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<RunContextBlobData>
  return (
    Array.isArray(record.messages) && !!record.contextPlan && typeof record.contextPlan === 'object'
  )
}

function runPayloadKindFromEntry(
  kind: SessionEntry<'run.payload'>['data']['kind'],
): RunPayloadKind {
  if (kind === 'provider_request') return 'model_request'
  if (kind === 'provider_response') return 'model_response'
  if (kind === 'context_compaction') return 'compaction'
  return kind
}

function runPayloadFromEntry(entry: SessionEntry<'run.payload'>, data: unknown): RunPayload {
  if (!entry.runId || !entry.turnId || !entry.stepId) {
    throw new Error(`run payload entry is missing execution identity: ${entry.entryId}`)
  }
  return {
    schemaVersion: AILA_RUN_PAYLOAD_SCHEMA_VERSION,
    payloadId: entry.entryId,
    conversationId: entry.sessionId,
    turnId: entry.turnId,
    runId: entry.runId,
    stepId: entry.stepId,
    kind: runPayloadKindFromEntry(entry.data.kind),
    createdAt: entry.timestamp,
    contentType: entry.payloadRef?.contentType === 'text/plain' ? 'text/plain' : 'application/json',
    data: cloneRuntimeValue(data),
  }
}

function withTurnSelection(event: RunEventInput, selection: ModelSelection): RunEventInput {
  if (!TURN_LIFECYCLE_EVENTS.has(event.type)) return event
  const data = event.data ?? {}
  if (typeof data.providerId === 'string' && typeof data.modelId === 'string') return event
  return {
    ...event,
    data: {
      ...data,
      ...(typeof data.providerId === 'string' ? {} : { providerId: selection.providerId }),
      ...(typeof data.modelId === 'string' ? {} : { modelId: selection.modelId }),
    },
  }
}

function resolveRetryTurn(record: ConversationRecord): {
  userMessage: PersistedMessage
  record: ConversationRecord
} {
  const lastIndex = record.messages.length - 1
  const lastMessage = record.messages[lastIndex]
  if (!lastMessage) throw new Error('cannot retry: conversation has no messages')

  if (lastMessage.role === 'user') {
    return { userMessage: lastMessage, record }
  }

  if (lastMessage.role !== 'assistant' || lastMessage.status !== 'error') {
    throw new Error('cannot retry: last persisted turn is not retryable')
  }

  for (let i = lastIndex - 1; i >= 0; i--) {
    const candidate = record.messages[i]
    if (candidate?.role === 'user') {
      return {
        userMessage: candidate,
        record: {
          ...record,
          messages: record.messages.slice(0, lastIndex),
        },
      }
    }
  }

  throw new Error('cannot retry: failed assistant turn has no preceding user message')
}

/** Attachment payload sent with a user message. */
export interface ChatAttachmentInput {
  kind: 'image' | 'text'
  name: string
  mime: string
  /** kind 'image': base64-encoded bytes (no data: prefix). kind 'text': raw content. */
  data: string
}

export interface RuntimePersistAttachmentInput extends ChatAttachmentInput {
  conversationId: string
}

export type RuntimeAttachmentBlock = Extract<PersistedBlock, { type: 'file' | 'image' }>

export interface RuntimeSendInput {
  conversationId: string
  userText: string
  selection: ModelSelection
  mode?: AilaExecutionMode
  loopMode?: 'continuous' | 'step'
  attachments?: ChatAttachmentInput[]
  transientContext?: ChatMessage[]
}

export interface RuntimeRetryLastInput {
  conversationId: string
  selection: ModelSelection
  mode?: AilaExecutionMode
  loopMode?: 'continuous' | 'step'
  transientContext?: ChatMessage[]
}

export interface RuntimeQueueInput {
  text: string
}

export interface RuntimeQueueControlInput extends RuntimeQueueInput {
  conversationId: string
}

export interface RuntimeCompactConversationInput {
  conversationId: string
  selection: ModelSelection
}

export interface RuntimeCompactConversationResult {
  compacted: boolean
  summary: ConversationSummary
  checkpoint?: ConversationContextCheckpoint
  reason?: 'nothing_to_compact'
}

export interface RuntimeTransientContextInput {
  conversationId: string
  record: ConversationRecord
  selection: ModelSelection
  source: 'send' | 'retry'
  mode?: AilaExecutionMode
}

export type RuntimeStableInstructionsInput = RuntimeTransientContextInput

export interface RuntimeContextTokenCountInput {
  conversationId: string
  assistantMessageId: string
  selection: ModelSelection
  messages: ChatMessage[]
  contextPlan: AgentContextPlan
}

export interface RuntimeContextTokenCountResult {
  inputTokens: number
  method?: string
  providerId?: string
  model?: string
}

export interface RuntimeContextCompactArtifactInput {
  conversationId: string
  selection: ModelSelection
  activeCheckpoint?: ConversationContextCheckpoint
  recommendedCheckpoint: AgentContextRecommendedCheckpoint
  sourceMessages: PersistedMessage[]
}

export interface RuntimeContextCompactArtifactResult {
  artifact: ConversationCompactArtifact
  summary?: string
}

export interface RuntimeSendResult {
  userMessage: PersistedMessage
  assistantMessageId: string
  turnId: string
  runId: string
}

export interface RuntimeRunControlInput {
  conversationId: string
  runId: string
}

export interface RuntimeResumeRunInput extends RuntimeRunControlInput {
  loopMode?: 'continuous' | 'step'
}

export interface RuntimeForkRunInput extends RuntimeRunControlInput {
  originStepId?: string
}

export interface RuntimeRunPayloadInput extends RuntimeRunControlInput {
  payloadId: string
}

export interface RuntimeRunAllowedControls {
  step: boolean
  continue: boolean
  abort: boolean
  fork: boolean
}

export interface RuntimeRunSummary {
  identity: RunSnapshot['identity']
  status: RunSnapshot['loop']['state']['status']
  mode: RunSnapshot['loop']['state']['mode']
  nextAction?: RunSnapshot['loop']['state']['nextAction']
  wait?: RunSnapshot['loop']['state']['wait']
  recovery: RunSnapshot['recovery']
  revision: number
  updatedAt: number
  stepCount: number
  active: boolean
  allowedControls: RuntimeRunAllowedControls
}

export interface RuntimeRunPayloadDescriptor extends Omit<RunPayload, 'data'> {
  label: string
  size: number
}

export interface RuntimeRunInspection {
  snapshot: RunSnapshot
  events: PersistedRunEvent[]
  payloads: RuntimeRunPayloadDescriptor[]
  active: boolean
  allowedControls: RuntimeRunAllowedControls
}

export interface ActiveAssistantTurn {
  conversationId: string
  assistantMessageId: string
  turnId: string
  runId: string
  selection: ModelSelection
}

export interface RuntimeCreateConversationInput {
  workspace?: ConversationWorkspaceRef | null
}

export interface RuntimeNavigateSessionInput {
  conversationId: string
  entryId: string
}

export interface RuntimeForkSessionInput {
  conversationId: string
  entryId?: string
  workspace?: ConversationWorkspaceRef | null
}

export interface ConversationRuntimeStateSnapshot {
  conversationId: string
  state: ConversationRuntimeReplayState
}

export interface ConversationRuntimeHydration {
  record: ConversationRecord
  events: PersistedRunEvent[]
  runtimeState: ConversationRuntimeReplayState
  activeTurn: ActiveAssistantTurn | null
}

export interface RuntimeResolveConversationInput {
  conversationId?: string
  resumeLatest?: boolean
}

export interface RuntimeResolveConversationResult {
  conversationId: string
  isExisting: boolean
  summary: ConversationSummary
}

export interface RuntimeAppendUserMessageInput {
  conversationId: string
  text: string
}

export interface RuntimeAppendSessionCustomInput extends SessionExtensionData {
  conversationId: string
}

export interface RuntimeAppendSessionCustomMessageInput extends SessionExtensionMessageData {
  conversationId: string
}

export interface RuntimeExecuteToolInput {
  name: string
  args: Record<string, unknown>
  mode?: AilaExecutionMode
  conversationId?: string
  messageId?: string
  toolCallId?: string
  signal?: AbortSignal
}

export interface RuntimeWorkspaceResolverInput {
  conversationId?: string
  workspace?: ConversationWorkspaceRef | null
}

export {
  AILA_WORKBENCH_EVENT_SCHEMA_VERSION,
  AILA_WORKBENCH_EVENT_TYPES,
  createWorkbenchEvent,
  isWorkbenchEventType,
  type SessionInputQueueMode,
  type SessionInputQueueState,
  type WorkbenchEvent,
  type WorkbenchEventMap,
  type WorkbenchEventType,
} from './workbench-events'

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

export {
  createInMemoryRuntimeStore,
  type InMemoryStoreOptions,
  type RuntimeEnvironment,
} from './runtime/memory-store'
export type {
  BlobRepository,
  EventRepository,
  RecoveryRepository,
  RunRepository,
  RunSnapshotRepository,
  SessionRepository,
  WorkbenchStore,
} from './runtime/repositories'

interface WorkbenchSessionApi {
  getSessionRuntime(conversationId: string): SessionRuntime
  createConversation(input?: RuntimeCreateConversationInput): Promise<ConversationSummary>
  listConversations(): Promise<ConversationSummary[]>
  getConversation(conversationId: string): Promise<ConversationRecord>
  getSessionTree(conversationId: string): Promise<SessionTree>
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

interface WorkbenchRunApi {
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

interface WorkbenchExtensionApi {
  getToolRegistry(input?: RuntimeToolPackLoadInput): Promise<ToolRegistry>
  getSkills(): Promise<LoadedSkill[]>
  reloadToolPacks(): Promise<ToolRegistry>
  executeTool(input: RuntimeExecuteToolInput): Promise<string>
}

export interface Workbench extends WorkbenchSessionApi, WorkbenchRunApi, WorkbenchExtensionApi {}

function cloneRuntimeValue<T>(value: T): T {
  return structuredClone(value)
}

function normalizeRuntimeHost(options: WorkbenchOptions): WorkbenchHost {
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

function cloneRuntimeToolPack(toolPack: ToolPack): ToolPack {
  return {
    ...toolPack,
    tools: toolPack.tools.map((entry) => ({
      run: entry.run,
      spec: cloneRuntimeValue(entry.spec),
    })),
  }
}

function cloneRuntimeToolRegistry(registry: ToolRegistry): ToolRegistry {
  return createToolRegistry(registry.toolPacks.map(cloneRuntimeToolPack))
}

function filterRuntimeToolRegistryForMode(
  registry: ToolRegistry,
  mode: AilaExecutionMode,
): ToolRegistry {
  if (mode === 'agent') return cloneRuntimeToolRegistry(registry)
  const toolPacks = registry.toolPacks
    .map((toolPack) => ({
      ...toolPack,
      tools: toolPack.tools.filter((entry) => isReadOnlyToolMetadata(entry.spec.metadata)),
    }))
    .filter((toolPack) => toolPack.tools.length > 0)
  return createToolRegistry(toolPacks)
}

function cloneRuntimeSettings(settings: Settings): Settings {
  return cloneRuntimeValue(settings)
}

function assertRuntimeAttachmentBlock(block: RuntimeAttachmentBlock): RuntimeAttachmentBlock {
  if (!block || typeof block !== 'object') {
    throw new Error('runtime host returned an invalid attachment block')
  }
  if (block.type === 'file') {
    if (typeof block.name !== 'string' || typeof block.content !== 'string') {
      throw new Error('runtime host returned an invalid file attachment block')
    }
    return block
  }
  if (block.type === 'image') {
    if (typeof block.url !== 'string' || typeof block.mime !== 'string') {
      throw new Error('runtime host returned an invalid image attachment block')
    }
    return block
  }
  throw new Error('runtime host returned an unsupported attachment block')
}

function cloneRuntimeWorkspaceRoots(
  roots: ToolContext['workspaceRoots'],
): ToolContext['workspaceRoots'] {
  return roots === undefined ? undefined : cloneRuntimeValue(roots)
}

function cloneRuntimeChatMessages(
  messages: readonly ChatMessage[] | undefined,
): ChatMessage[] | undefined {
  return messages === undefined ? undefined : cloneRuntimeValue([...messages])
}

const IN_RUN_TOOL_RESULT_COMPACTED =
  '[Earlier tool result compacted during this run; rerun the tool if the full output is required.]'

function prepareRuntimeModelStepMessages(
  messages: readonly ChatMessage[],
  contextPlan: AgentContextPlan | undefined,
): ChatMessage[] {
  const prepared = cloneRuntimeChatMessages(messages) ?? []
  const budgetChars = contextPlan?.budget.budgetChars
  if (!budgetChars || JSON.stringify(prepared).length <= budgetChars) return prepared

  const toolIndexes = prepared.flatMap((message, index) => (message.role === 'tool' ? [index] : []))
  const compactable = toolIndexes.slice(0, Math.max(0, toolIndexes.length - 6))
  for (const index of compactable) {
    const message = prepared[index]
    if (message?.role !== 'tool') continue
    prepared[index] = {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: IN_RUN_TOOL_RESULT_COMPACTED,
    }
    if (JSON.stringify(prepared).length <= budgetChars) break
  }
  return prepared
}

function cloneRuntimeConversationRecord(record: ConversationRecord): ConversationRecord {
  return cloneRuntimeValue(record)
}

function cloneRuntimeToolPackLoadInput(
  input: RuntimeToolPackLoadInput | undefined,
): RuntimeToolPackLoadInput | undefined {
  if (!input) return undefined
  return {
    ...(input.conversationId && { conversationId: input.conversationId }),
    ...(input.record && { record: cloneRuntimeConversationRecord(input.record) }),
  }
}

function cloneRuntimeConversationSummary(summary: ConversationSummary): ConversationSummary {
  return cloneRuntimeValue(summary)
}

function cloneRuntimeConversationSummaries(
  summaries: readonly ConversationSummary[],
): ConversationSummary[] {
  return cloneRuntimeValue([...summaries])
}

function sortRuntimeConversationSummaries(
  summaries: readonly ConversationSummary[],
): ConversationSummary[] {
  return summaries
    .map((summary, index) => ({ summary, index }))
    .sort((left, right) => {
      const updatedOrder = right.summary.updatedAt - left.summary.updatedAt
      return updatedOrder === 0 ? left.index - right.index : updatedOrder
    })
    .map(({ summary }) => summary)
}

function cloneRuntimePersistedMessage(message: PersistedMessage): PersistedMessage {
  return cloneRuntimeValue(message)
}

function cloneRuntimePersistedRunEvent(event: PersistedRunEvent): PersistedRunEvent {
  return cloneRuntimeValue(event)
}

function cloneRuntimePersistedRunEvents(events: readonly PersistedRunEvent[]): PersistedRunEvent[] {
  return cloneRuntimeValue([...events])
}

function cloneRuntimeRunEventAppendResult(result: RunEventAppendResult): RunEventAppendResult {
  const event = cloneRuntimePersistedRunEvent(result.event)
  if (!result.summary) return { event }
  return { event, summary: cloneRuntimeConversationSummary(result.summary) }
}

function cloneRuntimeRunEventAppendResults(
  results: readonly RunEventAppendResult[],
): RunEventAppendResult[] {
  return results.map(cloneRuntimeRunEventAppendResult)
}

function resolveStaticToolPacks(options: WorkbenchOptions): readonly ToolPack[] {
  return (options.host?.toolPacks ?? options.toolPacks ?? []).map(cloneRuntimeToolPack)
}

function resolveStaticSkills(options: WorkbenchOptions): readonly LoadedSkill[] {
  return (options.host?.skills ?? options.skills ?? []).map(cloneRuntimeSkill)
}

function cloneRuntimeSkill(skill: LoadedSkill): LoadedSkill {
  return cloneRuntimeValue(skill)
}

function cloneRuntimeSkills(skills: readonly LoadedSkill[]): LoadedSkill[] {
  return skills.map(cloneRuntimeSkill)
}

function createRuntimeSkillToolPacks(skills: readonly LoadedSkill[]): ToolPack[] {
  const pack = createSkillToolPack(skills)
  return pack ? [pack] : []
}

class WorkbenchServices {
  readonly host: WorkbenchHost
  readonly store: WorkbenchStore
  readonly logger: Pick<Console, 'error' | 'warn'>
  readonly createId: () => string
  readonly createRunId: () => string
  readonly createEventId: () => string
  readonly now: () => number
  private readonly staticToolPacks: readonly ToolPack[]
  private readonly staticSkills: readonly LoadedSkill[]
  private readonly fallbackToolRegistry: ToolRegistry
  private toolRegistryLoad: Promise<ToolRegistry> | null = null
  private skillsLoad: Promise<readonly LoadedSkill[]> | null = null

  constructor(readonly options: WorkbenchOptions = {}) {
    this.host = normalizeRuntimeHost(options)
    this.createId = this.host.createId ?? defaultCreateRuntimeId
    this.createRunId = this.host.createRunId ?? defaultCreateRuntimeId
    this.createEventId = this.host.createEventId ?? defaultCreateRuntimeId
    this.now = this.host.now ?? defaultRuntimeNow
    this.store =
      options.store ??
      createInMemoryRuntimeStore({
        createId: this.createId,
        createEventId: this.createEventId,
        now: this.now,
      })
    this.logger = this.host.logger ?? console
    this.staticToolPacks = resolveStaticToolPacks(options)
    this.staticSkills = resolveStaticSkills(options)
    this.fallbackToolRegistry = createDefaultToolRegistry([
      ...this.staticToolPacks,
      ...createRuntimeSkillToolPacks(this.staticSkills),
    ])
  }

  emit(event: WorkbenchEvent): void {
    this.host.onEvent?.(cloneRuntimeValue(event))
  }

  async getToolRegistry(input?: RuntimeToolPackLoadInput): Promise<ToolRegistry> {
    if (!this.host.loadToolPacks && !this.host.loadSkills) {
      return cloneRuntimeToolRegistry(this.fallbackToolRegistry)
    }
    if (input) return cloneRuntimeToolRegistry(await this.loadToolRegistry(input))
    if (!this.toolRegistryLoad) this.toolRegistryLoad = this.loadToolRegistry()
    return cloneRuntimeToolRegistry(await this.toolRegistryLoad)
  }

  async getSkills(): Promise<LoadedSkill[]> {
    if (!this.host.loadSkills) return cloneRuntimeSkills(this.staticSkills)
    if (!this.skillsLoad) this.skillsLoad = this.loadSkills()
    return cloneRuntimeSkills(await this.skillsLoad)
  }

  async reloadToolPacks(): Promise<ToolRegistry> {
    this.toolRegistryLoad = null
    this.skillsLoad = null
    return this.getToolRegistry()
  }

  async executeTool(input: RuntimeExecuteToolInput, record?: ConversationRecord): Promise<string> {
    const mode = normalizeAilaExecutionMode(input.mode)
    const registry = await this.getToolRegistry(
      record && input.conversationId ? { conversationId: input.conversationId, record } : undefined,
    )
    return executeRegisteredTool(
      input.name,
      input.args,
      await this.buildToolContext({
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(record ? { record } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        mode,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
      registry,
    )
  }

  async buildToolContext(input: RuntimeToolContextInput): Promise<ToolContext> {
    const workspaceInput = this.resolveWorkspaceInput(input)
    const hostRoots = this.resolveWorkspaceRoots(workspaceInput)
    const skillRoots = (await this.getSkills()).map((skill) => ({
      path: skill.directory,
      label: `Skill: ${skill.definition.name}`,
    }))
    const mode = normalizeAilaExecutionMode(input.mode)
    const onToolPolicy =
      mode === 'agent' && !this.host.onToolPolicy
        ? undefined
        : createExecutionModeToolPolicy(mode, this.host.onToolPolicy)
    return {
      settings: cloneRuntimeSettings((await this.host.loadSettings?.()) ?? EMPTY_RUNTIME_SETTINGS),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      workspaceRoots: skillRoots.length > 0 ? [...(hostRoots ?? []), ...skillRoots] : hostRoots,
      shellCwd: this.resolveShellCwd(workspaceInput),
      ...(onToolPolicy ? { onToolPolicy } : {}),
      onToolApproval: this.host.onToolApproval,
      webSearch: this.host.webSearch,
      generateImage: this.host.generateImage,
      saveImage: this.host.saveImage,
      runShell: this.host.runShell,
      fileSystem: this.host.fileSystem,
      path: this.host.path,
    }
  }

  private resolveWorkspaceInput(input: RuntimeToolContextInput): RuntimeWorkspaceResolverInput {
    return {
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.record
        ? { workspace: cloneRuntimeValue(input.record.meta.workspace ?? null) }
        : {}),
    }
  }

  private resolveWorkspaceRoots(
    input: RuntimeWorkspaceResolverInput,
  ): ToolContext['workspaceRoots'] {
    const roots = this.host.workspaceRoots
    return cloneRuntimeWorkspaceRoots(
      typeof roots === 'function' ? roots(cloneRuntimeValue(input)) : roots,
    )
  }

  private resolveShellCwd(input: RuntimeWorkspaceResolverInput): ToolContext['shellCwd'] {
    const cwd = this.host.shellCwd
    return typeof cwd === 'function' ? cwd(cloneRuntimeValue(input)) : cwd
  }

  private async loadToolRegistry(input?: RuntimeToolPackLoadInput): Promise<ToolRegistry> {
    try {
      const loaded = await this.host.loadToolPacks?.(cloneRuntimeToolPackLoadInput(input))
      const skills = await this.getSkills()
      return createDefaultToolRegistry([
        ...this.staticToolPacks,
        ...(loaded ?? []).map(cloneRuntimeToolPack),
        ...createRuntimeSkillToolPacks(skills),
      ])
    } catch (error) {
      this.logger.warn(
        '[runtime] tool-pack load failed; continuing with built-in/static tools:',
        error,
      )
      return this.fallbackToolRegistry
    }
  }

  private async loadSkills(): Promise<readonly LoadedSkill[]> {
    try {
      const loaded = await this.host.loadSkills?.()
      return [...this.staticSkills, ...(loaded ?? [])].map(cloneRuntimeSkill)
    } catch (error) {
      this.logger.warn('[runtime] skill load failed; continuing without skills:', error)
      return cloneRuntimeSkills(this.staticSkills)
    }
  }
}

class ConversationCatalog {
  constructor(private readonly services: WorkbenchServices) {}

  async createConversation(
    input: RuntimeCreateConversationInput = {},
  ): Promise<ConversationSummary> {
    const { store } = this.services
    if (!store.createConversation) throw new Error('runtime store cannot create conversations')
    const summary = cloneRuntimeConversationSummary(
      await store.createConversation(input.workspace ?? undefined),
    )
    this.services.emit(createWorkbenchEvent('conversations:updated', summary))
    return summary
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const { store } = this.services
    if (!store.listConversations) throw new Error('runtime store cannot list conversations')
    return sortRuntimeConversationSummaries(
      cloneRuntimeConversationSummaries(await store.listConversations()),
    )
  }

  async resolveConversation(
    input: RuntimeResolveConversationInput = {},
  ): Promise<RuntimeResolveConversationResult> {
    if (input.conversationId && input.resumeLatest) {
      throw new Error('conversationId and resumeLatest cannot be combined')
    }
    if (input.resumeLatest) {
      const [summary] = await this.listConversations()
      if (!summary) throw new Error('no conversations found to resume')
      return { conversationId: summary.id, isExisting: true, summary }
    }
    if (input.conversationId) {
      const record = projectConversation(
        await this.services.store.listSessionEntries(input.conversationId),
        {
          entryTransforms: this.services.host.sessionEntryTransforms,
          customEntryProjectors: this.services.host.sessionCustomEntryProjectors,
        },
      )
      return {
        conversationId: input.conversationId,
        isExisting: true,
        summary: cloneRuntimeConversationSummary(record.meta),
      }
    }
    const summary = await this.createConversation()
    return { conversationId: summary.id, isExisting: false, summary }
  }

  async recoverInterruptedActivities(
    reason = 'runtime restarted before this turn finished',
  ): Promise<ConversationSummary[]> {
    const { store } = this.services
    if (store.recoverInterruptedActivities) {
      const recoveredResults = cloneRuntimeRunEventAppendResults(
        await store.recoverInterruptedActivities(reason),
      )
      const recovered: ConversationSummary[] = []
      for (const result of recoveredResults) {
        this.services.emit(createWorkbenchEvent('run:event', result.event))
        if (!result.summary) continue
        this.services.emit(createWorkbenchEvent('conversations:updated', result.summary))
        recovered.push(result.summary)
      }
      await this.resetInterruptedSessionPhases()
      return [...recovered].sort((a, b) => b.updatedAt - a.updatedAt)
    }

    if (!store.listConversations) return []
    const conversations = cloneRuntimeConversationSummaries(await store.listConversations())
    const recovered: ConversationSummary[] = []
    await Promise.all(
      conversations.map(async (summary) => {
        const events = cloneRuntimePersistedRunEvents(
          sessionRunEvents(await store.listSessionEntries(summary.id)),
        )
        const recoveryEvent = createInterruptedConversationRecoveryEvent(events, {
          reason,
          activity: replayConversationActivity(events) ?? summary.activity,
        })
        if (!recoveryEvent) return
        const appended = await store.appendSessionEntry(summary.id, {
          type: 'run.event',
          timestamp: recoveryEvent.timestamp,
          entryId: recoveryEvent.eventId,
          turnId: recoveryEvent.turnId,
          runId: recoveryEvent.runId,
          stepId: recoveryEvent.stepId,
          data: { event: cloneRuntimeValue(recoveryEvent) },
        })
        if (appended.entry.type !== 'run.event') return
        const event = cloneRuntimeValue(appended.entry.data.event) as PersistedRunEvent
        const nextSummary = cloneRuntimeConversationSummary(appended.summary)
        this.services.emit(createWorkbenchEvent('run:event', event))
        this.services.emit(createWorkbenchEvent('conversations:updated', nextSummary))
        recovered.push(nextSummary)
      }),
    )
    await this.resetInterruptedSessionPhases()
    return recovered.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private async resetInterruptedSessionPhases(): Promise<void> {
    const { store } = this.services
    if (!store.listConversations) return
    const conversations = await store.listConversations()
    await Promise.all(
      conversations.map(async (summary) => {
        const tree = await store.getSessionTree(summary.id)
        if (tree.phase === 'idle') return
        await store.appendSessionEntry(summary.id, {
          type: 'session.phase.changed',
          timestamp: this.services.now(),
          data: { phase: 'idle' },
        })
      }),
    )
  }
}

class SessionRuntimeEngine {
  private readonly turns: SessionTurnCoordinator<StreamSlot>
  private deleted = false
  private sessionPhase: SessionPhase | undefined
  private pendingSessionWrites: SessionEntryInput[] = []
  private steeringQueue: QueuedSessionInput[] = []
  private followUpQueue: QueuedSessionInput[] = []
  private nextTurnQueue: QueuedSessionInput[] = []
  private steeringQueueMode: SessionInputQueueMode = 'one-at-a-time'
  private followUpQueueMode: SessionInputQueueMode = 'one-at-a-time'
  private readonly host: WorkbenchHost
  private readonly store: WorkbenchStore
  private readonly logger: Pick<Console, 'error' | 'warn'>
  private readonly createId: () => string
  private readonly createRunId: () => string
  private readonly createEventId: () => string
  private readonly now: () => number
  private readonly options: WorkbenchOptions
  private shutdownPromise: Promise<void> | null = null
  private shutdownStarted = false

  constructor(
    private readonly conversationId: string,
    private readonly services: WorkbenchServices,
    private readonly onSessionEvent?: (event: WorkbenchEvent) => void,
  ) {
    this.turns = new SessionTurnCoordinator(conversationId)
    this.host = services.host
    this.store = services.store
    this.logger = services.logger
    this.createId = services.createId
    this.createRunId = services.createRunId
    this.createEventId = services.createEventId
    this.now = services.now
    this.options = services.options
  }

  async getToolRegistry(input?: RuntimeToolPackLoadInput): Promise<ToolRegistry> {
    return this.services.getToolRegistry(input)
  }

  async getSkills(): Promise<LoadedSkill[]> {
    return this.services.getSkills()
  }

  async reloadToolPacks(): Promise<ToolRegistry> {
    return this.services.reloadToolPacks()
  }

  async getConversation(conversationId: string): Promise<ConversationRecord> {
    return cloneRuntimeConversationRecord(
      projectConversation(await this.store.listSessionEntries(conversationId), {
        entryTransforms: this.host.sessionEntryTransforms,
        customEntryProjectors: this.host.sessionCustomEntryProjectors,
      }),
    )
  }

  async getSessionTree(conversationId: string): Promise<SessionTree> {
    return cloneRuntimeValue(await this.store.getSessionTree(conversationId))
  }

  async navigateSession(input: RuntimeNavigateSessionInput): Promise<ConversationRecord> {
    return this.turns.withStartLock(input.conversationId, async () => {
      this.assertCanStartTurn(input.conversationId)
      if (this.turns.has(input.conversationId)) {
        throw new Error('cannot navigate session while an assistant turn is running')
      }
      await this.requireIdleSession(input.conversationId)
      const appended = await this.store.setSessionLeaf(input.conversationId, input.entryId)
      const record = await this.getConversation(input.conversationId)
      this.emit(createWorkbenchEvent('conversations:updated', appended.summary))
      return record
    })
  }

  async forkSession(input: RuntimeForkSessionInput): Promise<ConversationSummary> {
    return this.turns.withStartLock(input.conversationId, async () => {
      this.assertCanStartTurn(input.conversationId)
      if (this.turns.has(input.conversationId)) {
        throw new Error('cannot fork session while an assistant turn is running')
      }
      await this.requireIdleSession(input.conversationId)
      const summary = await this.store.forkConversation(
        input.conversationId,
        input.entryId,
        input.workspace,
      )
      const cloned = cloneRuntimeConversationSummary(summary)
      this.emit(createWorkbenchEvent('conversations:updated', cloned))
      return cloned
    })
  }

  async collectSessionGarbage(conversationId: string): Promise<BlobGarbageCollectionResult> {
    this.assertCanStartTurn(conversationId)
    if (this.turns.has(conversationId)) {
      throw new Error('cannot collect session garbage while an assistant turn is running')
    }
    await this.requireIdleSession(conversationId)
    return cloneRuntimeValue(await this.store.collectGarbageBlobs(conversationId))
  }

  async listRunEvents(conversationId: string): Promise<PersistedRunEvent[]> {
    return cloneRuntimePersistedRunEvents(
      sessionRunEvents(await this.store.listSessionEntries(conversationId)),
    )
  }

  async getRunSnapshot(conversationId: string, runId: string): Promise<RunSnapshot | null> {
    const snapshot = await this.store.getRunSnapshot(conversationId, runId)
    return snapshot ? cloneRuntimeValue(snapshot) : null
  }

  async listRunSnapshots(conversationId: string): Promise<RunSnapshot[]> {
    return cloneRuntimeValue([...(await this.store.listRunSnapshots(conversationId))])
  }

  async listRunSummaries(conversationId: string): Promise<RuntimeRunSummary[]> {
    const activeRunIds = new Set(
      this.listActiveStreams()
        .filter((turn) => turn.conversationId === conversationId)
        .map((turn) => turn.runId),
    )
    return (await this.listRunSnapshots(conversationId)).map((snapshot) => {
      const active = activeRunIds.has(snapshot.identity.runId)
      return {
        identity: cloneRuntimeValue(snapshot.identity),
        status: snapshot.loop.state.status,
        mode: snapshot.loop.state.mode,
        ...(snapshot.loop.state.nextAction
          ? { nextAction: cloneRuntimeValue(snapshot.loop.state.nextAction) }
          : {}),
        ...(snapshot.loop.state.wait ? { wait: cloneRuntimeValue(snapshot.loop.state.wait) } : {}),
        recovery: cloneRuntimeValue(snapshot.recovery),
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        stepCount: snapshot.loop.state.steps.length,
        active,
        allowedControls: runtimeRunAllowedControls(snapshot, active),
      }
    })
  }

  async inspectRun(input: RuntimeRunControlInput): Promise<RuntimeRunInspection> {
    const snapshot = await this.getRunSnapshot(input.conversationId, input.runId)
    if (!snapshot) {
      throw new Error(`agent run snapshot not found: ${input.conversationId}/${input.runId}`)
    }
    const [events, entries] = await Promise.all([
      this.listRunEvents(input.conversationId),
      this.store.listSessionEntries(input.conversationId),
    ])
    const payloadEntries = sessionRunPayloads(entries, input.runId)
    const payloads = await Promise.all(
      payloadEntries.map(async (entry) => {
        const blob = entry.payloadRef
          ? await this.store.getBlob(input.conversationId, entry.payloadRef.blobId)
          : null
        return runPayloadFromEntry(entry, blob?.data ?? null)
      }),
    )
    const active = this.listActiveStreams().some((turn) => turn.runId === input.runId)
    return cloneRuntimeValue({
      snapshot,
      events: events.filter((event) => event.runId === input.runId),
      payloads: [...payloads].map(runPayloadDescriptor),
      active,
      allowedControls: runtimeRunAllowedControls(snapshot, active),
    })
  }

  async getRunPayload(input: RuntimeRunPayloadInput): Promise<RunPayload> {
    const entry = sessionRunPayloads(
      await this.store.listSessionEntries(input.conversationId),
      input.runId,
    ).find((candidate) => candidate.entryId === input.payloadId)
    if (!entry) {
      throw new Error(`agent run payload not found: ${input.payloadId}`)
    }
    const blob = entry.payloadRef
      ? await this.store.getBlob(input.conversationId, entry.payloadRef.blobId)
      : null
    return cloneRuntimeValue(runPayloadFromEntry(entry, blob?.data ?? null))
  }

  async getConversationRuntimeState(
    conversationId: string,
  ): Promise<ConversationRuntimeReplayState> {
    const events = await this.listRunEvents(conversationId)
    return cloneRuntimeValue(replayConversationRuntimeState(events))
  }

  async hydrateConversation(conversationId: string): Promise<ConversationRuntimeHydration> {
    const [record, events] = await Promise.all([
      this.getConversation(conversationId),
      this.listRunEvents(conversationId),
    ])
    const runtimeState = replayConversationRuntimeState(events)
    const activeTurn =
      this.listActiveStreams().find((turn) => turn.conversationId === conversationId) ?? null
    return cloneRuntimeValue({ record, events, runtimeState, activeTurn })
  }

  async renameConversation(conversationId: string, title: string): Promise<ConversationSummary> {
    const { summary: appended } = await this.store.appendSessionEntry(conversationId, {
      type: 'conversation.renamed',
      timestamp: this.now(),
      data: { title },
    })
    const summary = cloneRuntimeConversationSummary(appended)
    this.emit(createWorkbenchEvent('conversations:updated', summary))
    return summary
  }

  async appendUserMessage(input: RuntimeAppendUserMessageInput): Promise<PersistedMessage> {
    const { conversationId, text } = input
    this.assertCanStartTurn(conversationId)
    const message: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: this.createId(),
      role: 'user',
      blocks: [{ type: 'text', content: text }],
      status: 'done',
    }
    if (!(await this.persistAndAnnounce(conversationId, message))) {
      this.assertConversationOpen(conversationId)
      throw new Error('conversation was deleted')
    }
    return message
  }

  async steer(input: RuntimeQueueControlInput): Promise<string> {
    this.assertBoundConversation(input.conversationId)
    this.assertCanStartTurn(input.conversationId)
    if (!this.turns.has(input.conversationId)) {
      throw new Error('cannot steer while the session is idle')
    }
    const queued = this.createQueuedSessionInput(input.text)
    this.steeringQueue.push(queued)
    this.emitQueueUpdate()
    return queued.message.id
  }

  async followUp(input: RuntimeQueueControlInput): Promise<string> {
    this.assertBoundConversation(input.conversationId)
    this.assertCanStartTurn(input.conversationId)
    if (!this.turns.has(input.conversationId)) {
      throw new Error('cannot follow up while the session is idle')
    }
    const queued = this.createQueuedSessionInput(input.text)
    this.followUpQueue.push(queued)
    this.emitQueueUpdate()
    return queued.message.id
  }

  async nextTurn(input: RuntimeQueueControlInput): Promise<string> {
    this.assertBoundConversation(input.conversationId)
    this.assertCanStartTurn(input.conversationId)
    const queued = this.createQueuedSessionInput(input.text)
    this.nextTurnQueue.push(queued)
    this.emitQueueUpdate()
    return queued.message.id
  }

  getInputQueueState(): SessionInputQueueState {
    return {
      conversationId: this.conversationId,
      steering: this.steeringQueue.map((queued) => cloneRuntimePersistedMessage(queued.message)),
      followUp: this.followUpQueue.map((queued) => cloneRuntimePersistedMessage(queued.message)),
      nextTurn: this.nextTurnQueue.map((queued) => cloneRuntimePersistedMessage(queued.message)),
      steeringMode: this.steeringQueueMode,
      followUpMode: this.followUpQueueMode,
    }
  }

  clearInputQueue(): SessionInputQueueState {
    this.steeringQueue = []
    this.followUpQueue = []
    this.nextTurnQueue = []
    this.emitQueueUpdate()
    return this.getInputQueueState()
  }

  setSteeringMode(mode: SessionInputQueueMode): void {
    this.assertQueueMode(mode)
    this.steeringQueueMode = mode
    this.emitQueueUpdate()
  }

  setFollowUpMode(mode: SessionInputQueueMode): void {
    this.assertQueueMode(mode)
    this.followUpQueueMode = mode
    this.emitQueueUpdate()
  }

  async appendSessionCustomEntry(input: RuntimeAppendSessionCustomInput): Promise<string> {
    const entryId = this.createEventId()
    await this.appendOrQueueSessionWrite(input.conversationId, {
      type: 'extension.custom',
      entryId,
      timestamp: this.now(),
      data: {
        namespace: input.namespace,
        version: input.version,
        data: cloneRuntimeValue(input.data),
      },
    })
    return entryId
  }

  async appendSessionCustomMessage(input: RuntimeAppendSessionCustomMessageInput): Promise<string> {
    const entryId = this.createEventId()
    await this.appendOrQueueSessionWrite(input.conversationId, {
      type: 'extension.message',
      entryId,
      timestamp: this.now(),
      data: {
        namespace: input.namespace,
        version: input.version,
        message: cloneRuntimeValue(input.message),
      },
    })
    return entryId
  }

  async executeTool(input: RuntimeExecuteToolInput): Promise<string> {
    let record: ConversationRecord | undefined
    if (input.conversationId) {
      try {
        record = await this.getConversation(input.conversationId)
      } catch {
        record = undefined
      }
    }
    return this.services.executeTool(input, record)
  }

  async compactConversation(
    input: RuntimeCompactConversationInput,
  ): Promise<RuntimeCompactConversationResult> {
    return this.turns.withStartLock(input.conversationId, async () => {
      const { conversationId, selection } = input
      this.assertCanStartTurn(conversationId)
      if (this.turns.has(conversationId)) {
        throw new Error('cannot compact while assistant turn is running')
      }
      await this.requireIdleSession(conversationId)
      await this.setSessionPhase(conversationId, 'compaction')
      try {
        const record = await this.getConversation(conversationId)
        const contextInput = {
          conversationId,
          record,
          selection,
          source: 'send' as const,
        }
        const [resolvedStableInstructions, hostTransientContext] = await Promise.all([
          this.resolveStableInstructions(contextInput),
          this.resolveTransientContext(contextInput),
        ])
        const context = assembleAgentContext({
          stableInstructions: resolvedStableInstructions,
          messages: cloneRuntimeValue(record.messages),
          modelInfo: await this.resolveModelInfo(selection),
          providerId: selection.providerId,
          dynamicContext: hostTransientContext,
          compactionCheckpoint: record.meta.context?.checkpoint,
        })
        const manualMessageId = context.plan.compaction.recommendedCheckpoint?.boundaryMessageId
        const contextPlan = await this.applyContextTokenPreflight({
          conversationId,
          assistantMessageId: manualMessageId ?? `compact:${this.createId()}`,
          selection,
          messages: context.messages,
          contextPlan: context.plan,
        })
        const recommended =
          contextPlan.compaction.recommendedCheckpoint ??
          recommendManualContextCheckpoint({
            stableInstructions: resolvedStableInstructions,
            messages: cloneRuntimeValue(record.messages),
            modelInfo: await this.resolveModelInfo(selection),
            providerId: selection.providerId,
            dynamicContext: hostTransientContext,
            compactionCheckpoint: record.meta.context?.checkpoint,
          })
        if (!recommended) {
          return {
            compacted: false,
            reason: 'nothing_to_compact',
            summary: cloneRuntimeConversationSummary(record.meta),
          }
        }

        const checkpoint = await this.persistContextCheckpoint({
          conversationId,
          messageId: recommended.boundaryMessageId,
          record,
          selection,
          contextPlan,
          recommended,
          reason: contextPlan.compaction.reason ?? 'manual',
          trigger: 'manual',
        })
        if (!checkpoint) {
          return {
            compacted: false,
            reason: 'nothing_to_compact',
            summary: cloneRuntimeConversationSummary(record.meta),
          }
        }
        const nextRecord = await this.getConversation(conversationId)
        return {
          compacted: true,
          summary: cloneRuntimeConversationSummary(nextRecord.meta),
          checkpoint: cloneRuntimeValue(checkpoint),
        }
      } finally {
        await this.flushPendingSessionWrites(conversationId)
        await this.setSessionPhase(conversationId, 'idle')
      }
    })
  }

  async send(input: RuntimeSendInput): Promise<RuntimeSendResult> {
    return this.turns.withStartLock(input.conversationId, async (turnStartLock) => {
      const { conversationId, userText, selection, attachments, transientContext } = input
      const mode = normalizeAilaExecutionMode(input.mode)

      this.assertCanStartTurn(conversationId)

      // Wait for any prior stream on this conversation to finish its persistence
      // side-effects before appending the next user message.
      const previous = this.turns.get(conversationId)
      if (previous) await this.waitForPriorStreamBeforeNextTurn(conversationId, previous)
      this.assertCanStartTurn(conversationId)
      await this.drainQueuedInputs('nextTurn')
      this.assertCanStartTurn(conversationId)

      const blocks: PersistedBlock[] = [
        { type: 'text', content: userText },
        ...(await this.persistAttachments(conversationId, attachments ?? [])),
      ]

      const userMessage: PersistedMessage = {
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: this.createId(),
        role: 'user',
        blocks,
        status: 'done',
      }
      if (!(await this.persistAndAnnounce(conversationId, userMessage))) {
        this.assertConversationOpen(conversationId)
        throw new Error('conversation was deleted')
      }
      this.assertCanStartTurn(conversationId)

      const record = await this.getConversation(conversationId)
      this.assertCanStartTurn(conversationId)
      return this.startAssistantTurn({
        conversationId,
        userMessage,
        record,
        selection,
        mode,
        loopMode: input.loopMode ?? 'continuous',
        transientContext,
        source: 'send',
        turnStartLock,
      })
    })
  }

  async retryLastUserMessage(input: RuntimeRetryLastInput): Promise<RuntimeSendResult> {
    return this.turns.withStartLock(input.conversationId, async (turnStartLock) => {
      const { conversationId, selection, transientContext } = input
      const mode = normalizeAilaExecutionMode(input.mode)

      this.assertCanStartTurn(conversationId)
      const previous = this.turns.get(conversationId)
      if (previous) await this.waitForPriorStreamBeforeNextTurn(conversationId, previous)
      this.assertCanStartTurn(conversationId)

      const record = await this.getConversation(conversationId)
      this.assertCanStartTurn(conversationId)
      const retry = resolveRetryTurn(record)

      const hasRetryableContent = retry.userMessage.blocks.some((block) =>
        block.type === 'text'
          ? block.content.trim().length > 0
          : block.type === 'image' || block.type === 'file',
      )
      if (!hasRetryableContent) {
        throw new Error('cannot retry: last persisted user message has no content')
      }

      return this.startAssistantTurn({
        conversationId,
        userMessage: retry.userMessage,
        record: retry.record,
        selection,
        mode,
        loopMode: input.loopMode ?? 'continuous',
        transientContext,
        source: 'retry',
        turnStartLock,
      })
    })
  }

  async stepRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult> {
    return this.resumeRun({ ...input, loopMode: 'step' })
  }

  async continueRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult> {
    return this.resumeRun({ ...input, loopMode: 'continuous' })
  }

  async abortRun(input: RuntimeRunControlInput): Promise<RunSnapshot> {
    const active = this.turns.get(input.conversationId)
    if (active) {
      if (active.run.runId !== input.runId) {
        throw new Error(`another run is active: ${active.run.runId}`)
      }
      await this.abort(input.conversationId)
    }
    const loaded = await this.store.getRunSnapshot(input.conversationId, input.runId)
    if (!loaded) {
      throw new Error(`agent run snapshot not found: ${input.conversationId}/${input.runId}`)
    }
    if (
      loaded.loop.state.status === 'completed' ||
      loaded.loop.state.status === 'failed' ||
      loaded.loop.state.status === 'cancelled'
    ) {
      return cloneRuntimeValue(loaded)
    }

    const timestamp = this.now()
    const snapshot = cloneRuntimeValue(loaded)
    snapshot.loop.state.status = 'cancelled'
    snapshot.loop.state.completedAt = timestamp
    snapshot.loop.state.currentStep = undefined
    snapshot.loop.state.nextAction = undefined
    snapshot.loop.state.wait = undefined
    snapshot.loop.state.error = 'user'
    snapshot.recovery = { strategy: 'automatic' }
    snapshot.updatedAt = timestamp
    await this.recordRunEvent({
      timestamp,
      conversationId: input.conversationId,
      messageId: snapshot.assistantMessageId,
      turnId: snapshot.identity.turnId,
      runId: snapshot.identity.runId,
      type: 'run.cancelled',
      data: { reason: 'user' },
    })
    const saved = cloneRuntimeValue(await this.store.saveRunSnapshot(snapshot))
    const record = await this.getConversation(input.conversationId)
    const currentAssistant = record.messages.find(
      (message) => message.id === saved.assistantMessageId && message.role === 'assistant',
    )
    await this.persistAndAnnounce(input.conversationId, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: saved.assistantMessageId,
      role: 'assistant',
      blocks: cloneRuntimeValue(currentAssistant?.blocks ?? []),
      status: 'error',
      error: 'Aborted',
      model: cloneRuntimeValue(saved.selection),
    })
    return saved
  }

  async forkRun(input: RuntimeForkRunInput): Promise<RunSnapshot> {
    this.assertCanStartTurn(input.conversationId)
    if (this.turns.has(input.conversationId)) {
      throw new Error('cannot fork a run while an assistant turn is running')
    }
    await this.requireIdleSession(input.conversationId)
    const sessionTree = await this.store.getSessionTree(input.conversationId)
    const source = await this.store.getRunSnapshot(input.conversationId, input.runId)
    if (!source) {
      throw new Error(`agent run snapshot not found: ${input.conversationId}/${input.runId}`)
    }
    if (source.loop.state.currentStep?.status === 'running') {
      throw new Error('cannot fork while a step is running')
    }
    const timestamp = this.now()
    const runId = this.createRunId()
    const assistantMessageId = this.createId()
    const originStepId =
      input.originStepId ?? source.loop.state.steps[source.loop.state.steps.length - 1]?.stepId
    const identity: RunIdentity = {
      conversationId: input.conversationId,
      turnId: source.identity.turnId,
      runId,
      parentRunId: source.identity.runId,
      ...(originStepId ? { originStepId } : {}),
    }
    const nextAction: RunNextAction = cloneRuntimeValue(
      source.loop.state.nextAction ?? { type: 'model', reason: 'resume' as const },
    )
    const snapshot: RunSnapshot = {
      ...cloneRuntimeValue(source),
      identity,
      assistantMessageId,
      loop: {
        state: {
          identity: cloneRuntimeValue(identity),
          mode: source.loop.state.mode,
          status: 'paused',
          startedAt: timestamp,
          steps: [],
          nextAction,
          wait: { reason: 'operator', detail: 'forked run is ready for inspection' },
        },
        nextStepIndex: 0,
        modelStepIndex: nextAction.type === 'tools' ? 1 : 0,
        completedToolBatches: source.loop.completedToolBatches,
        pendingToolCalls: cloneRuntimeValue(source.loop.pendingToolCalls),
      },
      sessionLeafId: sessionTree.leafId,
      contextRef: cloneRuntimeValue(source.contextRef),
      recovery: { strategy: 'automatic' },
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      throughSeq: source.throughSeq,
    }
    const saved = cloneRuntimeValue(await this.store.saveRunSnapshot(snapshot))
    const identityData = {
      parentRunId: source.identity.runId,
      ...(originStepId ? { originStepId } : {}),
    }
    await this.recordRunEvent({
      timestamp,
      conversationId: input.conversationId,
      messageId: assistantMessageId,
      turnId: identity.turnId,
      runId,
      type: 'run.started',
      data: { ...identityData, mode: source.loop.state.mode },
    })
    await this.recordRunEvent({
      timestamp,
      conversationId: input.conversationId,
      messageId: assistantMessageId,
      turnId: identity.turnId,
      runId,
      type: 'run.paused',
      data: {
        ...identityData,
        nextAction,
        wait: { reason: 'operator', detail: 'forked run is ready for inspection' },
      },
    })
    return saved
  }

  async resumeRun(input: RuntimeResumeRunInput): Promise<RuntimeSendResult> {
    return this.turns.withStartLock(input.conversationId, async (turnStartLock) => {
      this.assertCanStartTurn(input.conversationId)
      const previous = this.turns.get(input.conversationId)
      if (previous) {
        await this.waitForPriorStreamBeforeNextTurn(input.conversationId, previous)
      }
      this.assertCanStartTurn(input.conversationId)
      const loaded = await this.store.getRunSnapshot(input.conversationId, input.runId)
      if (!loaded) {
        throw new Error(`agent run snapshot not found: ${input.conversationId}/${input.runId}`)
      }
      const snapshot = cloneRuntimeValue(loaded)
      const sessionTree = await this.store.getSessionTree(input.conversationId)
      if (sessionTree.leafId !== snapshot.sessionLeafId) {
        throw new Error(
          `run belongs to session leaf ${snapshot.sessionLeafId}; current leaf is ${sessionTree.leafId}`,
        )
      }
      const interruptedStep = snapshot.loop.state.currentStep
      const recoveryTimestamp = Math.max(
        snapshot.updatedAt + 1,
        (interruptedStep?.startedAt ?? snapshot.updatedAt) + 1,
      )
      const resumed = prepareRunSnapshotForResume(snapshot, recoveryTimestamp)
      if (interruptedStep?.status === 'running') {
        await this.recordRunEvent({
          timestamp: recoveryTimestamp,
          conversationId: input.conversationId,
          messageId: snapshot.assistantMessageId,
          turnId: snapshot.identity.turnId,
          runId: snapshot.identity.runId,
          stepId: interruptedStep.stepId,
          type: 'step.cancelled',
          data: {
            kind: interruptedStep.kind,
            index: interruptedStep.index,
            attempt: interruptedStep.attempt,
            reason: 'interrupted_before_resume',
          },
        })
        await this.recordRunEvent({
          timestamp: recoveryTimestamp,
          conversationId: input.conversationId,
          messageId: snapshot.assistantMessageId,
          turnId: snapshot.identity.turnId,
          runId: snapshot.identity.runId,
          type: 'run.paused',
          data: {
            nextAction: cloneRuntimeValue(resumed.loop.state.nextAction),
            wait: cloneRuntimeValue(resumed.loop.state.wait),
          },
        })
      }
      const savedCheckpoint = cloneRuntimeValue(await this.store.saveRunSnapshot(resumed))
      const record = await this.getConversation(input.conversationId)
      const userMessage = record.messages.find(
        (message) => message.id === savedCheckpoint.identity.turnId,
      )
      if (!userMessage || userMessage.role !== 'user') {
        throw new Error(`run user message not found: ${savedCheckpoint.identity.turnId}`)
      }
      const resumeState = await this.loadRunResumeState(savedCheckpoint)

      const mode = savedCheckpoint.executionMode
      const assistantMessageId = savedCheckpoint.assistantMessageId
      const baseToolRegistry = await this.getToolRegistry({
        conversationId: input.conversationId,
        record,
      })
      const toolRegistry = filterRuntimeToolRegistryForMode(baseToolRegistry, mode)
      const toolContext = await this.buildToolContext({
        conversationId: input.conversationId,
        record,
        messageId: assistantMessageId,
        mode,
      })

      const controller = new AbortController()
      let resolveCleanup: () => void = () => {}
      const cleanup = new Promise<void>((resolve) => {
        resolveCleanup = resolve
      })
      await this.setSessionPhase(input.conversationId, 'turn')
      this.turns.set(input.conversationId, {
        controller,
        cleanup,
        assistantMessageId,
        run: cloneRuntimeValue(savedCheckpoint.identity),
        selection: cloneRuntimeValue(savedCheckpoint.selection),
        abortRecorded: false,
        cleanupInterruptedRecorded: false,
        turnStartLock,
      })

      void this.runStream({
        conversationId: input.conversationId,
        assistantMessageId,
        run: cloneRuntimeValue(savedCheckpoint.identity),
        selection: cloneRuntimeValue(savedCheckpoint.selection),
        controller,
        resolveCleanup,
        messages: cloneRuntimeChatMessages(resumeState.messages) ?? [],
        contextPlan: cloneRuntimeValue(resumeState.contextPlan),
        toolContext,
        toolRegistry,
        mode,
        loopMode: input.loopMode ?? 'continuous',
        runSnapshot: savedCheckpoint,
        sessionLeafId: savedCheckpoint.sessionLeafId,
        runContextRef: cloneRuntimeValue(savedCheckpoint.contextRef),
        resumeState,
      })

      return {
        userMessage: cloneRuntimeValue(userMessage),
        assistantMessageId,
        turnId: savedCheckpoint.identity.turnId,
        runId: savedCheckpoint.identity.runId,
      }
    })
  }

  private async loadRunResumeState(snapshot: RunSnapshot): Promise<{
    messages: ChatMessage[]
    contextPlan: AgentContextPlan
    assistantMessage?: PersistedMessage
    modelStepOutputs: Record<string, string>
  }> {
    const contextBlob = await this.store.getBlob(
      snapshot.identity.conversationId,
      snapshot.contextRef.blobId,
    )
    if (!contextBlob || !isRunContextBlobData(contextBlob.data)) {
      throw new Error(`run context blob not found: ${snapshot.contextRef.blobId}`)
    }

    const entries = await this.store.listSessionEntries(snapshot.identity.conversationId)
    const sourceRunId = snapshot.identity.parentRunId ?? snapshot.identity.runId
    let sourcePayloads = sessionRunPayloads(entries, sourceRunId)
    if (snapshot.identity.originStepId) {
      const boundarySeq = sourcePayloads
        .filter((entry) => entry.stepId === snapshot.identity.originStepId)
        .reduce((maximum, entry) => Math.max(maximum, entry.seq), 0)
      if (boundarySeq > 0)
        sourcePayloads = sourcePayloads.filter((entry) => entry.seq <= boundarySeq)
    }
    const ownPayloads =
      sourceRunId === snapshot.identity.runId
        ? []
        : sessionRunPayloads(entries, snapshot.identity.runId)
    const payloads = [...sourcePayloads, ...ownPayloads].sort((left, right) => left.seq - right.seq)
    const messages = cloneRuntimeChatMessages(contextBlob.data.messages) ?? []
    const modelStepOutputs: Record<string, string> = {}
    let assistantMessage: PersistedMessage | undefined

    for (const payload of payloads) {
      if (payload.data.modelMessage) {
        messages.push(cloneRuntimeValue(payload.data.modelMessage))
      }
      if (payload.data.assistantMessage) {
        assistantMessage = {
          ...cloneRuntimeValue(payload.data.assistantMessage),
          id: snapshot.assistantMessageId,
          status: 'streaming',
          error: undefined,
        }
      }
      if (payload.data.kind !== 'provider_response' || !payload.payloadRef) continue
      const blob = await this.store.getBlob(
        snapshot.identity.conversationId,
        payload.payloadRef.blobId,
      )
      if (!blob?.data || typeof blob.data !== 'object') continue
      const data = blob.data as Record<string, unknown>
      if (typeof data.modelStepIndex === 'number' && typeof data.text === 'string') {
        modelStepOutputs[String(data.modelStepIndex)] = data.text
      }
    }

    return {
      messages,
      contextPlan: cloneRuntimeValue(contextBlob.data.contextPlan),
      ...(assistantMessage ? { assistantMessage } : {}),
      modelStepOutputs,
    }
  }

  private async startAssistantTurn(input: {
    conversationId: string
    userMessage: PersistedMessage
    record: ConversationRecord
    selection: ModelSelection
    mode: AilaExecutionMode
    loopMode?: 'continuous' | 'step'
    transientContext?: ChatMessage[]
    source: RuntimeTransientContextInput['source']
    turnStartLock: TurnStartLock
  }): Promise<RuntimeSendResult> {
    const {
      conversationId,
      userMessage,
      record,
      mode,
      loopMode = 'continuous',
      transientContext,
      source,
      turnStartLock,
    } = input
    const selection = cloneRuntimeValue(input.selection)
    const assistantMessageId = this.createId()
    const run: RunIdentity = {
      conversationId,
      turnId: userMessage.id,
      runId: this.createRunId(),
    }
    this.assertCanStartTurn(conversationId)
    await this.setSessionPhase(conversationId, source === 'retry' ? 'retry' : 'turn')

    const controller = new AbortController()
    let resolveCleanup: () => void = () => {}
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve
    })
    this.turns.set(conversationId, {
      controller,
      cleanup,
      assistantMessageId,
      run,
      selection,
      abortRecorded: false,
      cleanupInterruptedRecorded: false,
      turnStartLock,
    })

    let streamStarted = false
    let messages: ChatMessage[]
    let contextPlan: AgentContextPlan
    let runContextRef: BlobRef
    let sessionLeafId: string
    let toolContext: ToolContext
    let toolRegistry: ToolRegistry
    try {
      if (!this.host.runAgent) throw new Error('runtime host cannot execute agent runs')
      const contextInput = {
        conversationId,
        record,
        selection,
        source,
        mode,
      }
      const inputTransientContext = cloneRuntimeChatMessages(transientContext)
      const [resolvedStableInstructions, hostTransientContext] = await Promise.all([
        this.resolveStableInstructions(contextInput),
        inputTransientContext === undefined
          ? this.resolveTransientContext(contextInput)
          : Promise.resolve(undefined),
      ])
      const resolvedDynamicContext = inputTransientContext ?? hostTransientContext
      const context = assembleAgentContext({
        stableInstructions: resolvedStableInstructions,
        messages: cloneRuntimeValue(record.messages),
        modelInfo: await this.resolveModelInfo(selection),
        providerId: selection.providerId,
        dynamicContext: resolvedDynamicContext,
        compactionCheckpoint: record.meta.context?.checkpoint,
      })
      messages = context.messages
      contextPlan = await this.applyContextTokenPreflight({
        conversationId,
        assistantMessageId,
        selection,
        messages,
        contextPlan: context.plan,
      })
      await this.persistRecommendedContextCheckpoint({
        conversationId,
        assistantMessageId,
        record,
        selection,
        contextPlan,
      })
      sessionLeafId = (await this.store.getSessionTree(conversationId)).leafId
      runContextRef = await this.store.putBlob(conversationId, {
        blobId: `run-context:${run.runId}`,
        contentType: 'application/json',
        data: {
          messages: cloneRuntimeChatMessages(messages) ?? [],
          contextPlan: cloneRuntimeValue(contextPlan),
        } satisfies RunContextBlobData,
      })
      const baseToolRegistry = await this.getToolRegistry({ conversationId, record })
      toolRegistry = filterRuntimeToolRegistryForMode(baseToolRegistry, mode)
      toolContext = await this.buildToolContext({
        conversationId,
        record,
        messageId: assistantMessageId,
        mode,
      })
      if (!this.acceptsStreamEvents(conversationId, controller)) {
        return { userMessage, assistantMessageId, turnId: run.turnId, runId: run.runId }
      }
      if (controller.signal.aborted) {
        await this.persistSetupCancellation(conversationId, assistantMessageId, run, selection)
        return { userMessage, assistantMessageId, turnId: run.turnId, runId: run.runId }
      }
      this.assertCanStartTurn(conversationId)
      streamStarted = true
    } catch (error) {
      if (controller.signal.aborted) {
        await this.persistSetupCancellation(conversationId, assistantMessageId, run, selection)
      } else {
        await this.persistSetupFailure(
          conversationId,
          assistantMessageId,
          run,
          selection,
          errorMessage(error),
        )
      }
      this.assertConversationOpen(conversationId)
      return { userMessage, assistantMessageId, turnId: run.turnId, runId: run.runId }
    } finally {
      if (!streamStarted) {
        await this.flushPendingSessionWrites(conversationId).catch((error) => {
          this.logger.warn('[runtime] pending session write flush failed:', error)
        })
        await this.setSessionPhase(conversationId, 'idle').catch((error) => {
          this.logger.warn('[runtime] idle phase persistence failed:', error)
        })
        this.turns.deleteWhere(conversationId, (turn) => turn.controller === controller)
        resolveCleanup()
      }
    }

    void this.runStream({
      conversationId,
      assistantMessageId,
      run,
      selection,
      controller,
      resolveCleanup,
      messages,
      contextPlan,
      toolContext,
      toolRegistry,
      mode,
      loopMode,
      sessionLeafId,
      runContextRef,
    })

    return { userMessage, assistantMessageId, turnId: run.turnId, runId: run.runId }
  }

  async abort(conversationId: string): Promise<void> {
    this.assertBoundConversation(conversationId)
    this.clearActiveInputQueues()
    const slot = this.turns.get(conversationId)
    if (!slot) return
    slot.controller.abort()
    const abortCleanup = this.notifyConversationAbort(conversationId, 'user')
    await this.recordCancellationRequest(conversationId, slot, 'user')
    await abortCleanup
    try {
      await this.waitForAbortedStreamCleanup(conversationId, slot, 'user cleanup timed out')
    } catch (err) {
      this.logger.warn('[runtime] interrupted abort activity append failed:', err)
    }
  }

  listActiveTurns(): ActiveAssistantTurn[] {
    return this.listActiveStreams()
  }

  resetRecoveredPhase(): void {
    this.sessionPhase = undefined
  }

  async waitForIdle(conversationId: string): Promise<void> {
    this.assertBoundConversation(conversationId)
    await this.turns.get(conversationId)?.cleanup
  }

  listActiveStreams(): ActiveAssistantTurn[] {
    return this.turns.entries().map(([conversationId, slot]) => ({
      conversationId,
      assistantMessageId: slot.assistantMessageId,
      turnId: slot.run.turnId,
      runId: slot.run.runId,
      selection: cloneRuntimeValue(slot.selection),
    }))
  }

  async abortAll(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    this.clearActiveInputQueues()
    const cleanupTimeoutMs =
      this.options.abortAllCleanupTimeoutMs ?? DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS
    await Promise.all(
      this.turns.entries().map(async ([conversationId, slot]) => {
        slot.controller.abort()
        const abortCleanup = this.notifyConversationAbort(conversationId, reason)
        await this.recordCancellationRequest(conversationId, slot, reason)
        await abortCleanup
        try {
          await this.waitForAbortedStreamCleanup(
            conversationId,
            slot,
            `${reason} cleanup timed out`,
            cleanupTimeoutMs,
          )
        } catch (err) {
          this.logger.warn('[runtime] interrupted shutdown activity append failed:', err)
        }
      }),
    )
  }

  shutdown(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    this.shutdownStarted = true
    if (!this.shutdownPromise) this.shutdownPromise = this.abortAll(reason)
    return this.shutdownPromise
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.assertBoundConversation(conversationId)
    this.deleted = true
    this.clearActiveInputQueues()
    let removed = false
    const slot = this.turns.get(conversationId)
    let streamCleanupTimedOut = false
    try {
      if (slot) {
        slot.controller.abort()
        await this.notifyConversationAbort(conversationId, 'delete')
        const cleanedUp = await this.waitForStreamCleanup(
          slot,
          this.options.abortAllCleanupTimeoutMs ?? DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS,
        )
        streamCleanupTimedOut = !cleanedUp
        if (!cleanedUp) {
          this.turns.clearTimedOut(conversationId, slot)
        }
      } else {
        await this.notifyConversationAbort(conversationId, 'delete')
      }

      await this.cleanupConversationAssets(conversationId)

      await this.store.deleteConversation(conversationId)
      this.sessionPhase = undefined
      this.pendingSessionWrites = []
      this.nextTurnQueue = []
      this.emitQueueUpdate()
      removed = true
    } catch (error) {
      this.deleted = false
      if (slot) {
        try {
          await this.recordCancellationRequest(conversationId, slot, 'delete')
          if (streamCleanupTimedOut) {
            await this.recordInterruptedStreamCleanup(
              conversationId,
              slot,
              'delete cleanup timed out',
            )
          }
        } catch (err) {
          this.logger.warn('[runtime] delete failure activity append failed:', err)
        }
      }
      throw error
    } finally {
      if (!removed) this.deleted = false
    }
  }

  private async persistAndAnnounce(
    conversationId: string,
    message: PersistedMessage,
  ): Promise<boolean> {
    if (this.deleted) return false
    const appended = await this.store.appendSessionEntry(conversationId, {
      type: 'message.committed',
      timestamp: this.now(),
      data: { message: cloneRuntimePersistedMessage(message) },
    })
    const summary = cloneRuntimeConversationSummary(appended.summary)
    if (this.deleted) return false
    this.emit(createWorkbenchEvent('conversations:updated', summary))
    return true
  }

  private async persistAttachments(
    conversationId: string,
    attachments: readonly ChatAttachmentInput[],
  ): Promise<RuntimeAttachmentBlock[]> {
    const blocks: RuntimeAttachmentBlock[] = []
    for (const attachment of attachments) {
      const input = cloneRuntimeValue({ ...attachment, conversationId })
      if (this.host.persistAttachment) {
        blocks.push(
          assertRuntimeAttachmentBlock(cloneRuntimeValue(await this.host.persistAttachment(input))),
        )
      } else if (input.kind === 'text') {
        blocks.push({ type: 'file', name: input.name, content: input.data })
      } else {
        throw new Error('runtime host cannot persist image attachments')
      }
    }
    return blocks
  }

  private async persistSetupFailure(
    conversationId: string,
    assistantMessageId: string,
    run: RunIdentity,
    selection: ModelSelection,
    message: string,
  ): Promise<void> {
    const errored: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: assistantMessageId,
      role: 'assistant',
      blocks: [],
      status: 'error',
      error: message,
      model: selection,
    }
    const persisted = await this.persistAndAnnounce(conversationId, errored)
    if (!persisted) return
    try {
      await this.recordRunEvent(
        withTurnSelection(
          {
            timestamp: this.now(),
            conversationId,
            messageId: assistantMessageId,
            turnId: run.turnId,
            runId: run.runId,
            eventId: this.createEventId(),
            type: 'turn.failed',
            data: { phase: 'setup', error: message },
          },
          selection,
        ),
      )
    } catch (error) {
      this.logger.warn('[runtime] setup failure activity append failed:', error)
    }
    if (this.deleted) return
    this.emit(
      createWorkbenchEvent('chat:error', {
        conversationId,
        messageId: assistantMessageId,
        error: message,
        message: errored,
      }),
    )
  }

  private async persistSetupCancellation(
    conversationId: string,
    assistantMessageId: string,
    run: RunIdentity,
    selection: ModelSelection,
  ): Promise<void> {
    const errored: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: assistantMessageId,
      role: 'assistant',
      blocks: [],
      status: 'error',
      error: 'Aborted',
      model: selection,
    }
    const persisted = await this.persistAndAnnounce(conversationId, errored)
    if (!persisted) return
    try {
      await this.recordRunEvent(
        withTurnSelection(
          {
            timestamp: this.now(),
            conversationId,
            messageId: assistantMessageId,
            turnId: run.turnId,
            runId: run.runId,
            eventId: this.createEventId(),
            type: 'turn.cancelled',
            data: { phase: 'completed', reason: 'abort_signal' },
          },
          selection,
        ),
      )
    } catch (error) {
      this.logger.warn('[runtime] setup cancellation activity append failed:', error)
    }
    if (this.deleted) return
    this.emit(
      createWorkbenchEvent('chat:error', {
        conversationId,
        messageId: assistantMessageId,
        error: 'Aborted',
        message: errored,
      }),
    )
  }

  private emit(event: WorkbenchEvent): void {
    this.services.emit(event)
    this.onSessionEvent?.(cloneRuntimeValue(event))
  }

  private emitStreamEvent(
    conversationId: string,
    controller: AbortController,
    event: WorkbenchEvent,
  ): void {
    if (!this.acceptsStreamEvents(conversationId, controller)) return
    this.emit(event)
  }

  async recordRunEvent(event: RuntimeRecordRunEventInput): Promise<boolean> {
    return (await this.recordRunEventWithResult(event)) !== null
  }

  private async recordRunEventWithResult(
    event: RuntimeRecordRunEventInput,
  ): Promise<RunEventAppendResult | null> {
    if (this.deleted) return null
    const appended = await this.store.appendSessionEntry(event.conversationId, {
      type: 'run.event',
      timestamp: event.timestamp,
      entryId: event.eventId,
      turnId: event.turnId,
      runId: event.runId,
      stepId: event.stepId,
      data: { event: cloneRuntimeValue(event) },
    })
    if (appended.entry.type !== 'run.event') throw new Error('invalid run event journal append')
    const result: RunEventAppendResult = {
      event: cloneRuntimeValue(appended.entry.data.event) as PersistedRunEvent,
      summary: cloneRuntimeConversationSummary(appended.summary),
    }
    if (this.deleted) return null
    const { event: persisted, summary } = result
    this.emit(createWorkbenchEvent('run:event', persisted))
    if (summary) this.emit(createWorkbenchEvent('conversations:updated', summary))
    return result
  }

  private async resolveModelInfo(selection: ModelSelection): Promise<ModelInfo> {
    const resolved = await this.host.getModelInfo?.(cloneRuntimeValue(selection))
    const modelInfo = cloneRuntimeValue(
      resolved ?? { ...FALLBACK_MODEL_CONTEXT, model: selection.modelId },
    )
    return {
      model: typeof modelInfo.model === 'string' ? modelInfo.model : selection.modelId,
      contextLength:
        typeof modelInfo.contextLength === 'number' && modelInfo.contextLength > 0
          ? modelInfo.contextLength
          : null,
    }
  }

  private async buildToolContext(input: RuntimeToolContextInput): Promise<ToolContext> {
    return this.services.buildToolContext(input)
  }

  private async resolveTransientContext(
    input: RuntimeTransientContextInput,
  ): Promise<ChatMessage[] | undefined> {
    if (!this.host.loadTransientContext) return undefined
    return cloneRuntimeChatMessages(
      await this.host.loadTransientContext({
        ...input,
        record: cloneRuntimeConversationRecord(input.record),
        selection: cloneRuntimeValue(input.selection),
      }),
    )
  }

  private async resolveStableInstructions(
    input: RuntimeStableInstructionsInput,
  ): Promise<ChatMessage[] | undefined> {
    if (!this.host.loadStableInstructions) return undefined
    return cloneRuntimeChatMessages(
      await this.host.loadStableInstructions({
        ...input,
        record: cloneRuntimeConversationRecord(input.record),
        selection: cloneRuntimeValue(input.selection),
      }),
    )
  }

  private cleanupTimeoutMs(): number {
    return this.options.abortAllCleanupTimeoutMs ?? DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS
  }

  private assertBoundConversation(conversationId: string): void {
    if (conversationId !== this.conversationId) {
      throw new Error(
        `session runtime is bound to ${this.conversationId}, received ${conversationId}`,
      )
    }
  }

  private assertQueueMode(mode: SessionInputQueueMode): void {
    if (mode !== 'one-at-a-time' && mode !== 'all') {
      throw new Error(`invalid session input queue mode: ${String(mode)}`)
    }
  }

  private createQueuedSessionInput(text: string): QueuedSessionInput {
    if (!text.trim()) throw new Error('queued input text is required')
    const message: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: this.createId(),
      role: 'user',
      blocks: [{ type: 'text', content: text }],
      status: 'done',
    }
    return {
      message,
      chatMessage: { role: 'user', content: text },
    }
  }

  private emitQueueUpdate(): void {
    this.emit(createWorkbenchEvent('session:queue-updated', this.getInputQueueState()))
  }

  private clearActiveInputQueues(): void {
    if (this.steeringQueue.length === 0 && this.followUpQueue.length === 0) return
    this.steeringQueue = []
    this.followUpQueue = []
    this.emitQueueUpdate()
  }

  private async drainQueuedInputs(
    kind: 'steering' | 'followUp' | 'nextTurn',
    onPersisted?: (input: { lastSeq: number; sessionLeafId: string }) => void,
  ): Promise<ChatMessage[]> {
    const queue =
      kind === 'steering'
        ? this.steeringQueue
        : kind === 'followUp'
          ? this.followUpQueue
          : this.nextTurnQueue
    const mode =
      kind === 'steering'
        ? this.steeringQueueMode
        : kind === 'followUp'
          ? this.followUpQueueMode
          : 'all'
    const count = mode === 'all' ? queue.length : Math.min(1, queue.length)
    if (count === 0) return []
    const drained = queue.splice(0, count)
    try {
      let lastSeq = 0
      for (const queued of drained) {
        const appended = await this.store.appendSessionEntry(this.conversationId, {
          type: 'message.committed',
          entryId: `queued-message:${queued.message.id}`,
          timestamp: this.now(),
          data: { message: cloneRuntimePersistedMessage(queued.message) },
        })
        lastSeq = Math.max(lastSeq, appended.entry.seq)
        this.emit(
          createWorkbenchEvent(
            'conversations:updated',
            cloneRuntimeConversationSummary(appended.summary),
          ),
        )
      }
      const sessionLeafId = (await this.store.getSessionTree(this.conversationId)).leafId
      onPersisted?.({ lastSeq, sessionLeafId })
      this.emitQueueUpdate()
      return drained.map((queued) => cloneRuntimeValue(queued.chatMessage))
    } catch (error) {
      queue.unshift(...drained)
      this.emitQueueUpdate()
      throw error
    }
  }

  private assertConversationOpen(conversationId: string): void {
    this.assertBoundConversation(conversationId)
    if (this.deleted) {
      throw new Error('conversation was deleted')
    }
  }

  private assertCanStartTurn(conversationId: string): void {
    if (this.shutdownStarted) throw new Error('runtime is shut down')
    this.assertConversationOpen(conversationId)
  }

  private async setSessionPhase(conversationId: string, phase: SessionPhase): Promise<number> {
    const previous = this.sessionPhase
    this.sessionPhase = phase
    try {
      const appended = await this.store.appendSessionEntry(conversationId, {
        type: 'session.phase.changed',
        timestamp: this.now(),
        data: { phase },
      })
      return appended.entry.seq
    } catch (error) {
      this.sessionPhase = previous
      throw error
    }
  }

  private async requireIdleSession(conversationId: string): Promise<void> {
    const tree = await this.store.getSessionTree(conversationId)
    if (tree.phase !== 'idle') {
      throw new Error(
        `session structural operation requires idle phase; current phase is ${tree.phase}`,
      )
    }
  }

  private async appendOrQueueSessionWrite(
    conversationId: string,
    entry: SessionEntryInput,
  ): Promise<void> {
    this.assertCanStartTurn(conversationId)
    const phase = this.sessionPhase ?? (await this.store.getSessionTree(conversationId)).phase
    if (phase === 'idle') {
      await this.store.appendSessionEntry(conversationId, cloneRuntimeValue(entry))
      return
    }
    this.pendingSessionWrites.push(cloneRuntimeValue(entry))
  }

  private async flushPendingSessionWrites(conversationId: string): Promise<number | null> {
    const pending = this.pendingSessionWrites
    if (pending.length === 0) return null
    this.pendingSessionWrites = []
    let lastSeq: number | null = null
    for (let index = 0; index < pending.length; index += 1) {
      try {
        const appended = await this.store.appendSessionEntry(
          conversationId,
          cloneRuntimeValue(pending[index] as SessionEntryInput),
        )
        lastSeq = appended.entry.seq
      } catch (error) {
        this.pendingSessionWrites = pending.slice(index).map((entry) => cloneRuntimeValue(entry))
        throw error
      }
    }
    return lastSeq
  }

  private async waitForPriorStreamBeforeNextTurn(
    conversationId: string,
    slot: StreamSlot,
  ): Promise<void> {
    if (!slot.controller.signal.aborted) {
      await slot.cleanup.catch(() => {})
      return
    }

    const cleanedUp = await this.waitForStreamCleanup(slot, this.cleanupTimeoutMs())
    if (cleanedUp) return

    this.turns.clearTimedOut(conversationId, slot)
    await this.recordInterruptedStreamCleanup(conversationId, slot, 'aborted cleanup timed out')
  }

  private async waitForAbortedStreamCleanup(
    conversationId: string,
    slot: StreamSlot,
    interruptedReason: string,
    timeoutMs = this.cleanupTimeoutMs(),
  ): Promise<void> {
    const cleanedUp = await this.waitForStreamCleanup(slot, timeoutMs)
    if (cleanedUp) return

    this.turns.clearTimedOut(conversationId, slot)
    await this.recordInterruptedStreamCleanup(conversationId, slot, interruptedReason)
  }

  private async recordCancellationRequest(
    conversationId: string,
    slot: StreamSlot,
    reason: ConversationAbortReason,
  ): Promise<void> {
    if (slot.abortRecorded) return
    slot.abortRecorded = true
    try {
      await this.recordRunEvent(
        withTurnSelection(
          {
            timestamp: this.now(),
            conversationId,
            messageId: slot.assistantMessageId,
            turnId: slot.run.turnId,
            runId: slot.run.runId,
            eventId: this.createEventId(),
            type: 'turn.cancelled',
            data: { phase: 'requested', reason },
          },
          slot.selection,
        ),
      )
    } catch (err) {
      this.logger.warn('[runtime] cancellation activity append failed:', err)
    }
  }

  private async recordInterruptedStreamCleanup(
    conversationId: string,
    slot: StreamSlot,
    reason: string,
  ): Promise<void> {
    if (slot.cleanupInterruptedRecorded) return
    slot.cleanupInterruptedRecorded = true
    await this.recordRunEvent(
      withTurnSelection(
        {
          timestamp: this.now(),
          conversationId,
          messageId: slot.assistantMessageId,
          turnId: slot.run.turnId,
          runId: slot.run.runId,
          eventId: this.createEventId(),
          type: 'turn.interrupted',
          data: {
            reason,
            previousState: 'cancelled',
            previousEventType: 'turn.cancelled',
            previousTitle: 'Stop requested',
          },
        },
        slot.selection,
      ),
    )
  }

  private acceptsStreamEvents(conversationId: string, controller: AbortController): boolean {
    if (this.deleted) return false
    return this.turns.get(conversationId)?.controller === controller
  }

  private async notifyConversationAbort(
    conversationId: string,
    reason: ConversationAbortReason,
  ): Promise<void> {
    try {
      await this.host.onConversationAbort?.(conversationId, reason)
    } catch (error) {
      this.logger.warn('[runtime] conversation abort cleanup failed:', error)
    }
  }

  private async cleanupConversationAssets(conversationId: string): Promise<void> {
    if (!this.host.cleanupConversationAssets) return
    try {
      const record = await this.store.getConversation(conversationId)
      await this.host.cleanupConversationAssets(cloneRuntimeConversationRecord(record))
    } catch (err) {
      this.logger.warn('[runtime] conversation asset cleanup failed:', err)
    }
  }

  private async waitForStreamCleanup(slot: StreamSlot, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        slot.cleanup.catch(() => {}).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async applyContextTokenPreflight(
    input: RuntimeContextTokenCountInput,
  ): Promise<AgentContextPlan> {
    if (!this.host.countContextTokens) return input.contextPlan
    try {
      const counted = await this.host.countContextTokens({
        ...input,
        selection: cloneRuntimeValue(input.selection),
        messages: cloneRuntimeChatMessages(input.messages) ?? [],
        contextPlan: cloneRuntimeValue(input.contextPlan),
      })
      if (!counted || typeof counted.inputTokens !== 'number' || counted.inputTokens < 0) {
        return input.contextPlan
      }
      const preflight: AgentContextTokenPreflight = {
        inputTokens: counted.inputTokens,
        method: counted.method ?? 'provider_preflight',
        providerId: counted.providerId ?? input.selection.providerId,
        model: counted.model ?? input.selection.modelId,
        countedAt: this.now(),
      }
      return applyAgentContextTokenPreflight(input.contextPlan, preflight)
    } catch (error) {
      this.logger.warn('[runtime] context token preflight failed:', error)
      return input.contextPlan
    }
  }

  private async resolveSemanticCompactArtifact(input: {
    conversationId: string
    record: ConversationRecord
    selection: ModelSelection
    recommended: AgentContextRecommendedCheckpoint
  }): Promise<RuntimeSemanticCompactArtifact> {
    const heuristic = (
      fallbackReason: RuntimeCompactArtifactFallbackReason,
    ): RuntimeSemanticCompactArtifact => ({
      artifact: cloneRuntimeValue(input.recommended.artifact),
      summary: input.recommended.summary,
      source: 'heuristic',
      fallbackReason,
    })

    if (!this.host.generateContextCompactArtifact) {
      return heuristic('missing_hook')
    }
    try {
      const sourceIdSet = new Set(input.recommended.sourceMessageIds)
      const generated = await this.host.generateContextCompactArtifact({
        conversationId: input.conversationId,
        selection: cloneRuntimeValue(input.selection),
        activeCheckpoint: cloneRuntimeValue(input.record.meta.context?.checkpoint),
        recommendedCheckpoint: cloneRuntimeValue(input.recommended),
        sourceMessages: cloneRuntimeValue(
          input.record.messages.filter((message) => sourceIdSet.has(message.id)),
        ),
      })
      if (!generated) return heuristic('empty_result')
      const artifact = normalizeConversationCompactArtifact(generated?.artifact)
      if (!artifact) {
        return heuristic('invalid_artifact')
      }
      const summary =
        typeof generated?.summary === 'string' && generated.summary.trim().length > 0
          ? generated.summary.trim()
          : artifact.summary || input.recommended.summary
      return { artifact, summary, source: 'model' }
    } catch (error) {
      this.logger.warn('[runtime] semantic context compact artifact generation failed:', error)
      return heuristic('error')
    }
  }

  private async persistRecommendedContextCheckpoint(input: {
    conversationId: string
    assistantMessageId: string
    record: ConversationRecord
    selection: ModelSelection
    contextPlan: AgentContextPlan
  }): Promise<void> {
    const { conversationId, assistantMessageId, record, selection, contextPlan } = input
    const recommended = contextPlan.compaction.recommendedCheckpoint
    if (!recommended) return
    await this.persistContextCheckpoint({
      conversationId,
      messageId: assistantMessageId,
      record,
      selection,
      contextPlan,
      recommended,
    })
  }

  private async persistContextCheckpoint(input: {
    conversationId: string
    messageId: string
    record: ConversationRecord
    selection: ModelSelection
    contextPlan: AgentContextPlan
    recommended: AgentContextRecommendedCheckpoint
    reason?: string | null
    trigger?: 'auto' | 'manual'
  }): Promise<ConversationContextCheckpoint | null> {
    const { conversationId, messageId, record, selection, contextPlan, recommended } = input
    await this.recordContextCompactionEvent({
      conversationId,
      messageId,
      selection,
      type: 'context:compacting',
      contextPlan,
      recommended,
      reason: input.reason ?? contextPlan.compaction.reason,
      trigger: input.trigger ?? 'auto',
    })
    const semantic = await this.resolveSemanticCompactArtifact({
      conversationId,
      record,
      selection,
      recommended,
    })
    const checkpoint: ConversationContextCheckpoint = {
      schemaVersion: AILA_CONTEXT_CHECKPOINT_SCHEMA_VERSION,
      id: recommended.id,
      createdAt: this.now(),
      boundaryMessageId: recommended.boundaryMessageId,
      sourceMessageIds: cloneRuntimeValue(recommended.sourceMessageIds),
      omittedRoundCount: recommended.omittedRoundCount,
      summary: semantic.summary,
      charCost: JSON.stringify([{ role: 'system', content: semantic.summary }]).length,
      artifact: cloneRuntimeValue(semantic.artifact),
    }
    try {
      const appended = await this.store.appendSessionEntry(conversationId, {
        type: 'context.compacted',
        timestamp: checkpoint.createdAt,
        data: { checkpoint: cloneRuntimeValue(checkpoint) },
      })
      const summary = cloneRuntimeConversationSummary(appended.summary)
      this.emit(createWorkbenchEvent('conversations:updated', summary))
      await this.recordContextCompactionEvent({
        conversationId,
        messageId,
        selection,
        type: 'context:compacted',
        contextPlan,
        recommended,
        checkpoint,
        semantic,
        reason: input.reason ?? contextPlan.compaction.reason,
        trigger: input.trigger ?? 'auto',
      })
      return checkpoint
    } catch (error) {
      this.logger.warn('[runtime] context checkpoint persistence failed:', error)
      return null
    }
  }

  private async recordContextCompactionEvent(input: {
    conversationId: string
    messageId: string
    selection: ModelSelection
    type: 'context:compacting' | 'context:compacted'
    contextPlan: AgentContextPlan
    recommended: AgentContextRecommendedCheckpoint
    checkpoint?: ConversationContextCheckpoint
    semantic?: RuntimeSemanticCompactArtifact
    reason?: string | null
    trigger?: 'auto' | 'manual'
  }): Promise<void> {
    const { conversationId, messageId, selection, type, contextPlan, recommended } = input
    const charsPerToken =
      contextPlan.ledger.estimator.charsPerToken > 0
        ? contextPlan.ledger.estimator.charsPerToken
        : 4
    const checkpointCharCost = input.checkpoint?.charCost ?? recommended.charCost
    const checkpointEstimatedTokens = Math.max(0, Math.ceil(checkpointCharCost / charsPerToken))
    const estimatedSavedTokens = Math.max(
      0,
      recommended.sourceEstimatedTokens - checkpointEstimatedTokens,
    )
    try {
      await this.recordRunEvent({
        timestamp: this.now(),
        conversationId,
        messageId,
        type,
        data: {
          providerId: selection.providerId,
          modelId: selection.modelId,
          checkpointId: recommended.id,
          activeCheckpointId: contextPlan.compaction.activeCheckpointId,
          boundaryMessageId: recommended.boundaryMessageId,
          reason: input.reason ?? contextPlan.compaction.reason,
          trigger: input.trigger ?? 'auto',
          omittedRoundCount: recommended.omittedRoundCount,
          sourceMessageCount: recommended.sourceMessageIds.length,
          selectedRoundCount: contextPlan.compaction.selectedRoundCount,
          sourceCharCost: recommended.sourceCharCost,
          sourceEstimatedTokens: recommended.sourceEstimatedTokens,
          checkpointCharCost,
          checkpointEstimatedTokens,
          estimatedSavedTokens,
          estimatedInputTokens: contextPlan.ledger.totalEstimatedTokens,
          inputBudgetTokens: contextPlan.ledger.inputBudgetTokens,
          remainingInputTokens:
            contextPlan.budget.remainingPreflightInputTokens ??
            contextPlan.ledger.remainingInputTokens,
          ...(contextPlan.ledger.preflight
            ? { preflightInputTokens: contextPlan.ledger.preflight.inputTokens }
            : {}),
          ...(input.checkpoint
            ? {
                compactArtifactSource: input.semantic?.source ?? 'heuristic',
                ...(input.semantic?.fallbackReason
                  ? { compactArtifactFallbackReason: input.semantic.fallbackReason }
                  : {}),
                summaryChars: input.checkpoint.summary.length,
                artifactFileCount: input.checkpoint.artifact?.files.length ?? 0,
                artifactToolResultCount: input.checkpoint.artifact?.toolResults.length ?? 0,
              }
            : {}),
        },
      })
    } catch (error) {
      this.logger.warn('[runtime] context compaction activity append failed:', error)
    }
  }

  private createContextTurnLedgerEntry(input: {
    assistantMessageId: string
    selection: ModelSelection
    contextPlan: AgentContextPlan
    usage?: UsageInfo
  }): ConversationContextTurnLedgerEntry {
    const { assistantMessageId, selection, contextPlan, usage } = input
    return {
      schemaVersion: AILA_CONTEXT_TURN_LEDGER_SCHEMA_VERSION,
      messageId: assistantMessageId,
      createdAt: this.now(),
      providerId: selection.providerId,
      modelId: selection.modelId,
      estimatedInputTokens: contextPlan.ledger.totalEstimatedTokens,
      inputBudgetTokens: contextPlan.ledger.inputBudgetTokens,
      remainingInputTokens:
        contextPlan.budget.remainingPreflightInputTokens ?? contextPlan.ledger.remainingInputTokens,
      sectionCount: contextPlan.ledger.entries.length,
      sections: contextPlan.ledger.entries.map((entry) => ({
        kind: entry.kind,
        messageCount: entry.messageCount,
        charCost: entry.charCost,
        estimatedTokens: entry.estimatedTokens,
      })),
      ...(contextPlan.ledger.preflight
        ? { preflight: cloneRuntimeValue(contextPlan.ledger.preflight) }
        : {}),
      ...(usage ? { usage: cloneRuntimeValue(usage) } : {}),
      compaction: {
        activeCheckpointId: contextPlan.compaction.activeCheckpointId,
        recommendedCheckpointId: contextPlan.compaction.recommendedCheckpoint?.id ?? null,
        omittedRoundCount: contextPlan.compaction.omittedRoundCount,
        shouldAutoCompact: contextPlan.compaction.shouldAutoCompact,
      },
    }
  }

  private async persistContextTurnLedger(input: {
    conversationId: string
    assistantMessageId: string
    selection: ModelSelection
    contextPlan: AgentContextPlan
    usage?: UsageInfo
  }): Promise<void> {
    try {
      const entry = this.createContextTurnLedgerEntry(input)
      const appended = await this.store.appendSessionEntry(input.conversationId, {
        type: 'context.turn.recorded',
        timestamp: entry.createdAt,
        data: { entry },
      })
      const summary = cloneRuntimeConversationSummary(appended.summary)
      this.emit(createWorkbenchEvent('conversations:updated', summary))
    } catch (error) {
      this.logger.warn('[runtime] context turn ledger persistence failed:', error)
    }
  }

  private async runStream(input: {
    conversationId: string
    assistantMessageId: string
    run: RunIdentity
    selection: ModelSelection
    controller: AbortController
    resolveCleanup: () => void
    messages: ChatMessage[]
    contextPlan: AgentContextPlan
    toolContext: ToolContext
    toolRegistry: ToolRegistry
    mode: AilaExecutionMode
    loopMode: 'continuous' | 'step'
    runContextRef: BlobRef
    sessionLeafId: string
    runSnapshot?: RunSnapshot
    resumeState?: {
      messages: ChatMessage[]
      contextPlan: AgentContextPlan
      assistantMessage?: PersistedMessage
      modelStepOutputs?: Record<string, string>
    }
  }): Promise<void> {
    const {
      conversationId,
      assistantMessageId,
      run,
      selection,
      controller,
      resolveCleanup,
      messages,
      contextPlan,
      toolContext,
      toolRegistry,
      mode,
      loopMode,
      runContextRef,
      sessionLeafId,
      runSnapshot,
      resumeState,
    } = input
    let eventLogChain = Promise.resolve()
    let eventLogFailure: unknown
    let lastJournalSeq = runSnapshot?.throughSeq ?? 0
    let currentSessionLeafId = sessionLeafId
    let terminalRunEventQueued = false
    const queueRunEvent = (event: RunEventInput): Promise<void> => {
      const eventWithSelection = withTurnSelection(
        {
          ...cloneRuntimeValue(event),
          turnId: event.turnId ?? run.turnId,
          runId: event.runId ?? run.runId,
          eventId: event.eventId ?? this.createEventId(),
        },
        selection,
      )
      if (
        eventWithSelection.type === 'turn.completed' ||
        eventWithSelection.type === 'turn.failed' ||
        (eventWithSelection.type === 'turn.cancelled' &&
          eventWithSelection.data?.phase === 'completed')
      ) {
        terminalRunEventQueued = true
      }
      if (!this.acceptsStreamEvents(conversationId, controller)) return Promise.resolve()
      eventLogChain = eventLogChain
        .then(async () => {
          if (eventLogFailure) return
          const result = await this.recordRunEventWithResult(eventWithSelection)
          if (result?.event.seq !== undefined) lastJournalSeq = result.event.seq
        })
        .catch((error) => {
          eventLogFailure ??= error
        })
      return eventLogChain
    }

    try {
      const runAgent = this.host.runAgent
      if (!runAgent) throw new Error('runtime host cannot execute agent runs')
      await runAgent(
        {
          conversationId,
          assistantMessageId,
          run: cloneRuntimeValue(run),
          loopMode,
          runContextRef: cloneRuntimeValue(runContextRef),
          sessionLeafId,
          ...(runSnapshot ? { runSnapshot: cloneRuntimeValue(runSnapshot) } : {}),
          ...(resumeState ? { resumeState: cloneRuntimeValue(resumeState) } : {}),
          messages: cloneRuntimeChatMessages(messages) ?? [],
          contextPlan: cloneRuntimeValue(contextPlan),
          prepareModelStep: ({ messages: currentMessages, contextPlan: currentPlan }) => ({
            messages: prepareRuntimeModelStepMessages(currentMessages, currentPlan),
          }),
          getSteeringMessages: () =>
            this.drainQueuedInputs('steering', ({ lastSeq, sessionLeafId: nextLeafId }) => {
              lastJournalSeq = Math.max(lastJournalSeq, lastSeq)
              currentSessionLeafId = nextLeafId
            }),
          getFollowUpMessages: () =>
            this.drainQueuedInputs('followUp', ({ lastSeq, sessionLeafId: nextLeafId }) => {
              lastJournalSeq = Math.max(lastJournalSeq, lastSeq)
              currentSessionLeafId = nextLeafId
            }),
          mode,
          selection: cloneRuntimeValue(selection),
          signal: controller.signal,
          workspaceRoots: cloneRuntimeWorkspaceRoots(toolContext.workspaceRoots),
          shellCwd: toolContext.shellCwd,
          path: toolContext.path,
          settings: cloneRuntimeSettings(toolContext.settings),
          webSearch: toolContext.webSearch,
          generateImage: toolContext.generateImage,
          saveImage: toolContext.saveImage,
          runShell: toolContext.runShell,
          fileSystem: toolContext.fileSystem,
          onToolPolicy: toolContext.onToolPolicy,
          onToolApproval: toolContext.onToolApproval,
          onRunEvent: queueRunEvent,
          onSavePoint: async () => {
            await eventLogChain
            if (eventLogFailure) throw eventLogFailure
            const pendingSeq = await this.flushPendingSessionWrites(conversationId)
            if (pendingSeq !== null) {
              lastJournalSeq = Math.max(lastJournalSeq, pendingSeq)
              currentSessionLeafId = (await this.store.getSessionTree(conversationId)).leafId
            }
          },
          saveRunSnapshot: (snapshot: RunSnapshot) =>
            this.store.saveRunSnapshot(
              cloneRuntimeValue({
                ...snapshot,
                sessionLeafId: currentSessionLeafId,
                throughSeq: lastJournalSeq,
              }),
            ),
          appendSessionEntry: async (entry: SessionEntryInput) => {
            await eventLogChain
            if (eventLogFailure) throw eventLogFailure
            const appended = await this.store.appendSessionEntry(
              conversationId,
              cloneRuntimeValue(entry),
            )
            lastJournalSeq = appended.entry.seq
            return cloneRuntimeValue(appended.entry)
          },
          putBlob: (blob) => this.store.putBlob(conversationId, cloneRuntimeValue(blob)),
          toolRegistry: cloneRuntimeToolRegistry(toolRegistry),
        },
        {
          onTextDelta: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:text-delta', cloneRuntimeValue(event)),
            ),
          onReasoningDelta: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:reasoning-delta', cloneRuntimeValue(event)),
            ),
          onToolCallStart: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:tool-call-start', cloneRuntimeValue(event)),
            ),
          onToolCallArgsDelta: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:tool-call-args-delta', cloneRuntimeValue(event)),
            ),
          onToolCallResult: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:tool-call-result', cloneRuntimeValue(event)),
            ),
          onImageBlock: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:image-block', cloneRuntimeValue(event)),
            ),
          onDone: async (event) => {
            const doneEvent = cloneRuntimeValue(event)
            if (!this.acceptsStreamEvents(conversationId, controller)) return
            const persisted = await this.persistAndAnnounce(conversationId, doneEvent.message)
            if (!persisted || !this.acceptsStreamEvents(conversationId, controller)) return
            this.emit(createWorkbenchEvent('chat:done', doneEvent))
            if (doneEvent.usage) {
              try {
                const appended = await this.store.appendSessionEntry(conversationId, {
                  type: 'usage.recorded',
                  timestamp: this.now(),
                  data: { usage: cloneRuntimeValue(doneEvent.usage) },
                })
                const summary = cloneRuntimeConversationSummary(appended.summary)
                this.emit(createWorkbenchEvent('conversations:updated', summary))
              } catch (err) {
                this.logger.warn('[runtime] usage persistence failed:', err)
              }
            }
            await this.persistContextTurnLedger({
              conversationId,
              assistantMessageId,
              selection,
              contextPlan,
              usage: doneEvent.usage,
            })
          },
          onError: async (event) => {
            const errorEvent = cloneRuntimeValue(event)
            if (!this.acceptsStreamEvents(conversationId, controller)) return
            const persisted = await this.persistAndAnnounce(conversationId, errorEvent.message)
            if (!persisted || !this.acceptsStreamEvents(conversationId, controller)) return
            this.emit(createWorkbenchEvent('chat:error', errorEvent))
          },
        },
      )
      await eventLogChain
      if (eventLogFailure) throw eventLogFailure
    } catch (err) {
      const isAbort = controller.signal.aborted
      const message = isAbort ? 'Aborted' : err instanceof Error ? err.message : String(err)
      if (!isAbort) this.logger.error('[runtime] unexpected stream error:', message)
      if (this.acceptsStreamEvents(conversationId, controller)) {
        const errored: PersistedMessage = {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: assistantMessageId,
          role: 'assistant',
          blocks: [],
          status: 'error',
          error: message,
          model: selection,
        }
        const persisted = await this.persistAndAnnounce(conversationId, errored).catch(() => false)
        if (persisted && this.acceptsStreamEvents(conversationId, controller)) {
          this.emit(
            createWorkbenchEvent('chat:error', {
              conversationId,
              messageId: assistantMessageId,
              error: message,
              message: errored,
            }),
          )
        }
        if (!terminalRunEventQueued) {
          queueRunEvent({
            timestamp: this.now(),
            conversationId,
            messageId: assistantMessageId,
            type: isAbort ? 'turn.cancelled' : 'turn.failed',
            data: isAbort ? { phase: 'completed', reason: 'abort_signal' } : { error: message },
          })
        }
      }
    } finally {
      try {
        await eventLogChain
        if (eventLogFailure) {
          this.logger.error('[runtime] durable journal append failed:', eventLogFailure)
        }
      } finally {
        await this.flushPendingSessionWrites(conversationId).catch((error) => {
          this.logger.warn('[runtime] pending session write flush failed:', error)
        })
        if (!this.deleted) {
          await this.setSessionPhase(conversationId, 'idle').catch((error) => {
            this.logger.warn('[runtime] idle phase persistence failed:', error)
          })
        }
        this.turns.deleteWhere(conversationId, (turn) => turn.controller === controller)
        resolveCleanup()
      }
    }
  }
}

/**
 * A complete runtime bound to exactly one durable conversation session.
 *
 * Unlike WorkbenchRuntime, callers never pass a conversation id to turn,
 * navigation, compaction, extension, or run-control methods. All mutable
 * execution state is therefore scoped to this one session.
 */
export interface SessionRuntimeOptions extends WorkbenchOptions {
  store: WorkbenchStore
}

const SHARED_WORKBENCH_SERVICES = Symbol('shared-workbench-services')
type InternalSessionRuntimeOptions = SessionRuntimeOptions & {
  [SHARED_WORKBENCH_SERVICES]?: WorkbenchServices
}
const sessionRuntimeDeletedHandlers = new WeakMap<SessionRuntime, () => void>()
const sessionRuntimeEngines = new WeakMap<SessionRuntime, SessionRuntimeEngine>()

export class SessionRuntime {
  readonly conversationId: string
  private readonly engine: SessionRuntimeEngine
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>()

  constructor(conversationId: string, options: SessionRuntimeOptions) {
    if (!conversationId.trim()) throw new Error('conversationId is required')
    this.conversationId = conversationId
    const services =
      (options as InternalSessionRuntimeOptions)[SHARED_WORKBENCH_SERVICES] ??
      new WorkbenchServices(options)
    const onEvent = (event: WorkbenchEvent): void => {
      const eventConversationId =
        event.type === 'conversations:updated' ? event.data.id : event.data.conversationId
      if (eventConversationId !== this.conversationId) return
      for (const listener of this.listeners) listener(cloneRuntimeValue(event))
    }
    this.engine = new SessionRuntimeEngine(conversationId, services, onEvent)
    sessionRuntimeEngines.set(this, this.engine)
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async getConversation(): Promise<ConversationRecord> {
    return this.engine.getConversation(this.conversationId)
  }

  async getSessionTree(): Promise<SessionTree> {
    return this.engine.getSessionTree(this.conversationId)
  }

  async getPhase(): Promise<SessionPhase> {
    return (await this.getSessionTree()).phase
  }

  getActiveTurn(): ActiveAssistantTurn | null {
    return (
      this.engine.listActiveTurns().find((turn) => turn.conversationId === this.conversationId) ??
      null
    )
  }

  async waitForIdle(): Promise<void> {
    await this.engine.waitForIdle(this.conversationId)
  }

  async steer(input: RuntimeQueueInput): Promise<string> {
    return this.engine.steer({ ...input, conversationId: this.conversationId })
  }

  async followUp(input: RuntimeQueueInput): Promise<string> {
    return this.engine.followUp({ ...input, conversationId: this.conversationId })
  }

  async nextTurn(input: RuntimeQueueInput): Promise<string> {
    return this.engine.nextTurn({ ...input, conversationId: this.conversationId })
  }

  getInputQueueState(): SessionInputQueueState {
    return this.engine.getInputQueueState()
  }

  clearInputQueue(): SessionInputQueueState {
    return this.engine.clearInputQueue()
  }

  setSteeringMode(mode: SessionInputQueueMode): void {
    this.engine.setSteeringMode(mode)
  }

  setFollowUpMode(mode: SessionInputQueueMode): void {
    this.engine.setFollowUpMode(mode)
  }

  async navigateSession(
    input: Omit<RuntimeNavigateSessionInput, 'conversationId'>,
  ): Promise<ConversationRecord> {
    return this.engine.navigateSession({ ...input, conversationId: this.conversationId })
  }

  async forkSession(
    input: Omit<RuntimeForkSessionInput, 'conversationId'> = {},
  ): Promise<ConversationSummary> {
    return this.engine.forkSession({ ...input, conversationId: this.conversationId })
  }

  async collectGarbage(): Promise<BlobGarbageCollectionResult> {
    return this.engine.collectSessionGarbage(this.conversationId)
  }

  async compact(
    input: Omit<RuntimeCompactConversationInput, 'conversationId'>,
  ): Promise<RuntimeCompactConversationResult> {
    return this.engine.compactConversation({ ...input, conversationId: this.conversationId })
  }

  async hydrate(): Promise<ConversationRuntimeHydration> {
    return this.engine.hydrateConversation(this.conversationId)
  }

  async getRuntimeState(): Promise<ConversationRuntimeReplayState> {
    return this.engine.getConversationRuntimeState(this.conversationId)
  }

  async listRunEvents(): Promise<PersistedRunEvent[]> {
    return this.engine.listRunEvents(this.conversationId)
  }

  async getRunSnapshot(runId: string): Promise<RunSnapshot | null> {
    return this.engine.getRunSnapshot(this.conversationId, runId)
  }

  async listRunSnapshots(): Promise<RunSnapshot[]> {
    return this.engine.listRunSnapshots(this.conversationId)
  }

  async listRunSummaries(): Promise<RuntimeRunSummary[]> {
    return this.engine.listRunSummaries(this.conversationId)
  }

  async inspectRun(
    input: Omit<RuntimeRunControlInput, 'conversationId'>,
  ): Promise<RuntimeRunInspection> {
    return this.engine.inspectRun({ ...input, conversationId: this.conversationId })
  }

  async getRunPayload(input: Omit<RuntimeRunPayloadInput, 'conversationId'>): Promise<RunPayload> {
    return this.engine.getRunPayload({ ...input, conversationId: this.conversationId })
  }

  async rename(title: string): Promise<ConversationSummary> {
    return this.engine.renameConversation(this.conversationId, title)
  }

  async appendUserMessage(
    input: Omit<RuntimeAppendUserMessageInput, 'conversationId'>,
  ): Promise<PersistedMessage> {
    return this.engine.appendUserMessage({ ...input, conversationId: this.conversationId })
  }

  async appendCustomEntry(
    input: Omit<RuntimeAppendSessionCustomInput, 'conversationId'>,
  ): Promise<string> {
    return this.engine.appendSessionCustomEntry({
      ...input,
      conversationId: this.conversationId,
    })
  }

  async appendCustomMessage(
    input: Omit<RuntimeAppendSessionCustomMessageInput, 'conversationId'>,
  ): Promise<string> {
    return this.engine.appendSessionCustomMessage({
      ...input,
      conversationId: this.conversationId,
    })
  }

  async recordRunEvent(
    event: Omit<RuntimeRecordRunEventInput, 'conversationId'>,
  ): Promise<boolean> {
    return this.engine.recordRunEvent({ ...event, conversationId: this.conversationId })
  }

  async getToolRegistry(record?: ConversationRecord): Promise<ToolRegistry> {
    return this.engine.getToolRegistry(
      record ? { conversationId: this.conversationId, record } : undefined,
    )
  }

  async getSkills(): Promise<LoadedSkill[]> {
    return this.engine.getSkills()
  }

  async reloadToolPacks(): Promise<ToolRegistry> {
    return this.engine.reloadToolPacks()
  }

  async executeTool(input: Omit<RuntimeExecuteToolInput, 'conversationId'>): Promise<string> {
    return this.engine.executeTool({ ...input, conversationId: this.conversationId })
  }

  async send(input: Omit<RuntimeSendInput, 'conversationId'>): Promise<RuntimeSendResult> {
    return this.engine.send({ ...input, conversationId: this.conversationId })
  }

  async retryLastUserMessage(
    input: Omit<RuntimeRetryLastInput, 'conversationId'>,
  ): Promise<RuntimeSendResult> {
    return this.engine.retryLastUserMessage({
      ...input,
      conversationId: this.conversationId,
    })
  }

  async resumeRun(
    input: Omit<RuntimeResumeRunInput, 'conversationId'>,
  ): Promise<RuntimeSendResult> {
    return this.engine.resumeRun({ ...input, conversationId: this.conversationId })
  }

  async stepRun(input: Omit<RuntimeRunControlInput, 'conversationId'>): Promise<RuntimeSendResult> {
    return this.engine.stepRun({ ...input, conversationId: this.conversationId })
  }

  async continueRun(
    input: Omit<RuntimeRunControlInput, 'conversationId'>,
  ): Promise<RuntimeSendResult> {
    return this.engine.continueRun({ ...input, conversationId: this.conversationId })
  }

  async abortRun(input: Omit<RuntimeRunControlInput, 'conversationId'>): Promise<RunSnapshot> {
    return this.engine.abortRun({ ...input, conversationId: this.conversationId })
  }

  async forkRun(input: Omit<RuntimeForkRunInput, 'conversationId'>): Promise<RunSnapshot> {
    return this.engine.forkRun({ ...input, conversationId: this.conversationId })
  }

  async abort(): Promise<void> {
    await this.engine.abort(this.conversationId)
  }

  async abortActive(reason: ConversationAbortReason = 'user'): Promise<void> {
    await this.engine.abortAll(reason)
  }

  async shutdown(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    await this.engine.shutdown(reason)
  }

  async delete(): Promise<void> {
    await this.engine.deleteConversation(this.conversationId)
    sessionRuntimeDeletedHandlers.get(this)?.()
  }
}

/**
 * Multi-session process facade. Durable conversation execution is delegated to
 * one SessionRuntime instance per conversation.
 */
export class WorkbenchRuntime implements Workbench {
  private readonly services: WorkbenchServices
  private readonly catalog: ConversationCatalog
  private readonly sessions = new Map<string, SessionRuntime>()
  private shutdownStarted = false
  private shutdownPromise: Promise<void> | null = null

  constructor(options: WorkbenchOptions = {}) {
    this.services = new WorkbenchServices(options)
    this.catalog = new ConversationCatalog(this.services)
  }

  getSessionRuntime(conversationId: string): SessionRuntime {
    const existing = this.sessions.get(conversationId)
    if (existing) return existing
    const sessionOptions: InternalSessionRuntimeOptions = {
      ...this.services.options,
      store: this.services.store,
      [SHARED_WORKBENCH_SERVICES]: this.services,
    }
    const session = new SessionRuntime(conversationId, sessionOptions)
    sessionRuntimeDeletedHandlers.set(session, () => {
      if (this.sessions.get(conversationId) === session) this.sessions.delete(conversationId)
    })
    this.sessions.set(conversationId, session)
    if (this.shutdownStarted) void session.shutdown('shutdown')
    return session
  }

  async getToolRegistry(input?: RuntimeToolPackLoadInput): Promise<ToolRegistry> {
    if (!input?.conversationId) return this.services.getToolRegistry(input)
    const session = this.getSessionRuntime(input.conversationId)
    return session.getToolRegistry(input.record ?? (await session.getConversation()))
  }

  async getSkills(): Promise<LoadedSkill[]> {
    return this.services.getSkills()
  }

  async reloadToolPacks(): Promise<ToolRegistry> {
    return this.services.reloadToolPacks()
  }

  async createConversation(
    input: RuntimeCreateConversationInput = {},
  ): Promise<ConversationSummary> {
    const summary = await this.catalog.createConversation(input)
    this.getSessionRuntime(summary.id)
    return summary
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return this.catalog.listConversations()
  }

  async getConversation(conversationId: string): Promise<ConversationRecord> {
    return this.getSessionRuntime(conversationId).getConversation()
  }

  async getSessionTree(conversationId: string): Promise<SessionTree> {
    return this.getSessionRuntime(conversationId).getSessionTree()
  }

  async navigateSession(input: RuntimeNavigateSessionInput): Promise<ConversationRecord> {
    return this.getSessionRuntime(input.conversationId).navigateSession(input)
  }

  async forkSession(input: RuntimeForkSessionInput): Promise<ConversationSummary> {
    const summary = await this.getSessionRuntime(input.conversationId).forkSession(input)
    this.getSessionRuntime(summary.id)
    return summary
  }

  async collectSessionGarbage(conversationId: string): Promise<BlobGarbageCollectionResult> {
    return this.getSessionRuntime(conversationId).collectGarbage()
  }

  async compactConversation(
    input: RuntimeCompactConversationInput,
  ): Promise<RuntimeCompactConversationResult> {
    return this.getSessionRuntime(input.conversationId).compact(input)
  }

  async resolveConversation(
    input: RuntimeResolveConversationInput = {},
  ): Promise<RuntimeResolveConversationResult> {
    const resolved = await this.catalog.resolveConversation(input)
    this.getSessionRuntime(resolved.conversationId)
    return resolved
  }

  async hydrateConversation(conversationId: string): Promise<ConversationRuntimeHydration> {
    return this.getSessionRuntime(conversationId).hydrate()
  }

  async getConversationRuntimeState(
    conversationId: string,
  ): Promise<ConversationRuntimeReplayState> {
    return this.getSessionRuntime(conversationId).getRuntimeState()
  }

  async listConversationRuntimeStates(): Promise<ConversationRuntimeStateSnapshot[]> {
    const conversations = await this.listConversations()
    return Promise.all(
      conversations.map(async ({ id }) => ({
        conversationId: id,
        state: await this.getSessionRuntime(id).getRuntimeState(),
      })),
    )
  }

  async listRunEvents(conversationId: string): Promise<PersistedRunEvent[]> {
    return this.getSessionRuntime(conversationId).listRunEvents()
  }

  async getRunSnapshot(conversationId: string, runId: string): Promise<RunSnapshot | null> {
    return this.getSessionRuntime(conversationId).getRunSnapshot(runId)
  }

  async listRunSnapshots(conversationId: string): Promise<RunSnapshot[]> {
    return this.getSessionRuntime(conversationId).listRunSnapshots()
  }

  async listRunSummaries(conversationId: string): Promise<RuntimeRunSummary[]> {
    return this.getSessionRuntime(conversationId).listRunSummaries()
  }

  async inspectRun(input: RuntimeRunControlInput): Promise<RuntimeRunInspection> {
    return this.getSessionRuntime(input.conversationId).inspectRun(input)
  }

  async getRunPayload(input: RuntimeRunPayloadInput): Promise<RunPayload> {
    return this.getSessionRuntime(input.conversationId).getRunPayload(input)
  }

  async appendUserMessage(input: RuntimeAppendUserMessageInput): Promise<PersistedMessage> {
    return this.getSessionRuntime(input.conversationId).appendUserMessage(input)
  }

  async appendSessionCustomEntry(input: RuntimeAppendSessionCustomInput): Promise<string> {
    return this.getSessionRuntime(input.conversationId).appendCustomEntry(input)
  }

  async appendSessionCustomMessage(input: RuntimeAppendSessionCustomMessageInput): Promise<string> {
    return this.getSessionRuntime(input.conversationId).appendCustomMessage(input)
  }

  async recordRunEvent(event: RuntimeRecordRunEventInput): Promise<boolean> {
    return this.getSessionRuntime(event.conversationId).recordRunEvent(event)
  }

  async renameConversation(conversationId: string, title: string): Promise<ConversationSummary> {
    return this.getSessionRuntime(conversationId).rename(title)
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const session = this.getSessionRuntime(conversationId)
    await session.delete()
  }

  async send(input: RuntimeSendInput): Promise<RuntimeSendResult> {
    return this.getSessionRuntime(input.conversationId).send(input)
  }

  async retryLastUserMessage(input: RuntimeRetryLastInput): Promise<RuntimeSendResult> {
    return this.getSessionRuntime(input.conversationId).retryLastUserMessage(input)
  }

  async resumeRun(input: RuntimeResumeRunInput): Promise<RuntimeSendResult> {
    return this.getSessionRuntime(input.conversationId).resumeRun(input)
  }

  async stepRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult> {
    return this.getSessionRuntime(input.conversationId).stepRun(input)
  }

  async continueRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult> {
    return this.getSessionRuntime(input.conversationId).continueRun(input)
  }

  async abortRun(input: RuntimeRunControlInput): Promise<RunSnapshot> {
    return this.getSessionRuntime(input.conversationId).abortRun(input)
  }

  async forkRun(input: RuntimeForkRunInput): Promise<RunSnapshot> {
    return this.getSessionRuntime(input.conversationId).forkRun(input)
  }

  async steer(input: RuntimeQueueControlInput): Promise<string> {
    return this.getSessionRuntime(input.conversationId).steer(input)
  }

  async followUp(input: RuntimeQueueControlInput): Promise<string> {
    return this.getSessionRuntime(input.conversationId).followUp(input)
  }

  async nextTurn(input: RuntimeQueueControlInput): Promise<string> {
    return this.getSessionRuntime(input.conversationId).nextTurn(input)
  }

  getInputQueueState(conversationId: string): SessionInputQueueState {
    return this.getSessionRuntime(conversationId).getInputQueueState()
  }

  clearInputQueue(conversationId: string): SessionInputQueueState {
    return this.getSessionRuntime(conversationId).clearInputQueue()
  }

  setSteeringMode(conversationId: string, mode: SessionInputQueueMode): void {
    this.getSessionRuntime(conversationId).setSteeringMode(mode)
  }

  setFollowUpMode(conversationId: string, mode: SessionInputQueueMode): void {
    this.getSessionRuntime(conversationId).setFollowUpMode(mode)
  }

  async abort(conversationId: string): Promise<void> {
    await this.getSessionRuntime(conversationId).abort()
  }

  async abortAll(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.abortActive(reason)))
  }

  shutdown(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    this.shutdownStarted = true
    if (!this.shutdownPromise) {
      this.shutdownPromise = Promise.all(
        [...this.sessions.values()].map((session) => session.shutdown(reason)),
      ).then(() => undefined)
    }
    return this.shutdownPromise
  }

  listActiveTurns(): ActiveAssistantTurn[] {
    return [...this.sessions.values()].flatMap((session) => {
      const turn = session.getActiveTurn()
      return turn ? [turn] : []
    })
  }

  listActiveStreams(): ActiveAssistantTurn[] {
    return this.listActiveTurns()
  }

  async recoverInterruptedActivities(reason?: string): Promise<ConversationSummary[]> {
    const recovered = await this.catalog.recoverInterruptedActivities(reason)
    for (const session of this.sessions.values()) {
      sessionRuntimeEngines.get(session)?.resetRecoveredPhase()
    }
    for (const summary of recovered) this.getSessionRuntime(summary.id)
    return recovered
  }

  async executeTool(input: RuntimeExecuteToolInput): Promise<string> {
    if (!input.conversationId) return this.services.executeTool(input)
    return this.getSessionRuntime(input.conversationId).executeTool(input)
  }
}
