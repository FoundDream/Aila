import type { Api, KnownProvider, Model } from '@mariozechner/pi-ai'
import { getModels } from '@mariozechner/pi-ai'
import type { ModelConfig, ProviderConfig } from './types'

interface BuiltInDef {
  id: string
  displayName: string
  api: Api
  provider: KnownProvider
  baseUrl: string
}

const BUILT_IN_DEFS: BuiltInDef[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'google',
    displayName: 'Google',
    api: 'google-generative-ai',
    provider: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
  },
  {
    id: 'google-vertex',
    displayName: 'Google Vertex AI',
    api: 'google-vertex',
    provider: 'google-vertex',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
  },
]

/** Convert a pi-ai Model to our ModelConfig with capability metadata */
function toModelConfig(m: Model<Api>): ModelConfig {
  return {
    id: m.id,
    name: m.name,
    toolUse: true, // All built-in provider models support tool use
    reasoning: m.reasoning,
    supportsImageInput: m.input.includes('image'),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }
}

/** Create built-in provider configs with models populated from pi-ai registry */
export function createBuiltInProviders(): ProviderConfig[] {
  return BUILT_IN_DEFS.map((def) => {
    let models: ModelConfig[] = []
    try {
      const piModels = getModels(def.provider)
      models = piModels.map(toModelConfig)
    } catch {
      console.warn(`[providers] failed to load models for ${def.provider} from pi-ai registry`)
    }

    return {
      id: def.id,
      displayName: def.displayName,
      api: def.api,
      provider: def.provider,
      baseUrl: def.baseUrl,
      apiKey: '',
      models,
      isBuiltIn: true,
    }
  })
}
