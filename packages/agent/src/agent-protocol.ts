import type { AgentContextPlan } from './context'
import type { PersistedImageBlock, PersistedMessage } from './conversation-core'
import type { ModelDescriptor, ProviderId } from './models'
import type { PlanArtifact } from './plan-core'
import type { Settings } from './settings-types'
import type { AilaExecutionMode } from './tool-policy'
import type { ToolContext, ToolRegistry } from './tools'

type MaybePromise<T> = T | Promise<T>

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** Multimodal user content. Image urls are aila-image:// references resolved by the host stream. */
export type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; mime: string }

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentPart[] }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

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

export type AgentEventType =
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'turn.interrupted'
  | 'context:compacting'
  | 'context:compacted'
  | 'tool.requested'
  | 'tool.input.delta'
  | 'tool.input.completed'
  | 'tool.execution.started'
  | 'tool.execution.completed'
  | 'tool.execution.failed'
  | 'tool.result.returned'
  | 'tool.approval.requested'
  | 'tool.approval.resolved'
  | 'plan.started'
  | 'plan.exploring'
  | 'plan.question.requested'
  | 'plan.question.answered'
  | 'plan.updated'
  | 'plan.ready'
  | 'plan.approved'
  | 'plan.rejected'
  | 'plan.cancelled'
  | 'plan.implementation.started'
  | 'plan.task.started'
  | 'plan.task.completed'
  | 'plan.task.blocked'
  | 'plan.drift.detected'
  | 'plan.completed'

export interface AgentEvent {
  timestamp: number
  conversationId: string
  messageId: string
  type: AgentEventType
  data?: Record<string, unknown>
}

export type AgentEventSink = (event: AgentEvent) => void

export interface StreamHandlers {
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

export interface StreamRequest {
  conversationId: string
  assistantMessageId: string
  messages: ChatMessage[]
  contextPlan?: AgentContextPlan
  mode?: AilaExecutionMode
  plan?: PlanArtifact
  planOperation?: 'create' | 'revise' | 'implement'
  selection: ModelSelection
  signal: AbortSignal
  onAgentEvent?: AgentEventSink
  workspaceRoots?: ToolContext['workspaceRoots']
  shellCwd?: ToolContext['shellCwd']
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

export type RuntimeStreamChat = (req: StreamRequest, handlers: StreamHandlers) => MaybePromise<void>

export type RuntimeModelInfoResolver = (selection: ModelSelection) => MaybePromise<ModelInfo>
