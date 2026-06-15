import type { ModelInfo, ProviderId } from '@aila/agent'
import {
  createModelInfoResolver,
  createModelRegistry,
  createProviderStreamChat,
} from '@aila/agent/node'
import { getDataDir, getImagesDir } from './paths'
import { loadSettings } from './settings'

export type {
  AgentEvent,
  AgentEventSink,
  AgentEventType,
  ChatMessage,
  DeltaEvent,
  DoneEvent,
  ErrorEvent,
  ImageBlockEvent,
  ModelInfo,
  ModelSelection,
  RuntimeModelInfoResolver,
  RuntimeStreamChat,
  StreamHandlers,
  StreamRequest,
  ToolCall,
  ToolCallArgsDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  UsageInfo,
  UserContentPart,
} from '@aila/agent'

const modelRegistry = createModelRegistry()
const resolveModelInfo = createModelInfoResolver(modelRegistry)

export function getModelInfo(providerId: ProviderId, modelId: string): ModelInfo {
  return resolveModelInfo({ providerId, modelId })
}

export const streamChat = createProviderStreamChat({
  modelRegistry,
  loadSettings,
  dataDir: getDataDir(),
  imageDir: getImagesDir(),
})
