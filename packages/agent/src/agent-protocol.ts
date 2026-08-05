import type { AgentContextPlan } from './context'
import type { PersistedImageBlock, PersistedMessage } from './conversation-core'
import type { ModelCallToolCall } from './model-call'
import type { ModelDescriptor, ProviderId } from './models'
import type { RunContinuationReason, RunIdentity } from './run-machine'
import type { RunSnapshot } from './run-persistence'
import type { BlobRef, SessionEntry, SessionEntryInput } from './session-journal'
import type { Settings } from './settings-types'
import type { ToolContext, ToolRegistry } from './tools'

type MaybePromise<T> = T | Promise<T>

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
  providerOptions?: ProviderMessageOptions
}

export type ProviderMessageOptions = Record<string, Record<string, unknown>>

export interface AssistantReasoningPart {
  text: string
  providerOptions?: ProviderMessageOptions
}

/** Multimodal user content. Image urls are aila-image:// references resolved by the host stream. */
export type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; mime: string }

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentPart[] }
  | {
      role: 'assistant'
      content: string
      tool_calls?: ToolCall[]
      reasoning?: AssistantReasoningPart[]
      providerOptions?: ProviderMessageOptions
    }
  | {
      role: 'tool'
      tool_call_id: string
      content: string
      providerOptions?: ProviderMessageOptions
      toolResultProviderOptions?: ProviderMessageOptions
    }

export interface ToolCallEvent {
  conversationId: string
  messageId: string
  toolCallId: string
  name: string
  arguments: string
}

export interface ToolCallArgsDeltaEvent {
  conversationId: string
  messageId: string
  toolCallId: string
  delta: string
}

export interface ToolResultEvent {
  conversationId: string
  messageId: string
  toolCallId: string
  name?: string
  result: string
  isError: boolean
}

export interface DeltaEvent {
  conversationId: string
  messageId: string
  delta: string
}

export interface ImageBlockEvent {
  conversationId: string
  messageId: string
  block: PersistedImageBlock
}

export interface UsageInfo {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Number of model requests included in this usage record. */
  modelCallCount?: number
  /** Largest input token count among the model requests in this usage record. */
  maxInputTokens?: number
  /** Input token count from the last model request in this usage record. */
  lastInputTokens?: number
  /** Output token count from the last model request in this usage record. */
  lastOutputTokens?: number
  /** Cache read token count from the last model request in this usage record. */
  lastCacheReadTokens?: number
  /** Cache write token count from the last model request in this usage record. */
  lastCacheWriteTokens?: number
  /** Cache miss token count from the last model request in this usage record. */
  lastCacheMissTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cacheMissTokens?: number
  reasoningTokens?: number
}

export interface DoneEvent {
  conversationId: string
  messageId: string
  message: PersistedMessage
  usage?: UsageInfo
}

export interface ErrorEvent {
  conversationId: string
  messageId: string
  error: string
  message: PersistedMessage
}

export type RunEventType =
  | 'run.started'
  | 'run.resumed'
  | 'run.paused'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'step.cancelled'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'turn.interrupted'
  | 'vision.bridge.started'
  | 'vision.bridge.completed'
  | 'vision.bridge.failed'
  | 'context.compacting'
  | 'context.compacted'
  | 'tool.requested'
  | 'tool.input.completed'
  | 'tool.execution.started'
  | 'tool.execution.completed'
  | 'tool.execution.failed'
  | 'tool.result.returned'
  | 'tool.approval.requested'
  | 'tool.approval.resolved'

export interface RunEvent {
  timestamp: number
  conversationId: string
  messageId: string
  type: RunEventType
  /**
   * Stable execution identity. Absent only on synthesized recovery events
   * whose source journal never resolved one.
   */
  turnId?: string
  runId?: string
  stepId?: string
  /** Monotonic within the durable conversation journal; assigned on append. */
  seq?: number
  /** Stable idempotency identity generated before append. */
  eventId?: string
  data?: Record<string, unknown>
}

/**
 * Async implementations are supported at runtime. The `void` surface preserves
 * compatibility with callbacks whose expression happens to return a value.
 */
export type RunEventSink = (event: RunEvent) => void

export interface RunHandlers {
  onTextDelta: (event: DeltaEvent) => void
  onReasoningDelta: (event: DeltaEvent) => void
  onToolCallStart: (event: ToolCallEvent) => void
  onToolCallArgsDelta: (event: ToolCallArgsDeltaEvent) => void
  onToolCallResult: (event: ToolResultEvent) => void
  onImageBlock: (event: ImageBlockEvent) => void
  onDone: (event: DoneEvent) => MaybePromise<void>
  onError: (event: ErrorEvent) => MaybePromise<void>
}

export interface ModelInfo {
  model: string
  contextLength: number | null
}

export interface ModelSelection {
  providerId: ProviderId
  modelId: string
  model?: ModelDescriptor
}

export interface RunRequest {
  conversationId: string
  assistantMessageId: string
  run?: RunIdentity
  loopMode?: 'continuous' | 'step'
  runSnapshot?: RunSnapshot
  /** Active semantic session leaf used to materialize this run. */
  sessionLeafId: string
  runContextRef: BlobRef
  resumeState?: {
    messages: ChatMessage[]
    contextPlan: AgentContextPlan
    assistantMessage?: PersistedMessage
    modelStepOutputs?: Record<string, string>
    pendingToolCalls?: ModelCallToolCall[]
  }
  messages: ChatMessage[]
  contextPlan?: AgentContextPlan
  prepareModelStep?: (
    input: RunModelStepPreparationInput,
  ) => MaybePromise<RunModelStepPreparationResult | undefined>
  /** Messages injected after the current model/tool boundary, before continuing. */
  getSteeringMessages?: () => MaybePromise<ChatMessage[]>
  /** Messages injected only after the run would otherwise finish. */
  getFollowUpMessages?: () => MaybePromise<ChatMessage[]>
  selection: ModelSelection
  signal: AbortSignal
  onRunEvent?: RunEventSink
  onSavePoint?: (reason: RunSavePointReason) => MaybePromise<void>
  appendSessionEntry?: (entry: SessionEntryInput) => MaybePromise<SessionEntry>
  putBlob?: (input: {
    contentType: string
    data: unknown
    preview?: string
    blobId?: string
  }) => MaybePromise<BlobRef>
  workspaceRoots?: ToolContext['workspaceRoots']
  shellCwd?: ToolContext['shellCwd']
  path?: ToolContext['path']
  onToolPolicy?: ToolContext['onToolPolicy']
  onToolApproval?: ToolContext['onToolApproval']
  settings?: Settings
  webSearch?: ToolContext['webSearch']
  generateImage?: ToolContext['generateImage']
  saveImage?: ToolContext['saveImage']
  runShell?: ToolContext['runShell']
  fileSystem?: ToolContext['fileSystem']
  toolRegistry?: ToolRegistry
}

export type RunSavePointReason =
  | 'model_response'
  | 'tool_result'
  | 'approval'
  | 'compaction'
  | 'terminal'

export interface RunModelStepPreparationInput {
  conversationId: string
  run: RunIdentity
  modelStepIndex: number
  reason: RunContinuationReason
  toolsEnabled: boolean
  messages: ChatMessage[]
  contextPlan?: AgentContextPlan
}

export interface RunModelStepPreparationResult {
  messages?: ChatMessage[]
  contextPlan?: AgentContextPlan
}

/**
 * Executes one durable agent run. Provider adapters remain behind
 * ModelCallExecutor and never own the model/tool loop.
 */
export type DurableRunExecutor = (req: RunRequest, handlers: RunHandlers) => MaybePromise<void>

export type RuntimeModelInfoResolver = (selection: ModelSelection) => MaybePromise<ModelInfo>
