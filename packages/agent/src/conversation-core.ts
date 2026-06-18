import type { AgentEvent } from './agent-protocol'
import type { ProviderId } from './models'

export const AILA_CONVERSATION_META_SCHEMA_VERSION = 1
export const AILA_PERSISTED_MESSAGE_SCHEMA_VERSION = 1
export const AILA_AGENT_EVENT_SCHEMA_VERSION = 1
export const AILA_CONTEXT_CHECKPOINT_SCHEMA_VERSION = 1
export const AILA_CONTEXT_ARTIFACT_SCHEMA_VERSION = 1
export const AILA_CONTEXT_TURN_LEDGER_SCHEMA_VERSION = 1

export const DEFAULT_CONVERSATION_TITLE = '新对话'
const CONVERSATION_TITLE_MAX = 40
const CONTEXT_CHECKPOINT_SUMMARY_MAX = 32_000
const CONTEXT_ARTIFACT_ITEM_MAX = 20
const CONTEXT_ARTIFACT_TEXT_MAX = 2_000
const CONTEXT_TURN_LEDGER_MAX = 50

export interface PersistedTextBlock {
  type: 'text' | 'reasoning'
  content: string
}

export interface PersistedToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error'
  result?: string
  resultRef?: PersistedToolResultRef
}

export interface PersistedToolResultRef {
  kind: 'file'
  path: string
  relativePath: string
  sizeChars: number
  preview: string
}

export interface ConversationCompactFileArtifact {
  path: string
  mentions: number
}

export interface ConversationCompactToolActivity {
  name: string
  count: number
}

export interface ConversationCompactToolResultArtifact {
  toolCallId: string
  toolName: string
  sizeChars: number
  preview: string
  path?: string
  relativePath?: string
}

export interface ConversationCompactArtifact {
  schemaVersion: typeof AILA_CONTEXT_ARTIFACT_SCHEMA_VERSION
  summary: string
  userRequests: string[]
  decisions: string[]
  files: ConversationCompactFileArtifact[]
  toolActivity: ConversationCompactToolActivity[]
  toolResults: ConversationCompactToolResultArtifact[]
  nextSteps: string[]
}

export interface PersistedImageBlock {
  type: 'image'
  url: string // aila-image://i/<filename>
  mime: string
  prompt?: string
}

/** A text file (or doc reference) the user attached to their message. */
export interface PersistedFileBlock {
  type: 'file'
  name: string
  content: string
}

export type PersistedBlock =
  | PersistedTextBlock
  | PersistedToolCallBlock
  | PersistedImageBlock
  | PersistedFileBlock

export interface PersistedMessage {
  schemaVersion: typeof AILA_PERSISTED_MESSAGE_SCHEMA_VERSION
  id: string
  role: 'user' | 'assistant'
  blocks: PersistedBlock[]
  status: 'streaming' | 'done' | 'error'
  error?: string
  model?: { providerId: ProviderId; modelId: string }
}

export interface ConversationUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  updatedAt: number
  turnCount?: number
  cumulativePromptTokens?: number
  cumulativeCompletionTokens?: number
  cumulativeTotalTokens?: number
}

export interface ConversationContextCheckpoint {
  schemaVersion: typeof AILA_CONTEXT_CHECKPOINT_SCHEMA_VERSION
  id: string
  createdAt: number
  boundaryMessageId: string
  sourceMessageIds: string[]
  omittedRoundCount: number
  summary: string
  charCost: number
  artifact?: ConversationCompactArtifact
}

export interface ConversationContextLedgerSection {
  kind: string
  messageCount: number
  charCost: number
  estimatedTokens: number
}

export interface ConversationContextTokenPreflight {
  inputTokens: number
  method: string
  providerId?: ProviderId | 'unknown'
  model?: string
  countedAt: number
}

export interface ConversationContextTurnLedgerEntry {
  schemaVersion: typeof AILA_CONTEXT_TURN_LEDGER_SCHEMA_VERSION
  messageId: string
  createdAt: number
  providerId: ProviderId
  modelId: string
  estimatedInputTokens: number
  inputBudgetTokens: number
  remainingInputTokens: number
  sectionCount: number
  sections: ConversationContextLedgerSection[]
  preflight?: ConversationContextTokenPreflight
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  compaction: {
    activeCheckpointId: string | null
    recommendedCheckpointId: string | null
    omittedRoundCount: number
    shouldAutoCompact: boolean
  }
}

export interface ConversationContextState {
  checkpoint?: ConversationContextCheckpoint
  turns?: ConversationContextTurnLedgerEntry[]
}

export type ConversationActivityState =
  | 'planning'
  | 'plan_ready'
  | 'implementing_plan'
  | 'running'
  | 'approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ConversationActivity {
  state: ConversationActivityState
  title: string
  updatedAt: number
  eventType: AgentEvent['type']
  messageId: string
  detail?: string
  toolName?: string
}

export type ConversationRuntimeStatePhase =
  | 'idle'
  | 'planning'
  | 'plan_ready'
  | 'implementing_plan'
  | 'running'
  | 'approval'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ConversationRuntimePendingApproval {
  requestedAt: number
  requestId?: string
  toolCallId?: string
  toolName?: string
}

export interface ConversationRuntimeReplayTurn {
  conversationId: string
  assistantMessageId: string
  updatedAt: number
  eventType: AgentEvent['type']
  startedAt?: number
  selection?: PersistedMessage['model']
  pendingApproval?: ConversationRuntimePendingApproval
}

export interface ConversationRuntimeReplayPlan {
  planId: string
  updatedAt: number
  eventType: AgentEvent['type']
  title?: string
  status?: string
  taskId?: string
  questionId?: string
  driftId?: string
  summary?: string
}

export interface ConversationRuntimeReplayState {
  phase: ConversationRuntimeStatePhase
  active: boolean
  turn?: ConversationRuntimeReplayTurn
  plan?: ConversationRuntimeReplayPlan
}

export interface ConversationInterruptedRecoveryOptions {
  reason?: string
  timestamp?: number
  activity?: ConversationActivity
}

export interface ConversationWorkspaceRef {
  id: string
  path: string
  label?: string
}

export interface ConversationMeta {
  schemaVersion: typeof AILA_CONVERSATION_META_SCHEMA_VERSION
  id: string
  title: string
  createdAt: number
  updatedAt: number
  usage?: ConversationUsage
  activity?: ConversationActivity
  // When set, this conversation is the AI sidebar attached to a specific doc.
  // The chat tab filters these out; Desktop owns docs workspace behavior.
  docId?: string | null
  // Optional workspace affinity for chat sessions. Runtime preserves this as
  // metadata; hosts decide whether and how it affects tool roots.
  workspace?: ConversationWorkspaceRef | null
  context?: ConversationContextState
}

export type ConversationSummary = ConversationMeta

export interface ConversationRecord {
  meta: ConversationMeta
  messages: PersistedMessage[]
}

export interface PersistedAgentEvent extends AgentEvent {
  schemaVersion: typeof AILA_AGENT_EVENT_SCHEMA_VERSION
}

export interface AgentEventAppendResult {
  event: PersistedAgentEvent
  summary?: ConversationSummary
}

const CONVERSATION_ACTIVITY_STATES = new Set<ConversationActivityState>([
  'planning',
  'plan_ready',
  'implementing_plan',
  'running',
  'approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

export function normalizeConversationActivity(value: unknown): ConversationActivity | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<ConversationActivity>
  if (!record.state || !CONVERSATION_ACTIVITY_STATES.has(record.state)) return undefined
  if (typeof record.title !== 'string' || record.title.length === 0) return undefined
  if (typeof record.updatedAt !== 'number') return undefined
  if (typeof record.eventType !== 'string' || record.eventType.length === 0) return undefined
  if (typeof record.messageId !== 'string' || record.messageId.length === 0) return undefined
  return {
    state: record.state,
    title: record.title,
    updatedAt: record.updatedAt,
    eventType: record.eventType as AgentEvent['type'],
    messageId: record.messageId,
    ...(typeof record.detail === 'string' && record.detail.length > 0
      ? { detail: record.detail }
      : {}),
    ...(typeof record.toolName === 'string' && record.toolName.length > 0
      ? { toolName: record.toolName }
      : {}),
  }
}

export function normalizeConversationWorkspaceRef(
  value: unknown,
): ConversationWorkspaceRef | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<ConversationWorkspaceRef>
  if (typeof record.id !== 'string' || record.id.trim().length === 0) return undefined
  if (typeof record.path !== 'string' || record.path.trim().length === 0) return undefined
  const label =
    typeof record.label === 'string' && record.label.trim().length > 0
      ? record.label.trim()
      : undefined
  return {
    id: record.id.trim(),
    path: record.path.trim(),
    ...(label ? { label } : {}),
  }
}

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) =>
      item.trim().length > CONTEXT_ARTIFACT_TEXT_MAX
        ? item.trim().slice(0, CONTEXT_ARTIFACT_TEXT_MAX)
        : item.trim(),
    )
    .slice(0, CONTEXT_ARTIFACT_ITEM_MAX)
}

function normalizeConversationCompactFileArtifact(
  value: unknown,
): ConversationCompactFileArtifact | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<ConversationCompactFileArtifact>
  if (typeof record.path !== 'string' || record.path.trim().length === 0) return null
  return {
    path: record.path.trim(),
    mentions: typeof record.mentions === 'number' && record.mentions > 0 ? record.mentions : 1,
  }
}

function normalizeConversationCompactToolActivity(
  value: unknown,
): ConversationCompactToolActivity | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<ConversationCompactToolActivity>
  if (typeof record.name !== 'string' || record.name.trim().length === 0) return null
  return {
    name: record.name.trim(),
    count: typeof record.count === 'number' && record.count > 0 ? record.count : 1,
  }
}

function normalizeConversationCompactToolResultArtifact(
  value: unknown,
): ConversationCompactToolResultArtifact | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<ConversationCompactToolResultArtifact>
  if (typeof record.toolCallId !== 'string' || record.toolCallId.trim().length === 0) {
    return null
  }
  if (typeof record.toolName !== 'string' || record.toolName.trim().length === 0) return null
  const preview = typeof record.preview === 'string' ? record.preview : ''
  return {
    toolCallId: record.toolCallId.trim(),
    toolName: record.toolName.trim(),
    sizeChars: typeof record.sizeChars === 'number' && record.sizeChars >= 0 ? record.sizeChars : 0,
    preview:
      preview.length > CONTEXT_ARTIFACT_TEXT_MAX
        ? preview.slice(0, CONTEXT_ARTIFACT_TEXT_MAX)
        : preview,
    ...(typeof record.path === 'string' && record.path.trim().length > 0
      ? { path: record.path.trim() }
      : {}),
    ...(typeof record.relativePath === 'string' && record.relativePath.trim().length > 0
      ? { relativePath: record.relativePath.trim() }
      : {}),
  }
}

export function normalizeConversationCompactArtifact(
  value: unknown,
): ConversationCompactArtifact | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<ConversationCompactArtifact>
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) return undefined
  return {
    schemaVersion: AILA_CONTEXT_ARTIFACT_SCHEMA_VERSION,
    summary:
      record.summary.length > CONTEXT_CHECKPOINT_SUMMARY_MAX
        ? record.summary.slice(0, CONTEXT_CHECKPOINT_SUMMARY_MAX)
        : record.summary,
    userRequests: normalizeTextList(record.userRequests),
    decisions: normalizeTextList(record.decisions),
    files: Array.isArray(record.files)
      ? record.files
          .map(normalizeConversationCompactFileArtifact)
          .filter((item): item is ConversationCompactFileArtifact => item !== null)
          .slice(0, CONTEXT_ARTIFACT_ITEM_MAX)
      : [],
    toolActivity: Array.isArray(record.toolActivity)
      ? record.toolActivity
          .map(normalizeConversationCompactToolActivity)
          .filter((item): item is ConversationCompactToolActivity => item !== null)
          .slice(0, CONTEXT_ARTIFACT_ITEM_MAX)
      : [],
    toolResults: Array.isArray(record.toolResults)
      ? record.toolResults
          .map(normalizeConversationCompactToolResultArtifact)
          .filter((item): item is ConversationCompactToolResultArtifact => item !== null)
          .slice(0, CONTEXT_ARTIFACT_ITEM_MAX)
      : [],
    nextSteps: normalizeTextList(record.nextSteps),
  }
}

export function createConversationUsageSnapshot(
  current: ConversationUsage | undefined,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
  updatedAt: number,
): ConversationUsage {
  const previousTurnCount =
    typeof current?.turnCount === 'number' && current.turnCount >= 0
      ? current.turnCount
      : current
        ? 1
        : 0
  const previousPrompt = current?.cumulativePromptTokens ?? current?.promptTokens ?? 0
  const previousCompletion = current?.cumulativeCompletionTokens ?? current?.completionTokens ?? 0
  const previousTotal = current?.cumulativeTotalTokens ?? current?.totalTokens ?? 0
  return {
    ...usage,
    updatedAt,
    turnCount: previousTurnCount + 1,
    cumulativePromptTokens: previousPrompt + usage.promptTokens,
    cumulativeCompletionTokens: previousCompletion + usage.completionTokens,
    cumulativeTotalTokens: previousTotal + usage.totalTokens,
  }
}

function normalizeConversationContextLedgerSection(
  value: unknown,
): ConversationContextLedgerSection | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<ConversationContextLedgerSection>
  if (typeof record.kind !== 'string' || record.kind.trim().length === 0) return null
  return {
    kind: record.kind.trim(),
    messageCount:
      typeof record.messageCount === 'number' && record.messageCount >= 0 ? record.messageCount : 0,
    charCost: typeof record.charCost === 'number' && record.charCost >= 0 ? record.charCost : 0,
    estimatedTokens:
      typeof record.estimatedTokens === 'number' && record.estimatedTokens >= 0
        ? record.estimatedTokens
        : 0,
  }
}

function normalizeConversationContextTokenPreflight(
  value: unknown,
): ConversationContextTokenPreflight | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<ConversationContextTokenPreflight>
  if (typeof record.inputTokens !== 'number' || record.inputTokens < 0) return undefined
  return {
    inputTokens: record.inputTokens,
    method:
      typeof record.method === 'string' && record.method.trim().length > 0
        ? record.method.trim()
        : 'unknown',
    ...(typeof record.providerId === 'string' && record.providerId.trim().length > 0
      ? { providerId: record.providerId.trim() as ProviderId | 'unknown' }
      : {}),
    ...(typeof record.model === 'string' && record.model.trim().length > 0
      ? { model: record.model.trim() }
      : {}),
    countedAt: typeof record.countedAt === 'number' ? record.countedAt : Date.now(),
  }
}

function normalizeConversationContextTurnLedgerEntry(
  value: unknown,
): ConversationContextTurnLedgerEntry | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<ConversationContextTurnLedgerEntry>
  if (typeof record.messageId !== 'string' || record.messageId.trim().length === 0) return null
  if (typeof record.providerId !== 'string' || record.providerId.trim().length === 0) return null
  if (typeof record.modelId !== 'string' || record.modelId.trim().length === 0) return null
  const usage =
    record.usage &&
    typeof record.usage.promptTokens === 'number' &&
    typeof record.usage.completionTokens === 'number' &&
    typeof record.usage.totalTokens === 'number'
      ? {
          promptTokens: record.usage.promptTokens,
          completionTokens: record.usage.completionTokens,
          totalTokens: record.usage.totalTokens,
        }
      : undefined
  return {
    schemaVersion: AILA_CONTEXT_TURN_LEDGER_SCHEMA_VERSION,
    messageId: record.messageId.trim(),
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    providerId: record.providerId.trim() as ProviderId,
    modelId: record.modelId.trim(),
    estimatedInputTokens:
      typeof record.estimatedInputTokens === 'number' && record.estimatedInputTokens >= 0
        ? record.estimatedInputTokens
        : 0,
    inputBudgetTokens:
      typeof record.inputBudgetTokens === 'number' && record.inputBudgetTokens >= 0
        ? record.inputBudgetTokens
        : 0,
    remainingInputTokens:
      typeof record.remainingInputTokens === 'number' ? record.remainingInputTokens : 0,
    sectionCount:
      typeof record.sectionCount === 'number' && record.sectionCount >= 0 ? record.sectionCount : 0,
    sections: Array.isArray(record.sections)
      ? record.sections
          .map(normalizeConversationContextLedgerSection)
          .filter((section): section is ConversationContextLedgerSection => section !== null)
          .slice(0, CONTEXT_ARTIFACT_ITEM_MAX)
      : [],
    ...(normalizeConversationContextTokenPreflight(record.preflight)
      ? { preflight: normalizeConversationContextTokenPreflight(record.preflight) }
      : {}),
    ...(usage ? { usage } : {}),
    compaction: {
      activeCheckpointId:
        typeof record.compaction?.activeCheckpointId === 'string'
          ? record.compaction.activeCheckpointId
          : null,
      recommendedCheckpointId:
        typeof record.compaction?.recommendedCheckpointId === 'string'
          ? record.compaction.recommendedCheckpointId
          : null,
      omittedRoundCount:
        typeof record.compaction?.omittedRoundCount === 'number' &&
        record.compaction.omittedRoundCount >= 0
          ? record.compaction.omittedRoundCount
          : 0,
      shouldAutoCompact: record.compaction?.shouldAutoCompact === true,
    },
  }
}

export function appendConversationContextTurnLedgerEntry(
  current: ConversationContextState | undefined,
  entry: ConversationContextTurnLedgerEntry,
): ConversationContextState {
  const turns = [...(current?.turns ?? []), structuredClone(entry)]
  return {
    ...(current ?? {}),
    turns: turns.slice(-CONTEXT_TURN_LEDGER_MAX),
  }
}

export function normalizeConversationContextCheckpoint(
  value: unknown,
): ConversationContextCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<ConversationContextCheckpoint>
  if (typeof record.id !== 'string' || record.id.trim().length === 0) return undefined
  if (
    typeof record.boundaryMessageId !== 'string' ||
    record.boundaryMessageId.trim().length === 0
  ) {
    return undefined
  }
  if (!Array.isArray(record.sourceMessageIds)) return undefined
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) return undefined
  const artifact = normalizeConversationCompactArtifact(record.artifact)
  return {
    schemaVersion: AILA_CONTEXT_CHECKPOINT_SCHEMA_VERSION,
    id: record.id.trim(),
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    boundaryMessageId: record.boundaryMessageId.trim(),
    sourceMessageIds: record.sourceMessageIds
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim()),
    omittedRoundCount:
      typeof record.omittedRoundCount === 'number' && record.omittedRoundCount >= 0
        ? record.omittedRoundCount
        : 0,
    summary:
      record.summary.length > CONTEXT_CHECKPOINT_SUMMARY_MAX
        ? record.summary.slice(0, CONTEXT_CHECKPOINT_SUMMARY_MAX)
        : record.summary,
    charCost: typeof record.charCost === 'number' && record.charCost >= 0 ? record.charCost : 0,
    ...(artifact ? { artifact } : {}),
  }
}

export function normalizeConversationContextState(
  value: unknown,
): ConversationContextState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const checkpoint = normalizeConversationContextCheckpoint(
    (value as Partial<ConversationContextState>).checkpoint,
  )
  const turns = Array.isArray((value as Partial<ConversationContextState>).turns)
    ? (value as Partial<ConversationContextState>).turns
        ?.map(normalizeConversationContextTurnLedgerEntry)
        .filter((entry): entry is ConversationContextTurnLedgerEntry => entry !== null)
        .slice(-CONTEXT_TURN_LEDGER_MAX)
    : undefined
  return checkpoint || (turns && turns.length > 0)
    ? { ...(checkpoint ? { checkpoint } : {}), ...(turns && turns.length > 0 ? { turns } : {}) }
    : undefined
}

export function normalizeConversationMeta(
  value: Partial<ConversationMeta>,
  fallbackId?: string,
): ConversationMeta {
  const now = Date.now()
  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : fallbackId
  if (!id) throw new Error('conversation meta is missing id')
  const activity = normalizeConversationActivity(value.activity)
  const workspace = normalizeConversationWorkspaceRef(value.workspace)
  const context = normalizeConversationContextState(value.context)

  return {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id,
    title:
      typeof value.title === 'string' && value.title.length > 0
        ? value.title
        : DEFAULT_CONVERSATION_TITLE,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
    ...(value.usage ? { usage: value.usage } : {}),
    ...(activity ? { activity } : {}),
    ...(value.docId !== undefined ? { docId: value.docId } : {}),
    ...(value.workspace === null ? { workspace: null } : workspace ? { workspace } : {}),
    ...(context ? { context } : {}),
  }
}

export function normalizePersistedMessage(
  value: Partial<PersistedMessage>,
): PersistedMessage | null {
  if (typeof value.id !== 'string' || value.id.length === 0) return null
  if (value.role !== 'user' && value.role !== 'assistant') return null
  if (!Array.isArray(value.blocks)) return null
  if (value.status !== 'streaming' && value.status !== 'done' && value.status !== 'error') {
    return null
  }

  return {
    schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
    id: value.id,
    role: value.role,
    blocks: value.blocks,
    status: value.status,
    ...(value.error !== undefined && { error: value.error }),
    ...(value.model !== undefined && { model: value.model }),
  }
}

export function preparePersistedMessage(message: PersistedMessage): PersistedMessage {
  return {
    ...message,
    schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  }
}

export function upsertPersistedMessage(
  messages: PersistedMessage[],
  message: PersistedMessage,
): void {
  const existing = messages.findIndex((candidate) => candidate.id === message.id)
  if (existing !== -1) messages.splice(existing, 1)
  messages.push(message)
}

export function prepareAgentEvent(event: AgentEvent): PersistedAgentEvent {
  return {
    ...event,
    schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
  }
}

function agentEventReplayKey(event: PersistedAgentEvent): string {
  return [
    event.timestamp,
    event.conversationId,
    event.messageId,
    event.type,
    JSON.stringify(event.data ?? {}),
  ].join(':')
}

export function orderedUniqueAgentEvents(
  events: readonly PersistedAgentEvent[],
): PersistedAgentEvent[] {
  const seen = new Set<string>()
  const ordered: PersistedAgentEvent[] = []
  const indexed = events.map((event, index) => ({ event, index }))
  indexed.sort((left, right) => {
    const timestampOrder = left.event.timestamp - right.event.timestamp
    return timestampOrder === 0 ? left.index - right.index : timestampOrder
  })
  for (const { event } of indexed) {
    const key = agentEventReplayKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    ordered.push(event)
  }
  return ordered
}

export function normalizeAgentEvent(
  value: Partial<PersistedAgentEvent>,
  fallbackConversationId?: string,
): PersistedAgentEvent | null {
  const conversationId =
    typeof value.conversationId === 'string' && value.conversationId.length > 0
      ? value.conversationId
      : fallbackConversationId
  if (!conversationId) return null
  if (typeof value.messageId !== 'string' || value.messageId.length === 0) return null
  if (typeof value.type !== 'string' || value.type.length === 0) return null

  return {
    schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
    timestamp: typeof value.timestamp === 'number' ? value.timestamp : Date.now(),
    conversationId,
    messageId: value.messageId,
    type: value.type as AgentEvent['type'],
    ...(value.data &&
      typeof value.data === 'object' && {
        data: value.data as Record<string, unknown>,
      }),
  }
}

export function deriveConversationTitle(message: PersistedMessage): string | null {
  if (message.role !== 'user') return null
  const text = message.blocks
    .filter((block): block is PersistedTextBlock => block.type === 'text')
    .map((block) => block.content)
    .join('')
    .trim()
  if (!text) return null
  return text.length > CONVERSATION_TITLE_MAX ? `${text.slice(0, CONVERSATION_TITLE_MAX)}…` : text
}

function dataString(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function dataSelection(data: Record<string, unknown> | undefined): PersistedMessage['model'] {
  const providerId = dataString(data, 'providerId')
  const modelId = dataString(data, 'modelId')
  if (!providerId || !modelId) return undefined
  return { providerId: providerId as ProviderId, modelId }
}

function dataBool(data: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = data?.[key]
  return typeof value === 'boolean' ? value : undefined
}

function dataPreview(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key]
  if (!value || typeof value !== 'object') return undefined
  const preview = (value as { preview?: unknown }).preview
  return typeof preview === 'string' && preview.length > 0 ? preview : undefined
}

function joinDetail(...values: Array<string | undefined>): string | undefined {
  const detail = values.filter((value): value is string => Boolean(value)).join(' · ')
  return detail.length > 0 ? detail : undefined
}

export function activityFromAgentEvent(event: PersistedAgentEvent): ConversationActivity | null {
  const data = event.data
  const toolName = dataString(data, 'toolName')
  const toolLabel = toolName ?? 'tool'
  const target = dataPreview(data, 'target')
  const base = {
    updatedAt: event.timestamp,
    eventType: event.type,
    messageId: event.messageId,
    ...(toolName ? { toolName } : {}),
  }

  switch (event.type) {
    case 'turn.started':
      return {
        ...base,
        state: 'running',
        title: 'Model streaming',
        detail: dataString(data, 'modelId'),
      }
    case 'turn.completed':
      return { ...base, state: 'completed', title: 'Done' }
    case 'turn.failed':
      return {
        ...base,
        state: 'failed',
        title: 'Error',
        detail: dataString(data, 'error'),
      }
    case 'turn.cancelled':
      return {
        ...base,
        state: 'cancelled',
        title: dataString(data, 'phase') === 'requested' ? 'Stop requested' : 'Stopped',
        detail: dataString(data, 'reason'),
      }
    case 'turn.interrupted':
      return {
        ...base,
        state: 'interrupted',
        title: 'Interrupted',
        detail: dataString(data, 'reason'),
      }
    case 'context:compacting':
      return {
        ...base,
        state: 'running',
        title: 'Compacting context',
        detail: joinDetail(dataString(data, 'reason'), dataString(data, 'checkpointId')),
      }
    case 'context:compacted':
      return {
        ...base,
        state: 'completed',
        title: 'Context compacted',
        detail: joinDetail(dataString(data, 'checkpointId'), dataString(data, 'modelId')),
      }
    case 'tool.requested':
      return { ...base, state: 'running', title: `Tool requested: ${toolLabel}`, detail: target }
    case 'tool.input.delta':
      return null
    case 'tool.input.completed':
      return {
        ...base,
        state: 'running',
        title: `Args ready: ${toolLabel}`,
        detail: target ?? dataPreview(data, 'input'),
      }
    case 'tool.execution.started':
      return { ...base, state: 'running', title: `Running: ${toolLabel}`, detail: target }
    case 'tool.execution.completed':
      return {
        ...base,
        state: 'running',
        title: `Tool completed: ${toolLabel}`,
        detail: target ?? dataPreview(data, 'result'),
      }
    case 'tool.execution.failed':
      return {
        ...base,
        state: 'failed',
        title: `Tool failed: ${toolLabel}`,
        detail: joinDetail(target, dataString(data, 'error')),
      }
    case 'tool.result.returned':
      return {
        ...base,
        state: dataBool(data, 'isError') ? 'failed' : 'running',
        title: dataBool(data, 'isError')
          ? `Tool result failed: ${toolLabel}`
          : `Tool result returned: ${toolLabel}`,
        detail: target ?? dataPreview(data, 'result'),
      }
    case 'tool.approval.requested':
      return {
        ...base,
        state: 'approval',
        title: `Approval pending: ${toolLabel}`,
        detail: joinDetail(dataString(data, 'risk'), target),
      }
    case 'tool.approval.resolved': {
      const approved = dataBool(data, 'approved') === true
      return {
        ...base,
        state: approved ? 'running' : 'failed',
        title: approved ? `Approved: ${toolLabel}` : `Denied: ${toolLabel}`,
        detail: dataString(data, 'reason'),
      }
    }
    case 'plan.started':
      return {
        ...base,
        state: 'planning',
        title: 'Planning started',
        detail: joinDetail(dataString(data, 'title'), dataString(data, 'planId')),
      }
    case 'plan.exploring':
      return {
        ...base,
        state: 'planning',
        title: 'Exploring plan',
        detail: joinDetail(dataString(data, 'summary'), dataString(data, 'planId')),
      }
    case 'plan.question.requested':
      return {
        ...base,
        state: 'planning',
        title: 'Plan needs input',
        detail: joinDetail(
          dataString(data, 'questionId'),
          dataString(data, 'prompt'),
          dataString(data, 'summary'),
        ),
      }
    case 'plan.question.answered':
      return {
        ...base,
        state: 'planning',
        title: 'Plan input answered',
        detail: joinDetail(dataString(data, 'questionId'), dataString(data, 'summary')),
      }
    case 'plan.updated':
      return {
        ...base,
        state: 'planning',
        title: 'Plan updated',
        detail: joinDetail(dataString(data, 'title'), dataString(data, 'summary')),
      }
    case 'plan.ready':
      return {
        ...base,
        state: 'plan_ready',
        title: 'Plan ready',
        detail: joinDetail(dataString(data, 'title'), dataString(data, 'summary')),
      }
    case 'plan.approved':
      return {
        ...base,
        state: 'plan_ready',
        title: 'Plan approved',
        detail: joinDetail(dataString(data, 'title'), dataString(data, 'summary')),
      }
    case 'plan.rejected':
      return {
        ...base,
        state: 'cancelled',
        title: 'Plan rejected',
        detail: dataString(data, 'reason'),
      }
    case 'plan.cancelled':
      return {
        ...base,
        state: 'cancelled',
        title: 'Plan cancelled',
        detail: dataString(data, 'reason'),
      }
    case 'plan.implementation.started':
      return {
        ...base,
        state: 'implementing_plan',
        title: 'Implementing plan',
        detail: joinDetail(dataString(data, 'title'), dataString(data, 'planId')),
      }
    case 'plan.task.started':
      return {
        ...base,
        state: 'implementing_plan',
        title: 'Plan task started',
        detail: joinDetail(dataString(data, 'taskId'), dataString(data, 'summary')),
      }
    case 'plan.task.completed':
      return {
        ...base,
        state: 'implementing_plan',
        title: 'Plan task completed',
        detail: joinDetail(dataString(data, 'taskId'), dataString(data, 'summary')),
      }
    case 'plan.task.blocked':
      return {
        ...base,
        state: 'implementing_plan',
        title: 'Plan task blocked',
        detail: joinDetail(dataString(data, 'taskId'), dataString(data, 'summary')),
      }
    case 'plan.drift.detected':
      return {
        ...base,
        state: 'implementing_plan',
        title: 'Plan drift detected',
        detail: joinDetail(dataString(data, 'driftId'), dataString(data, 'summary')),
      }
    case 'plan.completed':
      return {
        ...base,
        state: 'completed',
        title: 'Plan completed',
        detail: joinDetail(dataString(data, 'title'), dataString(data, 'summary')),
      }
  }
}

export function replayConversationActivity(
  events: readonly PersistedAgentEvent[],
): ConversationActivity | undefined {
  let activity: ConversationActivity | undefined
  for (const event of orderedUniqueAgentEvents(events)) {
    const next = activityFromAgentEvent(event)
    if (!next) continue
    if (activity && activity.updatedAt > next.updatedAt) continue
    activity = next
  }
  return activity
}

function isActiveRuntimePhase(phase: ConversationRuntimeStatePhase): boolean {
  return (
    phase === 'planning' ||
    phase === 'implementing_plan' ||
    phase === 'running' ||
    phase === 'approval' ||
    phase === 'cancelling'
  )
}

function runtimeReplayState(
  phase: ConversationRuntimeStatePhase,
  turn?: ConversationRuntimeReplayTurn,
  plan?: ConversationRuntimeReplayPlan,
): ConversationRuntimeReplayState {
  return {
    phase,
    active: isActiveRuntimePhase(phase),
    ...(turn ? { turn } : {}),
    ...(plan ? { plan } : {}),
  }
}

function pendingApprovalFromEvent(event: PersistedAgentEvent): ConversationRuntimePendingApproval {
  const requestId = dataString(event.data, 'requestId')
  const toolCallId = dataString(event.data, 'toolCallId')
  const toolName = dataString(event.data, 'toolName')
  return {
    requestedAt: event.timestamp,
    ...(requestId ? { requestId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
  }
}

function runtimeTurnFromEvent(
  state: ConversationRuntimeReplayState,
  event: PersistedAgentEvent,
  options: {
    startedAt?: number
    selection?: PersistedMessage['model']
    pendingApproval?: ConversationRuntimePendingApproval
    clearPendingApproval?: boolean
  } = {},
): ConversationRuntimeReplayTurn {
  const previous = state.turn?.assistantMessageId === event.messageId ? state.turn : undefined
  const startedAt = options.startedAt ?? previous?.startedAt
  const selection = options.selection ?? dataSelection(event.data) ?? previous?.selection
  const turn: ConversationRuntimeReplayTurn = {
    conversationId: event.conversationId,
    assistantMessageId: event.messageId,
    updatedAt: event.timestamp,
    eventType: event.type,
  }
  if (startedAt !== undefined) turn.startedAt = startedAt
  if (selection) turn.selection = selection
  if (options.pendingApproval) {
    turn.pendingApproval = options.pendingApproval
  } else if (!options.clearPendingApproval && previous?.pendingApproval) {
    turn.pendingApproval = previous.pendingApproval
  }
  return turn
}

function runtimePlanFromEvent(
  state: ConversationRuntimeReplayState,
  event: PersistedAgentEvent,
): ConversationRuntimeReplayPlan | undefined {
  const planId = dataString(event.data, 'planId') ?? state.plan?.planId
  if (!planId) return undefined
  const title = dataString(event.data, 'title') ?? state.plan?.title
  const status = dataString(event.data, 'status') ?? state.plan?.status
  const taskId = dataString(event.data, 'taskId') ?? state.plan?.taskId
  const questionId = dataString(event.data, 'questionId') ?? state.plan?.questionId
  const driftId = dataString(event.data, 'driftId') ?? state.plan?.driftId
  const summary = dataString(event.data, 'summary') ?? state.plan?.summary
  return {
    planId,
    updatedAt: event.timestamp,
    eventType: event.type,
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(taskId ? { taskId } : {}),
    ...(questionId ? { questionId } : {}),
    ...(driftId ? { driftId } : {}),
    ...(summary ? { summary } : {}),
  }
}

function nonTerminalToolPhase(
  state: ConversationRuntimeReplayState,
): ConversationRuntimeStatePhase {
  if (state.phase === 'implementing_plan') return 'implementing_plan'
  return state.phase === 'cancelling' ? 'cancelling' : 'running'
}

export function replayConversationRuntimeState(
  events: readonly PersistedAgentEvent[],
): ConversationRuntimeReplayState {
  let state = runtimeReplayState('idle')

  for (const event of orderedUniqueAgentEvents(events)) {
    switch (event.type) {
      case 'turn.started':
        state = runtimeReplayState(
          state.phase === 'implementing_plan' && state.plan ? 'implementing_plan' : 'running',
          runtimeTurnFromEvent(state, event, {
            startedAt: event.timestamp,
            selection: dataSelection(event.data),
            clearPendingApproval: true,
          }),
          state.plan,
        )
        break
      case 'turn.completed':
        state = runtimeReplayState(
          'completed',
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
          state.plan,
        )
        break
      case 'turn.failed':
        state = runtimeReplayState(
          'failed',
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
          state.plan,
        )
        break
      case 'turn.cancelled': {
        const phase = dataString(event.data, 'phase') === 'completed' ? 'cancelled' : 'cancelling'
        state = runtimeReplayState(
          phase,
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
          state.plan,
        )
        break
      }
      case 'turn.interrupted':
        state = runtimeReplayState(
          'interrupted',
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
          state.plan,
        )
        break
      case 'tool.approval.requested':
        state = runtimeReplayState(
          'approval',
          runtimeTurnFromEvent(state, event, {
            pendingApproval: pendingApprovalFromEvent(event),
          }),
          state.plan,
        )
        break
      case 'tool.approval.resolved':
        state = runtimeReplayState(
          nonTerminalToolPhase(state),
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
          state.plan,
        )
        break
      case 'tool.execution.started':
      case 'tool.execution.completed':
      case 'tool.execution.failed':
      case 'tool.result.returned':
        state = runtimeReplayState(
          nonTerminalToolPhase(state),
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
          state.plan,
        )
        break
      case 'tool.requested':
      case 'tool.input.delta':
      case 'tool.input.completed':
        state = runtimeReplayState(
          nonTerminalToolPhase(state),
          runtimeTurnFromEvent(state, event),
          state.plan,
        )
        break
      case 'plan.started':
      case 'plan.exploring':
      case 'plan.question.requested':
      case 'plan.question.answered':
      case 'plan.updated':
        state = runtimeReplayState(
          'planning',
          runtimeTurnFromEvent(state, event),
          runtimePlanFromEvent(state, event),
        )
        break
      case 'plan.ready':
      case 'plan.approved':
        state = runtimeReplayState(
          'plan_ready',
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
          runtimePlanFromEvent(state, event),
        )
        break
      case 'plan.implementation.started':
      case 'plan.task.started':
      case 'plan.task.completed':
      case 'plan.task.blocked':
      case 'plan.drift.detected':
        state = runtimeReplayState(
          'implementing_plan',
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
          runtimePlanFromEvent(state, event),
        )
        break
      case 'plan.rejected':
      case 'plan.cancelled':
        state = runtimeReplayState(
          'cancelled',
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
          runtimePlanFromEvent(state, event),
        )
        break
      case 'plan.completed':
        state = runtimeReplayState(
          'completed',
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
          runtimePlanFromEvent(state, event),
        )
        break
    }
  }

  return state
}

export function createInterruptedConversationRecoveryEvent(
  events: readonly PersistedAgentEvent[],
  options: ConversationInterruptedRecoveryOptions = {},
): AgentEvent | null {
  const runtimeState = replayConversationRuntimeState(events)
  if (!runtimeState.active || !runtimeState.turn) return null

  const activity =
    options.activity?.messageId === runtimeState.turn.assistantMessageId
      ? options.activity
      : undefined
  const selection = runtimeState.turn.selection

  return {
    timestamp: options.timestamp ?? Date.now(),
    conversationId: runtimeState.turn.conversationId,
    messageId: runtimeState.turn.assistantMessageId,
    type: 'turn.interrupted',
    data: {
      reason: options.reason ?? 'runtime restarted before this turn finished',
      previousState: runtimeState.phase,
      previousEventType: runtimeState.turn.eventType,
      previousTitle: activity?.title ?? runtimeState.turn.eventType,
      ...(selection && { providerId: selection.providerId, modelId: selection.modelId }),
    },
  }
}

export function interruptedRecoveryEventFromLegacyActivity(
  conversationId: string,
  activity: ConversationActivity | undefined,
  reason: string,
): AgentEvent | null {
  if (
    !activity ||
    (activity.state !== 'planning' &&
      activity.state !== 'implementing_plan' &&
      activity.state !== 'running' &&
      activity.state !== 'approval')
  ) {
    return null
  }
  return {
    timestamp: Date.now(),
    conversationId,
    messageId: activity.messageId,
    type: 'turn.interrupted',
    data: {
      reason,
      previousState: activity.state,
      previousEventType: activity.eventType,
      previousTitle: activity.title,
    },
  }
}

export function conversationActivityEquals(
  left: ConversationActivity | undefined,
  right: ConversationActivity | undefined,
): boolean {
  return (
    left?.state === right?.state &&
    left?.title === right?.title &&
    left?.updatedAt === right?.updatedAt &&
    left?.eventType === right?.eventType &&
    left?.messageId === right?.messageId &&
    left?.detail === right?.detail &&
    left?.toolName === right?.toolName
  )
}
