import type { ModelInfo, ProviderId } from '@aila/agent'
import { createModelInfoResolver } from '../node/durable-run'
import { createModelRegistry } from '../node/model-registry'

const modelRegistry = createModelRegistry()
const resolveModelInfo = createModelInfoResolver(modelRegistry)

export function getModelInfo(providerId: ProviderId, modelId: string): ModelInfo {
  return resolveModelInfo({ providerId, modelId })
}
