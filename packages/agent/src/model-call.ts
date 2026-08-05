import type { ChatMessage } from './agent-protocol'
import type { AgentContextPlan } from './context'
import type { ModelDescriptor } from './models'
import type { PromptCacheSettings } from './settings-types'

type MaybePromise<T> = T | Promise<T>

/**
 * Provider-visible tool schema. Model calls can describe tools, but they never
 * receive executable handlers.
 */
export interface ModelCallToolDefinition {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

export interface ModelCallUsage {
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  cacheMissTokens?: number | null
  reasoningTokens?: number | null
  rawProviderUsage?: unknown
}

export type ModelCallStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'tool-error'; toolCallId: string; toolName: string; error: unknown }
  | { type: 'finish-step'; usage?: ModelCallUsage }
  | { type: 'finish'; totalUsage?: ModelCallUsage }
  | { type: 'response-messages'; messages: ChatMessage[] }
  | { type: 'abort' }
  | { type: 'error'; error: unknown }

export interface ModelCallToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  argsJson: string
}

export interface ModelCallResolvedToolResult {
  toolCallId: string
  toolName: string
  output?: unknown
  error?: string
}

export interface ModelCallInput {
  descriptor: ModelDescriptor
  apiKey: string
  conversationId?: string
  messages: ChatMessage[]
  contextPlan?: AgentContextPlan
  cache?: PromptCacheSettings
  tools: ModelCallToolDefinition[]
  signal: AbortSignal
  /** Diagnostic index only. Loop control must not depend on this value. */
  stepIndex?: number
  requireImages?: boolean
}

export interface ModelCallResult {
  outcome: 'completed' | 'failed' | 'cancelled'
  text: string
  reasoning: string
  toolCalls: ModelCallToolCall[]
  resolvedToolResults: ModelCallResolvedToolResult[]
  stepUsage: ModelCallUsage[]
  totalUsage?: ModelCallUsage
  responseMessages?: ChatMessage[]
  error?: string
}

export type ModelCallStreamSink = (event: ModelCallStreamEvent) => MaybePromise<void>

/**
 * Executes exactly one provider model request. It does not execute tools,
 * retry, compact context, persist state, or decide whether an agent continues.
 */
export interface ModelCallExecutor {
  execute(input: ModelCallInput, sink?: ModelCallStreamSink): Promise<ModelCallResult>
}
