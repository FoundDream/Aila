import type { ChatMessage, ModelInfo, ModelSelection, RunEvent } from '../agent-protocol'
import type { AgentContextPlan } from '../context'
import type { ConversationRecord, PersistedMessage } from '../conversation-core'
import {
  AILA_RUN_PAYLOAD_SCHEMA_VERSION,
  type RunPayload,
  type RunSnapshot,
} from '../run-persistence'
import type { SessionEntry } from '../session-journal'
import type { Settings } from '../settings-types'
import type { RuntimeRunAllowedControls, RuntimeRunPayloadDescriptor } from './api-types'
import { cloneRuntimeValue } from './clone'
import type { RunEventInput } from './session-engine'

export const DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS = 5_000
export const EMPTY_RUNTIME_SETTINGS: Settings = { apiKeys: {}, defaultModel: null }
export const FALLBACK_MODEL_CONTEXT: ModelInfo = { model: 'unknown', contextLength: null }
const TURN_LIFECYCLE_EVENTS = new Set<RunEvent['type']>([
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'turn.interrupted',
])

export function defaultRuntimeNow(): number {
  return Date.now()
}

export function defaultCreateRuntimeId(): string {
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function runtimeRunAllowedControls(
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
  return 'Context compaction'
}

export function runPayloadDescriptor(payload: RunPayload): RuntimeRunPayloadDescriptor {
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

export interface RunContextBlobData {
  messages: ChatMessage[]
  contextPlan: AgentContextPlan
}

export function isRunContextBlobData(value: unknown): value is RunContextBlobData {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<RunContextBlobData>
  return (
    Array.isArray(record.messages) && !!record.contextPlan && typeof record.contextPlan === 'object'
  )
}

export function runPayloadFromEntry(entry: SessionEntry<'run.payload'>, data: unknown): RunPayload {
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
    kind: entry.data.kind,
    createdAt: entry.timestamp,
    contentType: entry.payloadRef?.contentType === 'text/plain' ? 'text/plain' : 'application/json',
    data: cloneRuntimeValue(data),
  }
}

export function withTurnSelection(event: RunEventInput, selection: ModelSelection): RunEventInput {
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

export function resolveRetryTurn(record: ConversationRecord): {
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
