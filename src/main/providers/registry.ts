import type { Api, KnownProvider, Model } from '@mariozechner/pi-ai'
import { getModel as getPiModel } from '@mariozechner/pi-ai'
import type { ConfigService } from './config-service'
import type { ModelConfig, ProviderConfig } from './types'
import { CUSTOM_MODEL_DEFAULTS, parseModelKey } from './types'

export class ProviderRegistry {
  constructor(private configService: ConfigService) {}

  /** Get all providers that have an API key configured */
  getConfiguredProviders(): ProviderConfig[] {
    return this.configService.getProviders().filter((p) => p.apiKey)
  }

  /** Get all models from configured providers, grouped by provider */
  getAvailableModels(): { provider: ProviderConfig; models: ModelConfig[] }[] {
    return this.getConfiguredProviders().map((p) => ({
      provider: p,
      models: p.models,
    }))
  }

  /** Create a pi-ai Model object from provider + model config */
  createModelForId(providerId: string, modelId: string): Model<Api> | { error: string } {
    const provider = this.configService.getProvider(providerId)
    if (!provider) {
      return { error: `Provider "${providerId}" not found` }
    }
    if (!provider.apiKey) {
      return { error: `Provider "${providerId}" has no API key configured` }
    }

    const modelConfig = provider.models.find((m) => m.id === modelId)

    // For built-in providers, try to get full specs from pi-ai registry
    let contextWindow = modelConfig?.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow
    let maxTokens = modelConfig?.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens
    let reasoning = modelConfig?.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning
    let supportsImageInput =
      modelConfig?.supportsImageInput ?? CUSTOM_MODEL_DEFAULTS.supportsImageInput

    if (provider.isBuiltIn) {
      try {
        const piModel = getPiModel(provider.provider as KnownProvider, modelId as never)
        if (piModel) {
          contextWindow = piModel.contextWindow
          maxTokens = piModel.maxTokens
          reasoning = piModel.reasoning
          supportsImageInput = piModel.input.includes('image')
        }
      } catch {
        // Model not in pi-ai registry — use our config values or defaults
      }
    }

    const input: ('text' | 'image')[] = ['text']
    if (supportsImageInput) {
      input.push('image')
    }

    return {
      id: modelId,
      name: modelConfig?.name || modelId,
      api: provider.api as Api,
      provider: provider.provider,
      baseUrl: provider.baseUrl,
      reasoning,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    }
  }

  /** Create a model from the active model key in config */
  createActiveModel(): Model<Api> | { error: string } {
    const activeKey = this.configService.getActiveModelId()
    if (!activeKey) {
      return { error: 'No active model configured' }
    }
    const parsed = parseModelKey(activeKey)
    if (!parsed) {
      return { error: `Invalid active model key: "${activeKey}"` }
    }
    return this.createModelForId(parsed.providerId, parsed.modelId)
  }
}
