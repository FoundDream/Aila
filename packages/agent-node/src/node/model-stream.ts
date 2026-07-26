import type {
  AgentContextPlan,
  ChatMessage,
  ModelCallStreamEvent,
  ModelCallToolDefinition,
  ModelCallUsage,
  ModelDescriptor,
  PromptCacheSettings,
} from '@aila/agent'

export type ModelStreamUsage = ModelCallUsage
export type ModelStreamEvent = ModelCallStreamEvent
export type ModelStreamToolDefinition = ModelCallToolDefinition

export interface ModelStreamRequest {
  descriptor: ModelDescriptor
  apiKey: string
  conversationId?: string
  messages: ChatMessage[]
  contextPlan?: AgentContextPlan
  cache?: PromptCacheSettings
  tools: ModelStreamToolDefinition[]
  signal: AbortSignal
  step?: number
  requireImages?: boolean
}

export interface ModelStreamClient {
  stream(input: ModelStreamRequest): AsyncIterable<ModelStreamEvent>
}
