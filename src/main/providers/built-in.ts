/**
 * Built-in provider definitions — Anthropic, OpenAI, Google, Google Vertex.
 * Model lists come from the hand-written catalog in ./model-catalog.
 */

import { ANTHROPIC_MODELS, GOOGLE_MODELS, OPENAI_MODELS, VERTEX_MODELS } from './model-catalog'
import type { ModelConfig, ProtocolName, ProviderConfig } from './types'

interface BuiltInDef {
  id: string
  displayName: string
  api: ProtocolName
  provider: string
  baseUrl: string
  models: ModelConfig[]
}

const BUILT_IN_DEFS: BuiltInDef[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ANTHROPIC_MODELS,
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: OPENAI_MODELS,
  },
  {
    id: 'google',
    displayName: 'Google',
    api: 'google-generative-ai',
    provider: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    models: GOOGLE_MODELS,
  },
  {
    id: 'google-vertex',
    displayName: 'Google Vertex AI',
    api: 'google-vertex',
    provider: 'google-vertex',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
    models: VERTEX_MODELS,
  },
]

/** Create built-in provider configs with hard-coded model lists. */
export function createBuiltInProviders(): ProviderConfig[] {
  return BUILT_IN_DEFS.map((def) => ({
    id: def.id,
    displayName: def.displayName,
    api: def.api,
    provider: def.provider,
    baseUrl: def.baseUrl,
    apiKey: '',
    models: def.models.map((m) => ({ ...m })),
    isBuiltIn: true,
  }))
}
