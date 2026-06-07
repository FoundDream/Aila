import type {
  DeltaEvent,
  DoneEvent,
  ErrorEvent,
  ImageBlockEvent,
  ToolCallArgsDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
} from './agent'
import type { ConversationSummary, PersistedAgentEvent } from './conversations'

export const AILA_RUNTIME_EVENT_SCHEMA_VERSION = 1

export interface AgentRuntimeEventMap {
  'conversations:updated': ConversationSummary
  'agent:event': PersistedAgentEvent
  'chat:text-delta': DeltaEvent
  'chat:reasoning-delta': DeltaEvent
  'chat:tool-call-start': ToolCallEvent
  'chat:tool-call-args-delta': ToolCallArgsDeltaEvent
  'chat:tool-call-result': ToolResultEvent
  'chat:image-block': ImageBlockEvent
  'chat:done': DoneEvent
  'chat:error': ErrorEvent
}

export const AILA_RUNTIME_EVENT_TYPES = [
  'conversations:updated',
  'agent:event',
  'chat:text-delta',
  'chat:reasoning-delta',
  'chat:tool-call-start',
  'chat:tool-call-args-delta',
  'chat:tool-call-result',
  'chat:image-block',
  'chat:done',
  'chat:error',
] as const satisfies readonly (keyof AgentRuntimeEventMap)[]

export type AilaRuntimeEventType = (typeof AILA_RUNTIME_EVENT_TYPES)[number]

export type AgentRuntimeEvent<TType extends AilaRuntimeEventType = AilaRuntimeEventType> = {
  [Type in TType]: {
    schemaVersion: typeof AILA_RUNTIME_EVENT_SCHEMA_VERSION
    type: Type
    data: AgentRuntimeEventMap[Type]
  }
}[TType]

export function createRuntimeEvent<TType extends AilaRuntimeEventType>(
  type: TType,
  data: AgentRuntimeEventMap[TType],
): AgentRuntimeEvent<TType> {
  return { schemaVersion: AILA_RUNTIME_EVENT_SCHEMA_VERSION, type, data }
}

export function isRuntimeEventType(value: string): value is AilaRuntimeEventType {
  return AILA_RUNTIME_EVENT_TYPES.includes(value as AilaRuntimeEventType)
}
