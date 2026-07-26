import type { DurableRunExecutor, ModelInfo, ProviderId } from '@aila/agent'
import { createDurableRunExecutor, createModelInfoResolver } from '../node/durable-run'
import { createModelRegistry } from '../node/model-registry'
import { getDataDir, getImagesDir } from './paths'
import { loadSettings } from './settings'

export type {
  ChatMessage,
  DeltaEvent,
  DoneEvent,
  DurableRunExecutor,
  ErrorEvent,
  ImageBlockEvent,
  ModelInfo,
  ModelSelection,
  RunEvent,
  RunEventSink,
  RunEventType,
  RunHandlers,
  RunRequest,
  RuntimeModelInfoResolver,
  ToolCall,
  ToolCallArgsDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  UsageInfo,
  UserContentPart,
} from '@aila/agent'

const modelRegistry = createModelRegistry()
const resolveModelInfo = createModelInfoResolver(modelRegistry)
let runAgentInstance: DurableRunExecutor | null = null

export function getModelInfo(providerId: ProviderId, modelId: string): ModelInfo {
  return resolveModelInfo({ providerId, modelId })
}

function getRunAgent(): DurableRunExecutor {
  runAgentInstance ??= createDurableRunExecutor({
    modelRegistry,
    loadSettings,
    dataDir: getDataDir(),
    imageDir: getImagesDir(),
  })
  return runAgentInstance
}

export const runAgent: DurableRunExecutor = (request, handlers) => getRunAgent()(request, handlers)
