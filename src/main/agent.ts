import type { ModelInfo, ProviderId, RuntimeStreamChat } from '@aila/agent'
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
let streamChatInstance: RuntimeStreamChat | null = null

export function getModelInfo(providerId: ProviderId, modelId: string): ModelInfo {
  return resolveModelInfo({ providerId, modelId })
}

function getStreamChat(): RuntimeStreamChat {
  streamChatInstance ??= createProviderStreamChat({
    modelRegistry,
    loadSettings,
    dataDir: getDataDir(),
    imageDir: getImagesDir(),
  })
  return streamChatInstance
}

export const streamChat: RuntimeStreamChat = (request, handlers) =>
  getStreamChat()(request, handlers)
