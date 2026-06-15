import type { ModelStreamClient, ModelStreamRequest } from './model-stream'
import { createProtocolRegistry, type ProtocolAdapter, type ProtocolRegistry } from './protocols'

export interface DefaultModelStreamClientOptions {
  protocolRegistry?: ProtocolRegistry
  protocolAdapters?: ProtocolAdapter[]
  imageDir?: string
}

export function createDefaultModelStreamClient(
  options: DefaultModelStreamClientOptions = {},
): ModelStreamClient {
  const protocolRegistry =
    options.protocolRegistry ?? createProtocolRegistry(options.protocolAdapters)
  const clients = new Map<string, ModelStreamClient>()

  return {
    stream(input: ModelStreamRequest) {
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
