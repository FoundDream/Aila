import {
  type ConnectionProfile,
  findModelDescriptor,
  MODEL_CATALOG,
  type ModelApi,
  type ModelDescriptor,
  modelEntryToDescriptor,
  type ProviderDefinition,
  type ProviderId,
  VISION_MODEL_CATALOG,
} from '@aila/agent'
import { createProviderRegistry, type ProviderRegistry } from './provider-registry'

export interface NodeProviderConfig {
  /** Connection id selected by callers. */
  provider: ProviderId
  /** Provider implementation. Defaults to the connection id. */
  providerType?: string
  api: ModelApi
  baseUrl?: string
  apiKey?: string
  credentialRef?: string
  headers?: Record<string, string>
  models?: Record<string, Partial<Omit<ModelDescriptor, 'provider' | 'modelId'>>>
}

export interface CreateModelRegistryInput {
  builtinModels?: boolean
  providerRegistry?: ProviderRegistry
  connections?: ConnectionProfile[]
  providers?: Record<string, Omit<NodeProviderConfig, 'provider'>>
  models?: ModelDescriptor[]
}

export class ModelRegistry {
  private readonly providerRegistry: ProviderRegistry
  private readonly providers = new Map<ProviderId, NodeProviderConfig>()
  private readonly models = new Map<string, ModelDescriptor>()

  constructor(input: CreateModelRegistryInput = {}) {
    this.providerRegistry = input.providerRegistry ?? createProviderRegistry()
    if (input.builtinModels !== false) {
      for (const definition of this.providerRegistry.list()) {
        this.registerProvider({
          provider: definition.id,
          providerType: definition.id,
          api: definition.defaultApi,
          ...(definition.defaultBaseUrl ? { baseUrl: definition.defaultBaseUrl } : {}),
        })
      }
      for (const entry of MODEL_CATALOG) this.registerModel(modelEntryToDescriptor(entry))
      for (const entry of VISION_MODEL_CATALOG) this.registerModel(modelEntryToDescriptor(entry))
    }

    for (const [provider, config] of Object.entries(input.providers ?? {})) {
      this.registerProvider({ provider, ...config })
    }
    for (const connection of input.connections ?? []) this.registerConnection(connection)
    for (const model of input.models ?? []) this.registerModel(model)
  }

  registerProvider(config: NodeProviderConfig): void {
    const previous = this.providers.get(config.provider)
    const providerType = config.providerType ?? previous?.providerType ?? config.provider
    const definition = this.providerRegistry.resolve(providerType)
    const merged: NodeProviderConfig = {
      ...(definition.defaultBaseUrl ? { baseUrl: definition.defaultBaseUrl } : {}),
      ...previous,
      ...config,
      providerType,
      api: config.api ?? previous?.api ?? definition.defaultApi,
    }
    this.providers.set(config.provider, merged)
    for (const [modelId, model] of Object.entries(config.models ?? {})) {
      this.registerModel({
        connectionId: config.provider,
        providerType,
        provider: config.provider,
        modelId,
        api: model.api ?? merged.api,
        ...(merged.baseUrl && { baseUrl: merged.baseUrl }),
        ...(merged.headers && { headers: merged.headers }),
        ...model,
      })
    }
  }

  registerConnection(connection: ConnectionProfile): void {
    const definition = this.providerRegistry.resolve(connection.providerType)
    this.registerProvider({
      provider: connection.id,
      providerType: connection.providerType,
      api: definition.defaultApi,
      ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
      ...(connection.headers ? { headers: connection.headers } : {}),
      ...(connection.credentialRef ? { credentialRef: connection.credentialRef } : {}),
      ...(connection.models
        ? {
            models: Object.fromEntries(
              connection.models.map((model) => [
                model.id,
                {
                  ...(model.displayName ? { displayName: model.displayName } : {}),
                  ...(model.api ? { api: model.api } : {}),
                  ...(model.contextLength !== undefined
                    ? { contextLength: model.contextLength }
                    : {}),
                  ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
                  ...(model.capabilities ? { capabilities: model.capabilities } : {}),
                },
              ]),
            ),
          }
        : {}),
    })
  }

  registerModel(model: ModelDescriptor): void {
    const provider = this.providers.get(model.provider)
    const next: ModelDescriptor = {
      ...model,
      connectionId: model.connectionId ?? model.provider,
      providerType: model.providerType ?? provider?.providerType ?? model.provider,
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
      connectionId: selection.providerId,
      providerType: provider.providerType ?? selection.providerId,
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

  getProviderConfig(providerId: ProviderId): NodeProviderConfig | undefined {
    const provider = this.providers.get(providerId)
    return provider ? structuredClone(provider) : undefined
  }

  getProviderDefinition(providerId: ProviderId, providerType?: string): ProviderDefinition {
    const provider = this.providers.get(providerId)
    return this.providerRegistry.resolve(provider?.providerType ?? providerType ?? providerId)
  }

  private withProviderDefaults(model: ModelDescriptor): ModelDescriptor {
    const provider = this.providers.get(model.provider)
    if (!provider) return model
    return {
      ...model,
      connectionId: model.connectionId ?? model.provider,
      providerType: model.providerType ?? provider.providerType ?? model.provider,
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
