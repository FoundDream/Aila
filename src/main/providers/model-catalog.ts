/**
 * Hand-written model catalog. Replaces pi-ai's `getModels()`.
 *
 * Only lists models Aila actually wants to surface in the UI. Add new entries
 * as models ship; keep obsolete ones until the UI is migrated off them.
 */

import type { ModelConfig } from './types'

export const ANTHROPIC_MODELS: ModelConfig[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    toolUse: true,
    reasoning: true,
    supportsImageInput: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    toolUse: true,
    reasoning: true,
    supportsImageInput: true,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    toolUse: true,
    reasoning: true,
    supportsImageInput: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    toolUse: true,
    reasoning: true,
    supportsImageInput: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    toolUse: true,
    reasoning: true,
    supportsImageInput: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-3-5-haiku-20241022',
    name: 'Claude Haiku 3.5',
    toolUse: true,
    reasoning: false,
    supportsImageInput: true,
    contextWindow: 200_000,
    maxTokens: 8192,
  },
]

export const OPENAI_MODELS: ModelConfig[] = [
  {
    id: 'gpt-5',
    name: 'GPT-5',
    toolUse: true,
    reasoning: true,
    supportsImageInput: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    toolUse: true,
    reasoning: true,
    supportsImageInput: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    toolUse: true,
    reasoning: false,
    supportsImageInput: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    toolUse: true,
    reasoning: false,
    supportsImageInput: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: 'o3',
    name: 'o3',
    toolUse: true,
    reasoning: true,
    supportsImageInput: true,
    contextWindow: 200_000,
    maxTokens: 100_000,
  },
  {
    id: 'o3-mini',
    name: 'o3-mini',
    toolUse: true,
    reasoning: true,
    supportsImageInput: false,
    contextWindow: 200_000,
    maxTokens: 100_000,
  },
]

export const GOOGLE_MODELS: ModelConfig[] = [
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    toolUse: true,
    reasoning: true,
    supportsImageInput: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    toolUse: true,
    reasoning: true,
    supportsImageInput: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    toolUse: true,
    reasoning: false,
    supportsImageInput: true,
    contextWindow: 1_048_576,
    maxTokens: 8192,
  },
]

// Vertex surfaces the same Gemini models; Vertex adds no new IDs today.
export const VERTEX_MODELS: ModelConfig[] = GOOGLE_MODELS.map((m) => ({ ...m }))
