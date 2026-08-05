import { createAiSdkModelStreamClient } from './ai-sdk-model-stream'
import { createModelRegistry, type ModelRegistry } from './model-registry'
import type { ModelStreamClient, ModelStreamRequest } from './model-stream'
import { createProtocolRegistry, type ProtocolAdapter, type ProtocolRegistry } from './protocols'

export interface DefaultModelStreamClientOptions {
  protocolRegistry?: ProtocolRegistry
  protocolAdapters?: ProtocolAdapter[]
  modelRegistry?: ModelRegistry
  imageDir?: string
  fetch?: typeof globalThis.fetch
  /** Compatibility escape hatch for hosts that still require the native clients. */
  useNativeProtocols?: boolean
}

export function createDefaultModelStreamClient(
  options: DefaultModelStreamClientOptions = {},
): ModelStreamClient {
  const protocolRegistry =
    options.protocolRegistry ?? createProtocolRegistry(options.protocolAdapters)
  const clients = new Map<string, ModelStreamClient>()
  const aiSdkClient = createAiSdkModelStreamClient({
    modelRegistry: options.modelRegistry ?? createModelRegistry(),
    imageDir: options.imageDir,
    fetch: options.fetch,
  })

  return {
    stream(input: ModelStreamRequest) {
      if (!options.useNativeProtocols && isAiSdkProtocol(input.descriptor.api)) {
        return aiSdkClient.stream(input)
      }
      let client = clients.get(input.descriptor.api)
      if (!client) {
        client = protocolRegistry
          .get(input.descriptor.api)
          .createModelStreamClient({ imageDir: options.imageDir })
        clients.set(input.descriptor.api, client)
      }
      return client.stream(input)
    },
  }
}

function isAiSdkProtocol(api: string): boolean {
  return (
    api === 'anthropic-messages' ||
    api === 'openai-chat-completions' ||
    api === 'openai-responses' ||
    api === 'google-generative-ai'
  )
}
