/**
 * Per-call provider/model resolution. Each streamChat call creates a fresh
 * provider instance with the current settings — no global registry, so key
 * changes in the SettingsModal take effect immediately.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import type { ProviderId } from '@aila/agent'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import { resolveApiKey, type Settings } from './settings'

export class MissingApiKeyError extends Error {
  constructor(public readonly providerId: ProviderId) {
    super(`No API key configured for provider "${providerId}"`)
  }
}

const APP_NAME = process.env.OPENROUTER_APP_NAME || 'Aila'

export function resolveModel(
  providerId: ProviderId,
  modelId: string,
  settings: Settings,
): LanguageModel {
  const apiKey = resolveApiKey(providerId, settings)
  if (!apiKey) throw new MissingApiKeyError(providerId)

  switch (providerId) {
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId)
    case 'openai':
      return createOpenAI({ apiKey })(modelId)
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId)
    case 'openrouter':
      return createOpenRouter({ apiKey, appName: APP_NAME })(modelId, {
        usage: { include: true },
      })
  }
}
