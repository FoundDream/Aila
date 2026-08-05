import type { ChatMessage, ModelSelection, RunEvent } from '../agent-protocol'
import type { AgentContextPlan, AgentContextRecommendedCheckpoint } from '../context'
import type {
  ConversationCompactArtifact,
  ConversationContextCheckpoint,
  ConversationRecord,
  ConversationRuntimeReplayState,
  ConversationSummary,
  ConversationWorkspaceRef,
  PersistedBlock,
  PersistedMessage,
  PersistedRunEvent,
} from '../conversation-core'
import type { RunPayload, RunSnapshot } from '../run-persistence'
import type {
  SessionExtensionData,
  SessionExtensionMessageData,
  SessionPhase,
} from '../session-journal'
export interface RuntimeToolLoadInput {
  conversationId?: string
  record?: ConversationRecord
}

export type RuntimeRecordRunEventInput = RunEvent

export type ConversationAbortReason = 'user' | 'delete' | 'shutdown'

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
  loopMode?: 'continuous' | 'step'
  attachments?: ChatAttachmentInput[]
  transientContext?: ChatMessage[]
}

export interface RuntimeRetryLastInput {
  conversationId: string
  selection: ModelSelection
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

export type RuntimeAvailabilityBlockReason = 'shutdown' | 'deleted' | 'turn_active' | 'phase_busy'

/**
 * Engine-derived snapshot of what a session currently permits. Single source
 * for the state clients previously recombined from phase, active turns and
 * run summaries. Advisory for UIs; the engine guards remain authoritative.
 */
export interface RuntimeSessionAvailability {
  conversationId: string
  phase: SessionPhase
  activeTurn: ActiveAssistantTurn | null
  /** Primary blocker; priority shutdown > deleted > turn_active > phase_busy. */
  blocked: RuntimeAvailabilityBlockReason | null
  allows: {
    startTurn: boolean
    mutateSession: boolean
    resumeRun: boolean
    steer: boolean
    followUp: boolean
    nextTurn: boolean
    abort: boolean
  }
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
  conversationId?: string
  messageId?: string
  toolCallId?: string
  signal?: AbortSignal
}

export interface RuntimeWorkspaceResolverInput {
  conversationId?: string
  workspace?: ConversationWorkspaceRef | null
}
