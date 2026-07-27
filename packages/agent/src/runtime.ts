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
  prepareRunCheckpointForResume,
  type RunArtifact,
  type RunCheckpoint,
} from './run-persistence'
import { createInMemoryRuntimeStore } from './runtime/memory-store'
import type { WorkbenchStore } from './runtime/repositories'
import {
  type CoordinatedTurn,
  TurnCoordinator,
  type TurnStartLock,
} from './runtime/turn-coordinator'
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
  type ToolWorkspaceRoot,
} from './tools'
import { createWorkbenchEvent, type WorkbenchEvent } from './workbench-events'

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

interface RuntimeToolContextInput {
  conversationId?: string
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
  checkpoint: RunCheckpoint,
  active: boolean,
): RuntimeRunAllowedControls {
  const status = checkpoint.loop.state.status
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
  const resumable = status === 'paused' && checkpoint.recovery.strategy === 'automatic'
  return {
    step: resumable && !active,
    continue: resumable && !active,
    abort: !terminal,
    fork: !active && checkpoint.loop.state.currentStep?.status !== 'running',
  }
}

function runArtifactLabel(artifact: RunArtifact): string {
  const data =
    artifact.data && typeof artifact.data === 'object'
      ? (artifact.data as Record<string, unknown>)
      : undefined
  const toolName = typeof data?.toolName === 'string' ? data.toolName : undefined
  const outcome = typeof data?.outcome === 'string' ? data.outcome : undefined
  if (artifact.kind === 'model_request') return 'Model request'
  if (artifact.kind === 'model_response')
    return outcome ? `Model response · ${outcome}` : 'Model response'
  if (artifact.kind === 'tool_request')
    return toolName ? `Tool request · ${toolName}` : 'Tool request'
  if (artifact.kind === 'tool_result') {
    return [toolName ? `Tool result · ${toolName}` : 'Tool result', outcome]
      .filter(Boolean)
      .join(' · ')
  }
  if (artifact.kind === 'tool_batch') return 'Tool batch summary'
  if (artifact.kind === 'compaction') return 'Context compaction'
  return artifact.kind.replaceAll('_', ' ')
}

function runArtifactDescriptor(artifact: RunArtifact): RuntimeRunArtifactDescriptor {
  const { data, ...metadata } = artifact
  let size = 0
  try {
    size = JSON.stringify(data).length
  } catch {
    size = String(data).length
  }
  return {
    ...cloneRuntimeValue(metadata),
    label: runArtifactLabel(artifact),
    size,
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

export interface RuntimeRunArtifactInput extends RuntimeRunControlInput {
  artifactId: string
}

export interface RuntimeRunAllowedControls {
  step: boolean
  continue: boolean
  abort: boolean
  fork: boolean
}

export interface RuntimeRunSummary {
  identity: RunCheckpoint['identity']
  status: RunCheckpoint['loop']['state']['status']
  mode: RunCheckpoint['loop']['state']['mode']
  nextAction?: RunCheckpoint['loop']['state']['nextAction']
  wait?: RunCheckpoint['loop']['state']['wait']
  recovery: RunCheckpoint['recovery']
  revision: number
  updatedAt: number
  stepCount: number
  active: boolean
  allowedControls: RuntimeRunAllowedControls
}

export interface RuntimeRunArtifactDescriptor extends Omit<RunArtifact, 'data'> {
  label: string
  size: number
}

export interface RuntimeRunInspection {
  checkpoint: RunCheckpoint
  events: PersistedRunEvent[]
  artifacts: RuntimeRunArtifactDescriptor[]
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

export interface RuntimeExecuteToolInput {
  name: string
  args: Record<string, unknown>
  mode?: AilaExecutionMode
  conversationId?: string
  messageId?: string
  toolCallId?: string
  signal?: AbortSignal
}

export {
  AILA_WORKBENCH_EVENT_SCHEMA_VERSION,
  AILA_WORKBENCH_EVENT_TYPES,
  createWorkbenchEvent,
  isWorkbenchEventType,
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
  workspaceRoots?: ToolContext['workspaceRoots'] | (() => ToolContext['workspaceRoots'])
  shellCwd?: ToolContext['shellCwd'] | (() => ToolContext['shellCwd'])
  getModelInfo?: RuntimeModelInfoResolver
  runAgent?: DurableRunExecutor
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
  EventRepository,
  RunRepository,
  SessionRepository,
  WorkbenchStore,
} from './runtime/repositories'

interface WorkbenchSessionApi {
  createConversation(input?: RuntimeCreateConversationInput): Promise<ConversationSummary>
  listConversations(): Promise<ConversationSummary[]>
  getConversation(conversationId: string): Promise<ConversationRecord>
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
  getRunCheckpoint(conversationId: string, runId: string): Promise<RunCheckpoint | null>
  listRunCheckpoints(conversationId: string): Promise<RunCheckpoint[]>
  listRunSummaries(conversationId: string): Promise<RuntimeRunSummary[]>
  inspectRun(input: RuntimeRunControlInput): Promise<RuntimeRunInspection>
  getRunArtifact(input: RuntimeRunArtifactInput): Promise<RunArtifact>
  appendUserMessage(input: RuntimeAppendUserMessageInput): Promise<PersistedMessage>
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
  abortRun(input: RuntimeRunControlInput): Promise<RunCheckpoint>
  forkRun(input: RuntimeForkRunInput): Promise<RunCheckpoint>
  abort(conversationId: string): Promise<void>
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

export class WorkbenchRuntime implements Workbench {
  private readonly turns = new TurnCoordinator<StreamSlot>()
  private readonly deletedConversations = new Set<string>()
  private readonly host: WorkbenchHost
  private readonly store: WorkbenchStore
  private readonly logger: Pick<Console, 'error' | 'warn'>
  private readonly createId: () => string
  private readonly createRunId: () => string
  private readonly createEventId: () => string
  private readonly now: () => number
  private readonly staticToolPacks: readonly ToolPack[]
  private readonly staticSkills: readonly LoadedSkill[]
  private readonly fallbackToolRegistry: ToolRegistry
  private shutdownPromise: Promise<void> | null = null
  private shutdownStarted = false
  private toolRegistryLoad: Promise<ToolRegistry> | null = null
  private skillsLoad: Promise<readonly LoadedSkill[]> | null = null

  constructor(private readonly options: WorkbenchOptions = {}) {
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

  async getToolRegistry(input?: RuntimeToolPackLoadInput): Promise<ToolRegistry> {
    if (!this.host.loadToolPacks && !this.host.loadSkills) {
      return cloneRuntimeToolRegistry(this.fallbackToolRegistry)
    }
    if (input) {
      return cloneRuntimeToolRegistry(await this.loadToolRegistry(input))
    }
    if (!this.toolRegistryLoad) this.toolRegistryLoad = this.loadToolRegistry()
    return cloneRuntimeToolRegistry(await this.toolRegistryLoad)
  }

  async getSkills(): Promise<LoadedSkill[]> {
    if (!this.host.loadSkills) return cloneRuntimeSkills(this.staticSkills)
    if (!this.skillsLoad) this.skillsLoad = this.loadSkills()
    return cloneRuntimeSkills(await this.skillsLoad)
  }

  // Reloads every extension cache (manifest tool packs and skills) and
  // rebuilds the tool registry from the refreshed sources.
  async reloadToolPacks(): Promise<ToolRegistry> {
    this.toolRegistryLoad = null
    this.skillsLoad = null
    return this.getToolRegistry()
  }

  async createConversation(
    input: RuntimeCreateConversationInput = {},
  ): Promise<ConversationSummary> {
    if (!this.store.createConversation) throw new Error('runtime store cannot create conversations')
    const summary = cloneRuntimeConversationSummary(
      await this.store.createConversation(input.workspace ?? undefined),
    )
    this.emit(createWorkbenchEvent('conversations:updated', summary))
    return summary
  }

  async listConversations(): Promise<ConversationSummary[]> {
    if (!this.store.listConversations) throw new Error('runtime store cannot list conversations')
    return sortRuntimeConversationSummaries(
      cloneRuntimeConversationSummaries(await this.store.listConversations()),
    )
  }

  async getConversation(conversationId: string): Promise<ConversationRecord> {
    return cloneRuntimeConversationRecord(await this.store.getConversation(conversationId))
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
      const record = await this.getConversation(input.conversationId)
      return {
        conversationId: input.conversationId,
        isExisting: true,
        summary: cloneRuntimeConversationSummary(record.meta),
      }
    }

    const summary = await this.createConversation()
    return { conversationId: summary.id, isExisting: false, summary }
  }

  async listRunEvents(conversationId: string): Promise<PersistedRunEvent[]> {
    if (!this.store.listRunEvents) throw new Error('runtime store cannot list agent events')
    return cloneRuntimePersistedRunEvents(await this.store.listRunEvents(conversationId))
  }

  async getRunCheckpoint(conversationId: string, runId: string): Promise<RunCheckpoint | null> {
    if (!this.store.getRunCheckpoint) throw new Error('runtime store cannot load run checkpoints')
    const checkpoint = await this.store.getRunCheckpoint(conversationId, runId)
    return checkpoint ? cloneRuntimeValue(checkpoint) : null
  }

  async listRunCheckpoints(conversationId: string): Promise<RunCheckpoint[]> {
    if (!this.store.listRunCheckpoints) {
      throw new Error('runtime store cannot list run checkpoints')
    }
    return cloneRuntimeValue([...(await this.store.listRunCheckpoints(conversationId))])
  }

  async listRunSummaries(conversationId: string): Promise<RuntimeRunSummary[]> {
    const activeRunIds = new Set(
      this.listActiveStreams()
        .filter((turn) => turn.conversationId === conversationId)
        .map((turn) => turn.runId),
    )
    return (await this.listRunCheckpoints(conversationId)).map((checkpoint) => {
      const active = activeRunIds.has(checkpoint.identity.runId)
      return {
        identity: cloneRuntimeValue(checkpoint.identity),
        status: checkpoint.loop.state.status,
        mode: checkpoint.loop.state.mode,
        ...(checkpoint.loop.state.nextAction
          ? { nextAction: cloneRuntimeValue(checkpoint.loop.state.nextAction) }
          : {}),
        ...(checkpoint.loop.state.wait
          ? { wait: cloneRuntimeValue(checkpoint.loop.state.wait) }
          : {}),
        recovery: cloneRuntimeValue(checkpoint.recovery),
        revision: checkpoint.revision,
        updatedAt: checkpoint.updatedAt,
        stepCount: checkpoint.loop.state.steps.length,
        active,
        allowedControls: runtimeRunAllowedControls(checkpoint, active),
      }
    })
  }

  async inspectRun(input: RuntimeRunControlInput): Promise<RuntimeRunInspection> {
    const checkpoint = await this.getRunCheckpoint(input.conversationId, input.runId)
    if (!checkpoint) {
      throw new Error(`agent run checkpoint not found: ${input.conversationId}/${input.runId}`)
    }
    const [events, artifacts] = await Promise.all([
      this.listRunEvents(input.conversationId),
      this.store.listRunArtifacts
        ? this.store.listRunArtifacts(input.conversationId, input.runId)
        : Promise.resolve([]),
    ])
    const active = this.listActiveStreams().some((turn) => turn.runId === input.runId)
    return cloneRuntimeValue({
      checkpoint,
      events: events.filter((event) => event.runId === input.runId),
      artifacts: [...artifacts].map(runArtifactDescriptor),
      active,
      allowedControls: runtimeRunAllowedControls(checkpoint, active),
    })
  }

  async getRunArtifact(input: RuntimeRunArtifactInput): Promise<RunArtifact> {
    if (!this.store.listRunArtifacts) {
      throw new Error('runtime store cannot load run artifacts')
    }
    const artifact = (await this.store.listRunArtifacts(input.conversationId, input.runId)).find(
      (candidate) => candidate.artifactId === input.artifactId,
    )
    if (!artifact) {
      throw new Error(`agent run artifact not found: ${input.artifactId}`)
    }
    return cloneRuntimeValue(artifact)
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

  async listConversationRuntimeStates(): Promise<ConversationRuntimeStateSnapshot[]> {
    const conversations = await this.listConversations()
    return Promise.all(
      conversations.map(async (summary) => ({
        conversationId: summary.id,
        state: await this.getConversationRuntimeState(summary.id),
      })),
    )
  }

  async renameConversation(conversationId: string, title: string): Promise<ConversationSummary> {
    if (!this.store.renameConversation) throw new Error('runtime store cannot rename conversations')
    const summary = cloneRuntimeConversationSummary(
      await this.store.renameConversation(conversationId, title),
    )
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

  async executeTool(input: RuntimeExecuteToolInput): Promise<string> {
    const mode = normalizeAilaExecutionMode(input.mode)
    let record: ConversationRecord | undefined
    if (input.conversationId) {
      try {
        record = await this.getConversation(input.conversationId)
      } catch {
        record = undefined
      }
    }
    const registry = await this.getToolRegistry(
      record
        ? {
            ...(input.conversationId && { conversationId: input.conversationId }),
            record,
          }
        : undefined,
    )
    return executeRegisteredTool(
      input.name,
      input.args,
      await this.buildToolContext({
        ...(input.conversationId && { conversationId: input.conversationId }),
        ...(input.messageId && { messageId: input.messageId }),
        ...(input.toolCallId && { toolCallId: input.toolCallId }),
        mode,
        ...(input.signal && { signal: input.signal }),
      }),
      registry,
    )
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
      if (!this.store.saveContextCheckpoint) {
        throw new Error('runtime store cannot save context checkpoints')
      }

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

  async abortRun(input: RuntimeRunControlInput): Promise<RunCheckpoint> {
    const active = this.turns.get(input.conversationId)
    if (active) {
      if (active.run.runId !== input.runId) {
        throw new Error(`another run is active: ${active.run.runId}`)
      }
      await this.abort(input.conversationId)
    }
    if (!this.store.getRunCheckpoint || !this.store.saveRunCheckpoint) {
      throw new Error('runtime store cannot abort persisted agent runs')
    }
    const loaded = await this.store.getRunCheckpoint(input.conversationId, input.runId)
    if (!loaded) {
      throw new Error(`agent run checkpoint not found: ${input.conversationId}/${input.runId}`)
    }
    if (
      loaded.loop.state.status === 'completed' ||
      loaded.loop.state.status === 'failed' ||
      loaded.loop.state.status === 'cancelled'
    ) {
      return cloneRuntimeValue(loaded)
    }

    const timestamp = this.now()
    const checkpoint = cloneRuntimeValue(loaded)
    checkpoint.loop.state.status = 'cancelled'
    checkpoint.loop.state.completedAt = timestamp
    checkpoint.loop.state.currentStep = undefined
    checkpoint.loop.state.nextAction = undefined
    checkpoint.loop.state.wait = undefined
    checkpoint.loop.state.error = 'user'
    checkpoint.assistantMessage = {
      ...checkpoint.assistantMessage,
      status: 'error',
      error: 'Aborted',
    }
    checkpoint.recovery = { strategy: 'automatic' }
    checkpoint.updatedAt = timestamp
    await this.recordRunEvent({
      timestamp,
      conversationId: input.conversationId,
      messageId: checkpoint.assistantMessageId,
      turnId: checkpoint.identity.turnId,
      runId: checkpoint.identity.runId,
      type: 'run.cancelled',
      data: { reason: 'user' },
    })
    const saved = cloneRuntimeValue(await this.store.saveRunCheckpoint(checkpoint))
    await this.persistAndAnnounce(input.conversationId, saved.assistantMessage)
    return saved
  }

  async forkRun(input: RuntimeForkRunInput): Promise<RunCheckpoint> {
    if (!this.store.getRunCheckpoint || !this.store.saveRunCheckpoint) {
      throw new Error('runtime store cannot fork persisted agent runs')
    }
    this.assertCanStartTurn(input.conversationId)
    const source = await this.store.getRunCheckpoint(input.conversationId, input.runId)
    if (!source) {
      throw new Error(`agent run checkpoint not found: ${input.conversationId}/${input.runId}`)
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
    const pendingModelOutput =
      nextAction.type === 'tools'
        ? source.modelStepOutputs[String(Math.max(0, source.loop.modelStepIndex - 1))]
        : undefined
    const checkpoint: RunCheckpoint = {
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
      modelStepOutputs: pendingModelOutput === undefined ? {} : { '0': pendingModelOutput },
      assistantMessage: {
        ...cloneRuntimeValue(source.assistantMessage),
        id: assistantMessageId,
        status: 'streaming',
        error: undefined,
      },
      recovery: { strategy: 'automatic' },
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastEventSeq: undefined,
    }
    const saved = cloneRuntimeValue(await this.store.saveRunCheckpoint(checkpoint))
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
      if (!this.store.saveRunCheckpoint || !this.store.getRunCheckpoint) {
        throw new Error('runtime store cannot resume agent runs')
      }

      const loaded = await this.store.getRunCheckpoint(input.conversationId, input.runId)
      if (!loaded) {
        throw new Error(`agent run checkpoint not found: ${input.conversationId}/${input.runId}`)
      }
      const checkpoint = cloneRuntimeValue(loaded)
      const interruptedStep = checkpoint.loop.state.currentStep
      const recoveryTimestamp = Math.max(
        checkpoint.updatedAt + 1,
        (interruptedStep?.startedAt ?? checkpoint.updatedAt) + 1,
      )
      const resumed = prepareRunCheckpointForResume(checkpoint, recoveryTimestamp)
      if (interruptedStep?.status === 'running') {
        await this.recordRunEvent({
          timestamp: recoveryTimestamp,
          conversationId: input.conversationId,
          messageId: checkpoint.assistantMessageId,
          turnId: checkpoint.identity.turnId,
          runId: checkpoint.identity.runId,
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
          messageId: checkpoint.assistantMessageId,
          turnId: checkpoint.identity.turnId,
          runId: checkpoint.identity.runId,
          type: 'run.paused',
          data: {
            nextAction: cloneRuntimeValue(resumed.loop.state.nextAction),
            wait: cloneRuntimeValue(resumed.loop.state.wait),
          },
        })
      }
      const savedCheckpoint = cloneRuntimeValue(await this.store.saveRunCheckpoint(resumed))
      const record = await this.getConversation(input.conversationId)
      const userMessage = record.messages.find(
        (message) => message.id === savedCheckpoint.identity.turnId,
      )
      if (!userMessage || userMessage.role !== 'user') {
        throw new Error(`run user message not found: ${savedCheckpoint.identity.turnId}`)
      }
      if (!savedCheckpoint.contextPlan) {
        throw new Error('run checkpoint is missing its context plan')
      }

      const mode = savedCheckpoint.executionMode
      const assistantMessageId = savedCheckpoint.assistantMessageId
      const baseToolRegistry = await this.getToolRegistry({
        conversationId: input.conversationId,
        record,
      })
      const toolRegistry = filterRuntimeToolRegistryForMode(baseToolRegistry, mode)
      const toolContext = await this.buildToolContext({
        conversationId: input.conversationId,
        messageId: assistantMessageId,
        mode,
      })

      const controller = new AbortController()
      let resolveCleanup: () => void = () => {}
      const cleanup = new Promise<void>((resolve) => {
        resolveCleanup = resolve
      })
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
        messages: cloneRuntimeChatMessages(savedCheckpoint.messages) ?? [],
        contextPlan: cloneRuntimeValue(savedCheckpoint.contextPlan),
        toolContext,
        toolRegistry,
        mode,
        loopMode: input.loopMode ?? 'continuous',
        runCheckpoint: savedCheckpoint,
      })

      return {
        userMessage: cloneRuntimeValue(userMessage),
        assistantMessageId,
        turnId: savedCheckpoint.identity.turnId,
        runId: savedCheckpoint.identity.runId,
      }
    })
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
      const baseToolRegistry = await this.getToolRegistry({ conversationId, record })
      toolRegistry = filterRuntimeToolRegistryForMode(baseToolRegistry, mode)
      toolContext = await this.buildToolContext({
        conversationId,
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
    })

    return { userMessage, assistantMessageId, turnId: run.turnId, runId: run.runId }
  }

  async abort(conversationId: string): Promise<void> {
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

  listActiveStreams(): ActiveAssistantTurn[] {
    return this.turns.entries().map(([conversationId, slot]) => ({
      conversationId,
      assistantMessageId: slot.assistantMessageId,
      turnId: slot.run.turnId,
      runId: slot.run.runId,
      selection: cloneRuntimeValue(slot.selection),
    }))
  }

  async recoverInterruptedActivities(
    reason = 'runtime restarted before this turn finished',
  ): Promise<ConversationSummary[]> {
    if (this.store.recoverInterruptedActivities) {
      const recoveredResults = cloneRuntimeRunEventAppendResults(
        await this.store.recoverInterruptedActivities(reason),
      )
      const recovered: ConversationSummary[] = []
      for (const result of recoveredResults) {
        this.emit(createWorkbenchEvent('run:event', result.event))
        if (!result.summary) continue
        this.emit(createWorkbenchEvent('conversations:updated', result.summary))
        recovered.push(result.summary)
      }
      return [...recovered].sort((a, b) => b.updatedAt - a.updatedAt)
    }

    if (!this.store.listConversations || !this.store.listRunEvents) return []

    const conversations = cloneRuntimeConversationSummaries(await this.store.listConversations())
    const recovered: ConversationSummary[] = []
    await Promise.all(
      conversations.map(async (summary) => {
        const loadedEvents = await this.store.listRunEvents?.(summary.id)
        const events = loadedEvents ? cloneRuntimePersistedRunEvents(loadedEvents) : undefined
        if (!events) return
        const recoveryEvent = createInterruptedConversationRecoveryEvent(events, {
          reason,
          activity: replayConversationActivity(events) ?? summary.activity,
        })
        if (!recoveryEvent) return
        const { event, summary: nextSummary } = cloneRuntimeRunEventAppendResult(
          await this.store.recordRunEvent(summary.id, cloneRuntimeValue(recoveryEvent)),
        )
        this.emit(createWorkbenchEvent('run:event', event))
        if (!nextSummary) return
        this.emit(createWorkbenchEvent('conversations:updated', nextSummary))
        recovered.push(nextSummary)
      }),
    )
    return recovered.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async abortAll(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
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
    this.deletedConversations.add(conversationId)
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
      removed = true
    } catch (error) {
      this.deletedConversations.delete(conversationId)
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
      if (!removed) this.deletedConversations.delete(conversationId)
    }
  }

  private async persistAndAnnounce(
    conversationId: string,
    message: PersistedMessage,
  ): Promise<boolean> {
    if (this.deletedConversations.has(conversationId)) return false
    const summary = cloneRuntimeConversationSummary(
      await this.store.saveMessage(conversationId, cloneRuntimePersistedMessage(message)),
    )
    if (this.deletedConversations.has(conversationId)) return false
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
    if (this.deletedConversations.has(conversationId)) return
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
    if (this.deletedConversations.has(conversationId)) return
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
    this.host.onEvent?.(cloneRuntimeValue(event))
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
    if (this.deletedConversations.has(event.conversationId)) return null
    const result = cloneRuntimeRunEventAppendResult(
      await this.store.recordRunEvent(event.conversationId, cloneRuntimeValue(event)),
    )
    if (this.deletedConversations.has(event.conversationId)) return null
    const { event: persisted, summary } = result
    this.emit(createWorkbenchEvent('run:event', persisted))
    if (summary) this.emit(createWorkbenchEvent('conversations:updated', summary))
    return result
  }

  private resolveWorkspaceRoots(): ToolContext['workspaceRoots'] {
    const roots = this.host.workspaceRoots
    return cloneRuntimeWorkspaceRoots(typeof roots === 'function' ? roots() : roots)
  }

  // Skill directories become read/write roots so the model can open bundled
  // skill files (references/, scripts/, assets/) with the ordinary file tools.
  private async resolveSkillWorkspaceRoots(): Promise<ToolWorkspaceRoot[]> {
    const skills = await this.getSkills()
    return skills.map((skill) => ({
      path: skill.directory,
      label: `Skill: ${skill.definition.name}`,
    }))
  }

  private resolveShellCwd(): ToolContext['shellCwd'] {
    const cwd = this.host.shellCwd
    return typeof cwd === 'function' ? cwd() : cwd
  }

  private async resolveSettings(): Promise<Settings | undefined> {
    return this.host.loadSettings?.()
  }

  private async resolveSettingsOrDefault(): Promise<Settings> {
    return cloneRuntimeSettings((await this.resolveSettings()) ?? EMPTY_RUNTIME_SETTINGS)
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
    const hostRoots = this.resolveWorkspaceRoots()
    const skillRoots = await this.resolveSkillWorkspaceRoots()
    const mode = normalizeAilaExecutionMode(input.mode)
    const onToolPolicy =
      mode === 'agent' && !this.host.onToolPolicy
        ? undefined
        : createExecutionModeToolPolicy(mode, this.host.onToolPolicy)
    return {
      settings: await this.resolveSettingsOrDefault(),
      ...(input.conversationId && { conversationId: input.conversationId }),
      ...(input.messageId && { messageId: input.messageId }),
      ...(input.toolCallId && { toolCallId: input.toolCallId }),
      ...(input.signal && { signal: input.signal }),
      workspaceRoots: skillRoots.length > 0 ? [...(hostRoots ?? []), ...skillRoots] : hostRoots,
      shellCwd: this.resolveShellCwd(),
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

  private assertConversationOpen(conversationId: string): void {
    if (this.deletedConversations.has(conversationId)) {
      throw new Error('conversation was deleted')
    }
  }

  private assertCanStartTurn(conversationId: string): void {
    if (this.shutdownStarted) throw new Error('runtime is shut down')
    this.assertConversationOpen(conversationId)
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
    if (this.deletedConversations.has(conversationId)) return false
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
    if (!recommended || !this.store.saveContextCheckpoint) return
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
    if (!this.store.saveContextCheckpoint) return null
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
      const summary = cloneRuntimeConversationSummary(
        await this.store.saveContextCheckpoint(conversationId, checkpoint),
      )
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
    if (!this.store.recordContextTurnLedger) return
    try {
      const summary = cloneRuntimeConversationSummary(
        await this.store.recordContextTurnLedger(
          input.conversationId,
          this.createContextTurnLedgerEntry(input),
        ),
      )
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
    runCheckpoint?: RunCheckpoint
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
      runCheckpoint,
    } = input
    let eventLogChain = Promise.resolve()
    let lastEventSeq = runCheckpoint?.lastEventSeq
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
          const result = await this.recordRunEventWithResult(eventWithSelection)
          if (result?.event.seq !== undefined) lastEventSeq = result.event.seq
        })
        .catch((err) => {
          this.logger.warn('[runtime] agent-event append failed:', err)
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
          ...(runCheckpoint ? { runCheckpoint: cloneRuntimeValue(runCheckpoint) } : {}),
          messages: cloneRuntimeChatMessages(messages) ?? [],
          contextPlan: cloneRuntimeValue(contextPlan),
          prepareModelStep: ({ messages: currentMessages, contextPlan: currentPlan }) => ({
            messages: prepareRuntimeModelStepMessages(currentMessages, currentPlan),
          }),
          mode,
          selection: cloneRuntimeValue(selection),
          signal: controller.signal,
          workspaceRoots: cloneRuntimeWorkspaceRoots(toolContext.workspaceRoots),
          shellCwd: toolContext.shellCwd,
          settings: cloneRuntimeSettings(toolContext.settings),
          webSearch: toolContext.webSearch,
          generateImage: toolContext.generateImage,
          saveImage: toolContext.saveImage,
          runShell: toolContext.runShell,
          fileSystem: toolContext.fileSystem,
          onToolPolicy: toolContext.onToolPolicy,
          onToolApproval: toolContext.onToolApproval,
          onRunEvent: queueRunEvent,
          ...(this.store.saveRunCheckpoint
            ? {
                saveRunCheckpoint: (checkpoint: RunCheckpoint) =>
                  this.store.saveRunCheckpoint?.(
                    cloneRuntimeValue({
                      ...checkpoint,
                      ...(lastEventSeq !== undefined ? { lastEventSeq } : {}),
                    }),
                  ) ?? Promise.resolve(cloneRuntimeValue(checkpoint)),
              }
            : {}),
          ...(this.store.saveRunArtifact
            ? {
                saveRunArtifact: (artifact: RunArtifact) =>
                  this.store.saveRunArtifact?.(cloneRuntimeValue(artifact)) ??
                  Promise.resolve(cloneRuntimeValue(artifact)),
              }
            : {}),
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
                const summary = cloneRuntimeConversationSummary(
                  await this.store.recordUsage(conversationId, cloneRuntimeValue(doneEvent.usage)),
                )
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
      this.turns.deleteWhere(conversationId, (turn) => turn.controller === controller)
      await eventLogChain
      resolveCleanup()
    }
  }
}
