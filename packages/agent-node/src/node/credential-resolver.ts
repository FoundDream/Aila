import type { ModelDescriptor, ResolvedProviderCredential, Settings } from '@aila/agent'
import {
  MissingApiKeyError,
  type NodeAuthInput,
  resolveApiKey,
  resolveConfiguredValue,
} from './auth'
import type { ModelRegistry } from './model-registry'

export interface CredentialResolutionInput {
  descriptor: ModelDescriptor
  settings: Settings
}

export interface CredentialResolver {
  resolve(input: CredentialResolutionInput): Promise<ResolvedProviderCredential>
}

export interface CreateCredentialResolverInput extends NodeAuthInput {
  modelRegistry: ModelRegistry
}

/**
 * Resolves credentials at the physical request boundary. Callers may replace
 * this with an OAuth-aware resolver that refreshes an expiring token.
 */
export function createCredentialResolver(
  options: CreateCredentialResolverInput,
): CredentialResolver {
  return {
    async resolve({ descriptor, settings }) {
      const connectionId = descriptor.connectionId ?? descriptor.provider
      const providerConfig = options.modelRegistry.getProviderConfig(connectionId)
      const providerType = descriptor.providerType ?? providerConfig?.providerType ?? connectionId
      const definition = options.modelRegistry.getProviderDefinition(connectionId, providerType)
      if (definition.authKind === 'none') return { value: '', kind: 'none' }

      const env = options.env ?? process.env
      const credentialRef = providerConfig?.credentialRef ?? connectionId
      const configuredCredential = options.credentials?.[credentialRef]
      const value =
        (configuredCredential ? resolveConfiguredValue(configuredCredential, env) : undefined) ??
        resolveApiKey(connectionId, { ...options, settings }) ??
        (providerType !== connectionId
          ? resolveApiKey(providerType, { ...options, settings })
          : undefined)

      if (!value?.trim()) {
        if (definition.authKind === 'optional_api_key') {
          return { value: '', kind: definition.authKind }
        }
        throw new MissingApiKeyError(connectionId)
      }
      return { value, kind: definition.authKind }
    },
  }
}
