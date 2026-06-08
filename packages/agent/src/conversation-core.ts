import type { AgentEvent } from './agent-protocol'
import type { ProviderId } from './models'

export const AILA_CONVERSATION_META_SCHEMA_VERSION = 1
export const AILA_PERSISTED_MESSAGE_SCHEMA_VERSION = 1
export const AILA_AGENT_EVENT_SCHEMA_VERSION = 1

export const DEFAULT_CONVERSATION_TITLE = '新对话'
const CONVERSATION_TITLE_MAX = 40

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
}

export type ConversationActivityState =
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

export interface ConversationRuntimeReplayState {
  phase: ConversationRuntimeStatePhase
  active: boolean
  turn?: ConversationRuntimeReplayTurn
}

export interface ConversationInterruptedRecoveryOptions {
  reason?: string
  timestamp?: number
  activity?: ConversationActivity
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

export function normalizeConversationMeta(
  value: Partial<ConversationMeta>,
  fallbackId?: string,
): ConversationMeta {
  const now = Date.now()
  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : fallbackId
  if (!id) throw new Error('conversation meta is missing id')
  const activity = normalizeConversationActivity(value.activity)

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
  return phase === 'running' || phase === 'approval' || phase === 'cancelling'
}

function runtimeReplayState(
  phase: ConversationRuntimeStatePhase,
  turn?: ConversationRuntimeReplayTurn,
): ConversationRuntimeReplayState {
  return {
    phase,
    active: isActiveRuntimePhase(phase),
    ...(turn ? { turn } : {}),
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

function nonTerminalToolPhase(
  state: ConversationRuntimeReplayState,
): ConversationRuntimeStatePhase {
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
          'running',
          runtimeTurnFromEvent(state, event, {
            startedAt: event.timestamp,
            selection: dataSelection(event.data),
            clearPendingApproval: true,
          }),
        )
        break
      case 'turn.completed':
        state = runtimeReplayState(
          'completed',
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
        )
        break
      case 'turn.failed':
        state = runtimeReplayState(
          'failed',
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
        )
        break
      case 'turn.cancelled': {
        const phase = dataString(event.data, 'phase') === 'completed' ? 'cancelled' : 'cancelling'
        state = runtimeReplayState(
          phase,
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
        )
        break
      }
      case 'turn.interrupted':
        state = runtimeReplayState(
          'interrupted',
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
        )
        break
      case 'tool.approval.requested':
        state = runtimeReplayState(
          'approval',
          runtimeTurnFromEvent(state, event, {
            pendingApproval: pendingApprovalFromEvent(event),
          }),
        )
        break
      case 'tool.approval.resolved':
        state = runtimeReplayState(
          nonTerminalToolPhase(state),
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
        )
        break
      case 'tool.execution.started':
      case 'tool.execution.completed':
      case 'tool.execution.failed':
      case 'tool.result.returned':
        state = runtimeReplayState(
          nonTerminalToolPhase(state),
          runtimeTurnFromEvent(state, event, { clearPendingApproval: true }),
        )
        break
      case 'tool.requested':
      case 'tool.input.delta':
      case 'tool.input.completed':
        state = runtimeReplayState(nonTerminalToolPhase(state), runtimeTurnFromEvent(state, event))
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
  if (!activity || (activity.state !== 'running' && activity.state !== 'approval')) return null
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
