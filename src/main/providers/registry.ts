import type { LLMAuth, LLMClient, ModelInfo, ProviderId, ResolvedLLM } from '../agent-core/types'
import { AnthropicClient, GoogleClient, OpenAIClient, VertexClient } from '../llm'
import type { ConfigService } from './config-service'
import type { ModelConfig, ProviderConfig } from './types'
import { CUSTOM_MODEL_DEFAULTS, parseModelKey } from './types'

export type { ResolvedLLM }

function createClientForProvider(providerId: ProviderId): LLMClient {
  switch (providerId) {
    case 'anthropic':
      return new AnthropicClient()
    case 'openai':
      return new OpenAIClient()
    case 'google':
      return new GoogleClient()
    case 'google-vertex':
      return new VertexClient()
  }
}

function toProviderId(raw: string): ProviderId | null {
  if (raw === 'anthropic' || raw === 'openai' || raw === 'google' || raw === 'google-vertex') {
    return raw
  }
  return null
}

function buildModelInfo(
  providerId: ProviderId,
  modelId: string,
  modelConfig: ModelConfig | undefined,
): ModelInfo {
  return {
    id: modelId,
    provider: providerId,
    displayName: modelConfig?.name ?? modelId,
    contextWindow: modelConfig?.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow,
    maxOutputTokens: modelConfig?.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens,
    supportsImage: modelConfig?.supportsImageInput ?? CUSTOM_MODEL_DEFAULTS.supportsImageInput,
    supportsThinking: modelConfig?.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning,
    supportsToolUse: modelConfig?.toolUse ?? CUSTOM_MODEL_DEFAULTS.toolUse,
  }
}

export class ProviderRegistry {
  constructor(private configService: ConfigService) {}

  /** Get all providers that have an API key configured. */
  getConfiguredProviders(): ProviderConfig[] {
    return this.configService.getProviders().filter((p) => p.apiKey)
  }

  /** Get all models from configured providers, grouped by provider. */
  getAvailableModels(): { provider: ProviderConfig; models: ModelConfig[] }[] {
    return this.getConfiguredProviders().map((p) => ({
      provider: p,
      models: p.models,
    }))
  }

  /**
   * Resolve the active model into a self-built LLMClient + ModelInfo + LLMAuth.
   * Returns null when there is no active model, no API key, or the provider
   * is not one of our four built-in protocols.
   */
  resolveActiveLLM(): ResolvedLLM | null {
    const activeKey = this.configService.getActiveModelId()
    if (!activeKey) return null

    const parsed = parseModelKey(activeKey)
    if (!parsed) return null

    const provider = this.configService.getProvider(parsed.providerId)
    if (!provider?.apiKey) return null

    const providerId = toProviderId(String(provider.provider))
    if (!providerId) return null

    const client = createClientForProvider(providerId)
    const modelConfig = provider.models.find((m) => m.id === parsed.modelId)
    const modelInfo = buildModelInfo(providerId, parsed.modelId, modelConfig)

    const auth: LLMAuth = {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
    }

    return { client, modelInfo, auth }
  }

  /**
   * Resolve any provider+model pair into a ModelInfo. Used by the UI to
   * report capabilities of the active model without running a turn.
   */
  describeModel(providerId: string, modelId: string): ModelInfo | null {
    const provider = this.configService.getProvider(providerId)
    if (!provider) return null

    const canonicalId = toProviderId(String(provider.provider))
    if (!canonicalId) return null

    const modelConfig = provider.models.find((m) => m.id === modelId)
    return buildModelInfo(canonicalId, modelId, modelConfig)
  }
}
