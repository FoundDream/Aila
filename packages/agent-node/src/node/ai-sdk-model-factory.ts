import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ModelDescriptor, ProviderDefinition } from '@aila/agent'
import type { LanguageModel } from 'ai'

export interface AiSdkModelFactoryInput {
  descriptor: ModelDescriptor
  definition: ProviderDefinition
  credential: string
  fetch?: typeof globalThis.fetch
}

const ANTHROPIC_BETA = 'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14'

export function createAiSdkLanguageModel(input: AiSdkModelFactoryInput): LanguageModel {
  const { descriptor, definition, credential, fetch } = input
  const adapter = definition.runtimeAdapter
  const baseURL = descriptor.baseUrl ?? definition.defaultBaseUrl
  const headers = descriptor.headers

  if (adapter.kind === 'claude-subscription') {
    return createAnthropic({
      authToken: credential,
      baseURL: anthropicV1BaseUrl(baseURL ?? 'https://api.anthropic.com'),
      fetch,
      headers: { ...claudeSubscriptionHeaders(), ...headers },
    }).chat(descriptor.modelId)
  }

  if (adapter.kind === 'openai-codex') {
    return createOpenAI({
      apiKey: credential,
      baseURL: baseURL ?? 'https://chatgpt.com/backend-api/codex',
      fetch,
      headers: { ...openAiCodexHeaders(credential), ...headers },
    }).responses(descriptor.modelId)
  }

  if (adapter.kind === 'github-copilot') {
    const copilotHeaders = { ...githubCopilotHeaders(), ...headers }
    if (descriptor.api === 'anthropic-messages') {
      return createAnthropic({
        authToken: credential,
        baseURL: anthropicV1BaseUrl(baseURL ?? 'https://api.githubcopilot.com'),
        fetch,
        headers: copilotHeaders,
      }).chat(descriptor.modelId)
    }
    if (descriptor.api === 'openai-responses') {
      return createOpenAI({
        apiKey: credential,
        baseURL,
        fetch,
        headers: copilotHeaders,
      }).responses(descriptor.modelId)
    }
    return createOpenAICompatible({
      name: 'github-copilot',
      apiKey: credential,
      baseURL: requireBaseUrl(baseURL, definition.id),
      fetch,
      headers: copilotHeaders,
      includeUsage: true,
    }).chatModel(descriptor.modelId)
  }

  if (adapter.kind === 'anthropic' || descriptor.api === 'anthropic-messages') {
    return createAnthropic({
      ...(adapter.kind === 'anthropic' && adapter.auth === 'bearer'
        ? { authToken: credential }
        : { apiKey: credential }),
      baseURL: baseURL ? anthropicV1BaseUrl(baseURL) : undefined,
      fetch,
      headers: { 'anthropic-beta': ANTHROPIC_BETA, ...headers },
    }).chat(descriptor.modelId)
  }

  if (adapter.kind === 'google' || descriptor.api === 'google-generative-ai') {
    return createGoogle({
      apiKey: credential,
      baseURL: baseURL ? googleV1BetaBaseUrl(baseURL) : undefined,
      fetch,
      headers,
    }).chat(descriptor.modelId)
  }

  if (adapter.kind === 'openai' || descriptor.api === 'openai-responses') {
    const openai = createOpenAI({ apiKey: credential, baseURL, fetch, headers })
    return descriptor.api === 'openai-responses' ||
      (adapter.kind === 'openai' && adapter.api === 'responses')
      ? openai.responses(descriptor.modelId)
      : openai.chat(descriptor.modelId)
  }

  return createOpenAICompatible({
    name: adapter.kind === 'openai-compatible' ? (adapter.name ?? definition.id) : definition.id,
    apiKey: credential,
    baseURL: requireBaseUrl(baseURL, definition.id),
    fetch,
    headers,
    includeUsage: adapter.kind === 'openai-compatible' ? adapter.includeUsage : true,
  }).chatModel(descriptor.modelId)
}

function githubCopilotHeaders(): Record<string, string> {
  return {
    'User-Agent': 'GitHubCopilotChat/0.35.0',
    'Editor-Version': 'vscode/1.107.0',
    'Editor-Plugin-Version': 'copilot-chat/0.35.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'Openai-Intent': 'conversation-edits',
    'X-GitHub-Api-Version': '2026-06-01',
  }
}

function anthropicV1BaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1`
}

function googleV1BetaBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1beta$/i, '')}/v1beta`
}

function requireBaseUrl(baseUrl: string | undefined, providerType: string): string {
  if (baseUrl) return baseUrl
  throw new Error(`Provider "${providerType}" requires a base URL`)
}

function claudeSubscriptionHeaders(): Record<string, string> {
  return {
    'User-Agent': 'claude-cli/2.1.153 (external, cli)',
    'anthropic-beta':
      'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
  }
}

function openAiCodexHeaders(accessToken: string): Record<string, string> {
  const accountId = extractJwtString(accessToken, [
    ['chatgpt_account_id'],
    ['https://api.openai.com/auth', 'chatgpt_account_id'],
  ])
  return {
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs/0.0.0 (Aila)',
  }
}

function extractJwtString(
  token: string,
  paths: readonly (readonly string[])[],
): string | undefined {
  const encoded = token.split('.')[1]
  if (!encoded) return undefined
  try {
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4)
    const payload = JSON.parse(
      Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as Record<string, unknown>
    for (const path of paths) {
      let value: unknown = payload
      for (const key of path) {
        value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : null
      }
      if (typeof value === 'string' && value) return value
    }
  } catch {
    // A non-JWT credential is valid for some compatible deployments.
  }
  return undefined
}
