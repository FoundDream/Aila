import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import type { ModelApi, ModelDescriptor } from '../models'

export interface ProtocolAdapterInput {
  model: ModelDescriptor
  apiKey: string
}

export interface ProtocolAdapter {
  api: ModelApi
  createLanguageModel: (input: ProtocolAdapterInput) => LanguageModel
}

export class ProtocolRegistry {
  private readonly adapters = new Map<ModelApi, ProtocolAdapter>()

  register(adapter: ProtocolAdapter): void {
    this.adapters.set(adapter.api, adapter)
  }

  get(api: ModelApi): ProtocolAdapter {
    const adapter = this.adapters.get(api)
    if (!adapter) throw new Error(`No protocol adapter registered for api "${api}"`)
    return adapter
  }

  list(): ProtocolAdapter[] {
    return Array.from(this.adapters.values())
  }
}

export function createProtocolRegistry(adapters: ProtocolAdapter[] = []): ProtocolRegistry {
  const registry = new ProtocolRegistry()
  registerBuiltInProtocolAdapters(registry)
  for (const adapter of adapters) registry.register(adapter)
  return registry
}

export function registerBuiltInProtocolAdapters(registry: ProtocolRegistry): void {
  registry.register({
    api: 'anthropic-messages',
    createLanguageModel: ({ model, apiKey }) =>
      createAnthropic({
        apiKey,
        ...(model.baseUrl && { baseURL: model.baseUrl }),
        ...(model.headers && { headers: model.headers }),
      })(model.modelId),
  })

  registry.register({
    api: 'openai-chat-completions',
    createLanguageModel: ({ model, apiKey }) => {
      if (model.provider === 'openrouter') {
        return createOpenRouter({
          apiKey,
          appName: (model.compat?.openrouterAppName as string | undefined) ?? 'Aila',
        })(model.modelId, { usage: { include: true } })
      }
      return createOpenAI({
        apiKey,
        ...(model.baseUrl && { baseURL: model.baseUrl }),
        ...(model.headers && { headers: model.headers }),
        name: model.provider,
      }).chat(model.modelId)
    },
  })

  registry.register({
    api: 'openai-responses',
    createLanguageModel: ({ model, apiKey }) =>
      createOpenAI({
        apiKey,
        ...(model.baseUrl && { baseURL: model.baseUrl }),
        ...(model.headers && { headers: model.headers }),
        name: model.provider,
      }).responses(model.modelId),
  })

  registry.register({
    api: 'google-generative-ai',
    createLanguageModel: ({ model, apiKey }) =>
      createGoogleGenerativeAI({
        apiKey,
        ...(model.baseUrl && { baseURL: model.baseUrl }),
        ...(model.headers && { headers: model.headers }),
      })(model.modelId),
  })
}
