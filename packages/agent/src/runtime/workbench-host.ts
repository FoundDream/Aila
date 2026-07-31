import type {
  ChatMessage,
  DurableRunExecutor,
  RunSavePointReason,
  RuntimeModelInfoResolver,
  ToolCallEvent,
  ToolResultEvent,
} from '../agent-protocol'
import type { AgentContextPlan } from '../context'
import type {
  ConversationContextCheckpoint,
  ConversationRecord,
  ConversationRuntimeReplayState,
  ConversationSummary,
  PersistedMessage,
  PersistedRunEvent,
} from '../conversation-core'
import type { RunPayload, RunSnapshot } from '../run-persistence'
import type {
  BlobGarbageCollectionResult,
  SessionPhase,
  SessionProjectionOptions,
  SessionTree,
} from '../session-journal'
import type { Settings } from '../settings-types'
import type { LoadedSkill } from '../skills'
import type {
  ToolApprovalRequest,
  ToolContext,
  ToolPolicyDecision,
  ToolRegistration,
  ToolRegistry,
} from '../tools'
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
  RuntimeToolLoadInput,
  RuntimeTransientContextInput,
  RuntimeWorkspaceResolverInput,
} from './api-types'
import type { WorkbenchStore } from './repositories'

export type MaybePromise<T> = T | Promise<T>

export interface SessionCreatedHookEvent {
  summary: ConversationSummary
}

export interface SessionRenamedHookEvent {
  conversationId: string
  title: string
  summary: ConversationSummary
}

export interface SessionDeletedHookEvent {
  conversationId: string
}

export interface SessionNavigatedHookEvent {
  conversationId: string
  entryId: string
}

export interface SessionForkedHookEvent {
  sourceConversationId: string
  summary: ConversationSummary
}

export interface SessionPhaseChangedHookEvent {
  conversationId: string
  phase: SessionPhase
  previous: SessionPhase | null
}

export interface TurnStartingHookEvent {
  conversationId: string
  turnId: string
  runId: string
  assistantMessageId: string
  source: 'send' | 'retry'
}

export interface MessageCommittedHookEvent {
  conversationId: string
  message: PersistedMessage
}

/** Turn/run/step observations carry the persisted run event verbatim. */
export interface RunEventHookEvent {
  conversationId: string
  event: PersistedRunEvent
}

export interface RunSavePointHookEvent {
  conversationId: string
  runId: string
  reason: RunSavePointReason
}

export interface ToolPolicyHookEvent {
  request: ToolApprovalRequest
  decision: ToolPolicyDecision | null
}

export interface ToolApprovalRequestedHookEvent {
  request: ToolApprovalRequest
}

export interface ToolApprovalResolvedHookEvent {
  request: ToolApprovalRequest
  approved: boolean
}

export interface ToolExecutionStartedHookEvent {
  conversationId: string
  event: ToolCallEvent
}

export interface ToolExecutionCompletedHookEvent {
  conversationId: string
  event: ToolResultEvent
}

export interface ContextAssembledHookEvent {
  conversationId: string
  runId: string
  plan: AgentContextPlan
}

export interface ContextCompactingHookEvent {
  conversationId: string
  trigger: 'auto' | 'manual'
}

export interface ContextCompactedHookEvent {
  conversationId: string
  trigger: 'auto' | 'manual'
  checkpoint: ConversationContextCheckpoint
}

/**
 * Host extension point: typed, observational lifecycle callbacks. Every hook
 * is fire-and-forget — dispatched synchronously, never awaited, and isolated
 * from the turn (a throwing hook is logged and swallowed). Payloads are cloned
 * per dispatch, so hooks cannot mutate runtime state. Decision-bearing
 * behavior stays on the dedicated host fields (`onToolPolicy`,
 * `onToolApproval`); kernel ports (`RunMachineOptions`, `RunPolicy`) are
 * executor internals, not host hooks.
 */
export interface RuntimeLifecycleHooks {
  session?: {
    onCreated?: (event: SessionCreatedHookEvent) => void
    onRenamed?: (event: SessionRenamedHookEvent) => void
    onDeleted?: (event: SessionDeletedHookEvent) => void
    onNavigated?: (event: SessionNavigatedHookEvent) => void
    onForked?: (event: SessionForkedHookEvent) => void
    onPhaseChanged?: (event: SessionPhaseChangedHookEvent) => void
  }
  turn?: {
    onStarting?: (event: TurnStartingHookEvent) => void
    onStarted?: (event: RunEventHookEvent) => void
    onCommitted?: (event: MessageCommittedHookEvent) => void
    onCompleted?: (event: RunEventHookEvent) => void
    onFailed?: (event: RunEventHookEvent) => void
    onAborted?: (event: RunEventHookEvent) => void
  }
  run?: {
    onStarted?: (event: RunEventHookEvent) => void
    onPaused?: (event: RunEventHookEvent) => void
    onResumed?: (event: RunEventHookEvent) => void
    onCompleted?: (event: RunEventHookEvent) => void
    onFailed?: (event: RunEventHookEvent) => void
    onCancelled?: (event: RunEventHookEvent) => void
    onSavePoint?: (event: RunSavePointHookEvent) => void
  }
  step?: {
    onStarted?: (event: RunEventHookEvent) => void
    onCompleted?: (event: RunEventHookEvent) => void
    onFailed?: (event: RunEventHookEvent) => void
    onCancelled?: (event: RunEventHookEvent) => void
  }
  tool?: {
    onPolicy?: (event: ToolPolicyHookEvent) => void
    onApprovalRequested?: (event: ToolApprovalRequestedHookEvent) => void
    onApprovalResolved?: (event: ToolApprovalResolvedHookEvent) => void
    onExecutionStarted?: (event: ToolExecutionStartedHookEvent) => void
    onExecutionCompleted?: (event: ToolExecutionCompletedHookEvent) => void
  }
  context?: {
    onAssembled?: (event: ContextAssembledHookEvent) => void
    onCompacting?: (event: ContextCompactingHookEvent) => void
    onCompacted?: (event: ContextCompactedHookEvent) => void
  }
}

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
  tools?: readonly ToolRegistration[]
  loadTools?: (input?: RuntimeToolLoadInput) => Promise<readonly ToolRegistration[]>
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
  hooks?: RuntimeLifecycleHooks
  logger?: Pick<Console, 'error' | 'warn'>
}

export interface WorkbenchOptions extends WorkbenchHost {
  host?: WorkbenchHost
  store?: WorkbenchStore
  tools?: readonly ToolRegistration[]
  skills?: readonly LoadedSkill[]
  abortAllCleanupTimeoutMs?: number
}

export interface WorkbenchSessionApi {
  /** Per-session event subscription — the pre-hooks observation channel. */
  subscribeSession(conversationId: string, listener: (event: WorkbenchEvent) => void): () => void
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
  getToolRegistry(input?: RuntimeToolLoadInput): Promise<ToolRegistry>
  getSkills(): Promise<LoadedSkill[]>
  reloadTools(): Promise<ToolRegistry>
  executeTool(input: RuntimeExecuteToolInput): Promise<string>
}

export interface Workbench extends WorkbenchSessionApi, WorkbenchRunApi, WorkbenchExtensionApi {}

/**
 * Every WorkbenchHost field must be classified: merged here, or deliberately
 * excluded (`tools` / `skills` flow through resolveStaticTools /
 * resolveStaticSkills instead). The exported assertion type below turns an
 * unclassified new field into a compile error.
 */
const WORKBENCH_HOST_MERGE_KEYS = [
  'createId',
  'createRunId',
  'createEventId',
  'now',
  'onEvent',
  'onToolPolicy',
  'onToolApproval',
  'onConversationAbort',
  'cleanupConversationAssets',
  'persistAttachment',
  'loadTools',
  'loadSkills',
  'loadSettings',
  'loadStableInstructions',
  'loadTransientContext',
  'countContextTokens',
  'generateContextCompactArtifact',
  'webSearch',
  'generateImage',
  'saveImage',
  'runShell',
  'fileSystem',
  'path',
  'workspaceRoots',
  'shellCwd',
  'getModelInfo',
  'runAgent',
  'sessionEntryTransforms',
  'sessionCustomEntryProjectors',
  'hooks',
  'logger',
] as const satisfies readonly (keyof WorkbenchHost)[]

type UnmergedHostKeys = Exclude<keyof WorkbenchHost, (typeof WORKBENCH_HOST_MERGE_KEYS)[number]>
type AssertStaticExtensionsOnly<T extends 'tools' | 'skills'> = T
export type _WorkbenchHostUnmergedKeys = AssertStaticExtensionsOnly<UnmergedHostKeys>

export function normalizeRuntimeHost(options: WorkbenchOptions): WorkbenchHost {
  const host: WorkbenchHost = {}
  for (const layer of [options, options.host]) {
    if (!layer) continue
    for (const key of WORKBENCH_HOST_MERGE_KEYS) {
      const value = layer[key]
      if (value !== undefined) {
        ;(host as Record<(typeof WORKBENCH_HOST_MERGE_KEYS)[number], unknown>)[key] = value
      }
    }
  }
  return host
}
