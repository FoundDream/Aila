/**
 * Per-call provider/model resolution. Each streamChat call creates a fresh
 * provider instance with the current settings — no global registry, so key
 * changes in the SettingsModal take effect immediately.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
// `@ai-sdk/google-vertex` Node entry tries google-auth-library when `apiKey`
// is absent; we want pure-key auth, so import the projectless factory directly.
import { createVertex } from '@ai-sdk/google-vertex'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { ProviderId } from '@shared/models'
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
    case 'vertex':
      // SDK's apiKey path forces the Express Mode endpoint (projectless).
      // SA-bound keys are accepted there for `generateContent`; project +
      // location only matter for Imagen :predict, handled in the image adapter.
      return createVertex({ apiKey })(modelId)
    case 'openrouter':
      return createOpenRouter({ apiKey, appName: APP_NAME })(modelId, {
        usage: { include: true },
      })
  }
}
