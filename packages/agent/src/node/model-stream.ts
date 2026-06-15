import type { ChatMessage } from '../agent-protocol'
import type { ModelDescriptor } from '../models'

export interface ModelStreamUsage {
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
}

export type ModelStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'tool-error'; toolCallId: string; toolName: string; error: unknown }
  | { type: 'finish-step'; usage?: ModelStreamUsage }
  | { type: 'finish'; totalUsage?: ModelStreamUsage }
  | { type: 'abort' }
  | { type: 'error'; error: unknown }

export interface ModelStreamToolExecuteOptions {
  toolCallId: string
}

export interface ModelStreamToolDefinition {
  name: string
  description?: string
  parameters: Record<string, unknown>
  execute: (
    args: Record<string, unknown>,
    options: ModelStreamToolExecuteOptions,
  ) => Promise<unknown>
}

export interface ModelStreamRequest {
  descriptor: ModelDescriptor
  apiKey: string
  messages: ChatMessage[]
  tools: ModelStreamToolDefinition[]
  signal: AbortSignal
  step?: number
}

export interface ModelStreamClient {
  stream(input: ModelStreamRequest): AsyncIterable<ModelStreamEvent>
}
