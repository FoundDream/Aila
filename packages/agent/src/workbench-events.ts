import type {
  DeltaEvent,
  DoneEvent,
  ErrorEvent,
  ImageBlockEvent,
  ToolCallArgsDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
} from './agent-protocol'
import type { ConversationSummary, PersistedMessage, PersistedRunEvent } from './conversation-core'

export type SessionInputQueueMode = 'one-at-a-time' | 'all'

export interface SessionInputQueueState {
  conversationId: string
  steering: PersistedMessage[]
  followUp: PersistedMessage[]
  nextTurn: PersistedMessage[]
  steeringMode: SessionInputQueueMode
  followUpMode: SessionInputQueueMode
}

export const AILA_WORKBENCH_EVENT_SCHEMA_VERSION = 1

export interface WorkbenchEventMap {
  'conversations:updated': ConversationSummary
  'session:queue-updated': SessionInputQueueState
  'run:event': PersistedRunEvent
  'chat:text-delta': DeltaEvent
  'chat:reasoning-delta': DeltaEvent
  'chat:tool-call-start': ToolCallEvent
  'chat:tool-call-args-delta': ToolCallArgsDeltaEvent
  'chat:tool-call-result': ToolResultEvent
  'chat:image-block': ImageBlockEvent
  'chat:done': DoneEvent
  'chat:error': ErrorEvent
}

export const AILA_WORKBENCH_EVENT_TYPES = [
  'conversations:updated',
  'session:queue-updated',
  'run:event',
  'chat:text-delta',
  'chat:reasoning-delta',
  'chat:tool-call-start',
  'chat:tool-call-args-delta',
  'chat:tool-call-result',
  'chat:image-block',
  'chat:done',
  'chat:error',
] as const satisfies readonly (keyof WorkbenchEventMap)[]

export type WorkbenchEventType = (typeof AILA_WORKBENCH_EVENT_TYPES)[number]

export type WorkbenchEvent<TType extends WorkbenchEventType = WorkbenchEventType> = {
  [Type in TType]: {
    schemaVersion: typeof AILA_WORKBENCH_EVENT_SCHEMA_VERSION
    type: Type
    data: WorkbenchEventMap[Type]
  }
}[TType]

export function createWorkbenchEvent<TType extends WorkbenchEventType>(
  type: TType,
  data: WorkbenchEventMap[TType],
): WorkbenchEvent<TType> {
  return { schemaVersion: AILA_WORKBENCH_EVENT_SCHEMA_VERSION, type, data }
}

export function isWorkbenchEventType(value: string): value is WorkbenchEventType {
  return AILA_WORKBENCH_EVENT_TYPES.includes(value as WorkbenchEventType)
}
