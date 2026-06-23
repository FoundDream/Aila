import {
  findModelDescriptor,
  MODEL_CATALOG,
  type ModelApi,
  type ModelDescriptor,
  modelEntryToDescriptor,
  type ProviderId,
} from '../models'

export interface NodeProviderConfig {
  provider: ProviderId
  api: ModelApi
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
  models?: Record<string, Partial<Omit<ModelDescriptor, 'provider' | 'modelId'>>>
}

export interface CreateModelRegistryInput {
  builtinModels?: boolean
  providers?: Record<string, Omit<NodeProviderConfig, 'provider'>>
  models?: ModelDescriptor[]
}

const BUILTIN_PROVIDER_CONFIGS: NodeProviderConfig[] = [
  {
    provider: 'openrouter',
    api: 'openai-chat-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    provider: 'deepseek',
    api: 'openai-chat-completions',
    baseUrl: 'https://api.deepseek.com',
  },
]

export class ModelRegistry {
  private readonly providers = new Map<ProviderId, NodeProviderConfig>()
  private readonly models = new Map<string, ModelDescriptor>()

  constructor(input: CreateModelRegistryInput = {}) {
    if (input.builtinModels !== false) {
      for (const provider of BUILTIN_PROVIDER_CONFIGS) this.registerProvider(provider)
      for (const entry of MODEL_CATALOG) this.registerModel(modelEntryToDescriptor(entry))
    }

    for (const [provider, config] of Object.entries(input.providers ?? {})) {
      this.registerProvider({ provider, ...config })
    }
    for (const model of input.models ?? []) this.registerModel(model)
  }

  registerProvider(config: NodeProviderConfig): void {
    const previous = this.providers.get(config.provider)
    const merged = { ...previous, ...config }
    this.providers.set(config.provider, merged)
    for (const [modelId, model] of Object.entries(config.models ?? {})) {
      this.registerModel({
        provider: config.provider,
        modelId,
        api: model.api ?? merged.api,
        ...(merged.baseUrl && { baseUrl: merged.baseUrl }),
        ...(merged.headers && { headers: merged.headers }),
        ...model,
      })
    }
  }

  registerModel(model: ModelDescriptor): void {
    const provider = this.providers.get(model.provider)
    const next: ModelDescriptor = {
      ...model,
      api: model.api ?? provider?.api ?? 'openai-chat-completions',
      ...((model.baseUrl ?? provider?.baseUrl)
        ? { baseUrl: model.baseUrl ?? provider?.baseUrl }
        : {}),
      ...(provider?.headers || model.headers
        ? { headers: { ...(provider?.headers ?? {}), ...(model.headers ?? {}) } }
        : {}),
    }
    this.models.set(modelKey(next.provider, next.modelId), next)
  }

  resolve(selection: {
    providerId: ProviderId
    modelId: string
    model?: ModelDescriptor
  }): ModelDescriptor {
    if (selection.model) return selection.model
    const registered = this.models.get(modelKey(selection.providerId, selection.modelId))
    if (registered) return registered
    const catalog = findModelDescriptor(selection.providerId, selection.modelId)
    if (catalog) return this.withProviderDefaults(catalog)
    const provider = this.providers.get(selection.providerId)
    if (!provider) {
      throw new Error(`No model registered for ${selection.providerId}:${selection.modelId}`)
    }
    return this.withProviderDefaults({
      provider: selection.providerId,
      modelId: selection.modelId,
      api: provider.api,
      ...(provider.baseUrl && { baseUrl: provider.baseUrl }),
      ...(provider.headers && { headers: provider.headers }),
    })
  }

  getModelInfo(selection: { providerId: ProviderId; modelId: string; model?: ModelDescriptor }): {
    model: string
    contextLength: number | null
  } {
    const model = this.resolve(selection)
    return {
      model: model.displayName ?? model.modelId,
      contextLength: model.contextLength && model.contextLength > 0 ? model.contextLength : null,
    }
  }

  listModels(): ModelDescriptor[] {
    return Array.from(this.models.values())
  }

  private withProviderDefaults(model: ModelDescriptor): ModelDescriptor {
    const provider = this.providers.get(model.provider)
    if (!provider) return model
    return {
      ...model,
      ...((model.baseUrl ?? provider.baseUrl)
        ? { baseUrl: model.baseUrl ?? provider.baseUrl }
        : {}),
      ...(provider.headers || model.headers
        ? { headers: { ...(provider.headers ?? {}), ...(model.headers ?? {}) } }
        : {}),
    }
  }
}

export function createModelRegistry(input: CreateModelRegistryInput = {}): ModelRegistry {
  return new ModelRegistry(input)
}

function modelKey(provider: ProviderId, modelId: string): string {
  return `${provider}:${modelId}`
}
