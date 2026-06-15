import type { ModelApi } from '../models'
import { createAnthropicModelStreamClient } from './anthropic-model-stream'
import { createGoogleModelStreamClient } from './google-model-stream'
import type { ModelStreamClient } from './model-stream'
import { createOpenAiChatModelStreamClient } from './openai-chat-model-stream'

export interface ProtocolAdapterInput {
  imageDir?: string
}

export interface ProtocolAdapter {
  api: ModelApi
  createModelStreamClient: (input: ProtocolAdapterInput) => ModelStreamClient
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
    createModelStreamClient: ({ imageDir }) => createAnthropicModelStreamClient({ imageDir }),
  })

  registry.register({
    api: 'openai-chat-completions',
    createModelStreamClient: ({ imageDir }) => createOpenAiChatModelStreamClient({ imageDir }),
  })

  registry.register({
    api: 'openai-responses',
    createModelStreamClient: () => unsupportedNativeProtocol('openai-responses'),
  })

  registry.register({
    api: 'google-generative-ai',
    createModelStreamClient: ({ imageDir }) => createGoogleModelStreamClient({ imageDir }),
  })
}

function unsupportedNativeProtocol(api: ModelApi): ModelStreamClient {
  return {
    async *stream() {
      yield {
        type: 'error',
        error: new Error(`No native model stream client registered for api "${api}"`),
      }
    },
  }
}
