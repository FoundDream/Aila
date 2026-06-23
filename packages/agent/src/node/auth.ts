import type { ModelDescriptor, ProviderId } from '../models'
import type { Settings } from '../settings-types'
import type { NodeProviderConfig } from './model-registry'

export interface NodeAuthInput {
  apiKeys?: Partial<Record<ProviderId, string | undefined>>
  settings?: Settings
  providers?: Record<string, Omit<NodeProviderConfig, 'provider'>>
  env?: NodeJS.ProcessEnv
}

export class MissingApiKeyError extends Error {
  constructor(public readonly providerId: ProviderId) {
    super(`No API key configured for provider "${providerId}"`)
  }
}

export const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

export function resolveApiKey(
  providerId: ProviderId,
  input: NodeAuthInput = {},
): string | undefined {
  const direct = input.apiKeys?.[providerId]
  if (direct && direct.trim().length > 0) return direct
  const fromSettings = input.settings?.apiKeys?.[providerId]
  if (fromSettings && fromSettings.trim().length > 0) return fromSettings
  const env = input.env ?? process.env
  const envKey = ENV_KEY_BY_PROVIDER[providerId]
  const fromEnv = envKey ? env[envKey] : undefined
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv
  const configured = input.providers?.[providerId]?.apiKey
  if (configured) return resolveConfiguredValue(configured, env)
  return undefined
}

export function requireApiKey(model: ModelDescriptor, input: NodeAuthInput = {}): string {
  const apiKey = resolveApiKey(model.provider, input)
  if (!apiKey) throw new MissingApiKeyError(model.provider)
  return apiKey
}

export function configuredProviders(settings: Settings, input: NodeAuthInput = {}): ProviderId[] {
  const providers = new Set<ProviderId>([
    ...Object.keys(ENV_KEY_BY_PROVIDER),
    ...Object.keys(settings.apiKeys ?? {}),
    ...Object.keys(input.apiKeys ?? {}),
    ...Object.keys(input.providers ?? {}),
  ])
  return Array.from(providers).filter((provider) =>
    Boolean(resolveApiKey(provider, { ...input, settings })),
  )
}

export function resolveConfiguredValue(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (value.startsWith('$')) return env[value.slice(1)] ?? ''
  return value
}
