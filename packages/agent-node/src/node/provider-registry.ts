import type { ConnectionModel, ModelApi, ProviderDefinition } from '@aila/agent'

function planModels(api: ModelApi, ids: readonly string[]): ConnectionModel[] {
  return ids.map((id) => ({
    id,
    api,
    capabilities: { tools: true },
  }))
}

export const BUILTIN_PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models through the Anthropic API.',
    authKind: 'api_key',
    defaultApi: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    runtimeAdapter: { kind: 'anthropic' },
    category: 'api',
    modelDiscovery: { kind: 'protocol' },
    credentialLabel: 'API key',
    signupUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT and Codex models through the OpenAI API.',
    authKind: 'api_key',
    defaultApi: 'openai-chat-completions',
    defaultBaseUrl: 'https://api.openai.com/v1',
    runtimeAdapter: { kind: 'openai' },
    category: 'api',
    modelDiscovery: { kind: 'protocol' },
    credentialLabel: 'API key',
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'google',
    label: 'Google',
    description: 'Gemini models through Google AI Studio.',
    authKind: 'api_key',
    defaultApi: 'google-generative-ai',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    runtimeAdapter: { kind: 'google' },
    category: 'api',
    modelDiscovery: { kind: 'protocol' },
    credentialLabel: 'API key',
    signupUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek chat and reasoning models.',
    authKind: 'api_key',
    defaultApi: 'openai-chat-completions',
    defaultBaseUrl: 'https://api.deepseek.com',
    runtimeAdapter: { kind: 'openai-compatible', name: 'deepseek', includeUsage: true },
    category: 'api',
    modelDiscovery: { kind: 'protocol' },
    credentialLabel: 'API key',
    signupUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'One API key for models from many providers.',
    authKind: 'api_key',
    defaultApi: 'openai-chat-completions',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    runtimeAdapter: { kind: 'openai-compatible', name: 'openrouter', includeUsage: true },
    category: 'api',
    modelDiscovery: { kind: 'protocol' },
    credentialLabel: 'API key',
    signupUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    id: 'kimi-coding-plan',
    label: 'Kimi Coding Plan',
    description: 'Kimi models billed through a Coding Plan subscription.',
    authKind: 'api_key',
    defaultApi: 'anthropic-messages',
    defaultBaseUrl: 'https://api.kimi.com/coding/v1',
    runtimeAdapter: { kind: 'anthropic' },
    category: 'coding-plan',
    modelDiscovery: { kind: 'protocol' },
    credentialLabel: 'Coding key',
    signupUrl: 'https://www.kimi.com/code',
  },
  {
    id: 'minimax-coding-plan',
    label: 'MiniMax Coding Plan',
    description: 'MiniMax Token Plan over the Anthropic-compatible protocol.',
    authKind: 'api_key',
    defaultApi: 'anthropic-messages',
    defaultBaseUrl: 'https://api.minimax.io/anthropic',
    runtimeAdapter: { kind: 'anthropic' },
    category: 'coding-plan',
    modelDiscovery: { kind: 'protocol' },
    fallbackModels: planModels('anthropic-messages', ['MiniMax-M3']),
    credentialLabel: 'Coding key',
    signupUrl: 'https://platform.minimax.io/subscribe/coding-plan',
  },
  {
    id: 'zai-coding-plan',
    label: 'Z.AI Coding Plan',
    description: 'GLM coding models through the Z.AI Coding Plan.',
    authKind: 'api_key',
    defaultApi: 'openai-chat-completions',
    defaultBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
    runtimeAdapter: { kind: 'openai-compatible', name: 'zai-coding-plan', includeUsage: true },
    category: 'coding-plan',
    modelDiscovery: { kind: 'protocol' },
    fallbackModels: planModels('openai-chat-completions', ['glm-4.7', 'glm-4.6', 'glm-4.5-air']),
    credentialLabel: 'Coding key',
    signupUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    id: 'tencent-coding-plan',
    label: 'Tencent Coding Plan',
    description: 'Tencent Cloud Coding Plan for interactive coding agents.',
    authKind: 'api_key',
    defaultApi: 'openai-chat-completions',
    defaultBaseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'tencent-coding-plan',
      includeUsage: true,
    },
    category: 'coding-plan',
    modelDiscovery: { kind: 'protocol' },
    fallbackModels: planModels('openai-chat-completions', [
      'tc-code-latest',
      'glm-5',
      'minimax-m2.5',
      'kimi-k2.5',
    ]),
    credentialLabel: 'Coding key',
    signupUrl: 'https://console.cloud.tencent.com/lkeap/coding-plan',
  },
  {
    id: 'volcengine-coding-plan',
    label: 'Volcengine Ark Coding Plan',
    description: 'Volcengine Ark subscription for interactive AI coding tools.',
    authKind: 'api_key',
    defaultApi: 'openai-chat-completions',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'volcengine-coding-plan',
      includeUsage: true,
    },
    category: 'coding-plan',
    modelDiscovery: { kind: 'protocol' },
    fallbackModels: planModels('openai-chat-completions', [
      'ark-code-latest',
      'doubao-seed-2.0-code',
      'doubao-seed-2.0-pro',
      'doubao-seed-2.0-lite',
      'doubao-seed-code',
      'minimax-m2.7',
      'minimax-m3',
      'glm-5.2',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'kimi-k2.6',
      'kimi-k2.7-code',
    ]),
    credentialLabel: 'Coding key',
    signupUrl: 'https://www.volcengine.com/activity/codingplan',
  },
  {
    id: 'alibaba-coding-plan-cn',
    label: 'Alibaba Coding Plan (China)',
    description: 'Alibaba Cloud Model Studio Coding Plan for mainland China.',
    authKind: 'api_key',
    defaultApi: 'openai-chat-completions',
    defaultBaseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'alibaba-coding-plan-cn',
      includeUsage: true,
    },
    category: 'coding-plan',
    modelDiscovery: { kind: 'static' },
    fallbackModels: alibabaCodingPlanModels(),
    credentialLabel: 'Coding key',
    signupUrl: 'https://www.aliyun.com/benefit/scene/codingplan',
  },
  {
    id: 'alibaba-coding-plan',
    label: 'Alibaba Coding Plan',
    description: 'Alibaba Cloud Model Studio Coding Plan for the international endpoint.',
    authKind: 'api_key',
    defaultApi: 'openai-chat-completions',
    defaultBaseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'alibaba-coding-plan',
      includeUsage: true,
    },
    category: 'coding-plan',
    modelDiscovery: { kind: 'static' },
    fallbackModels: alibabaCodingPlanModels(),
    credentialLabel: 'Coding key',
    signupUrl: 'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
  },
  {
    id: 'claude-subscription',
    label: 'Claude Subscription',
    description: 'Use a Claude subscription account through Claude Code OAuth.',
    authKind: 'oauth_token',
    defaultApi: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    runtimeAdapter: { kind: 'claude-subscription' },
    category: 'account',
    modelDiscovery: { kind: 'protocol' },
    credentialLabel: 'OAuth token',
  },
  {
    id: 'openai-codex',
    label: 'ChatGPT / Codex',
    description: 'Use Codex models included with a ChatGPT account.',
    authKind: 'oauth_token',
    defaultApi: 'openai-responses',
    defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
    runtimeAdapter: { kind: 'openai-codex' },
    category: 'account',
    modelDiscovery: { kind: 'protocol' },
    credentialLabel: 'OAuth token',
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    description: 'Models available through a GitHub Copilot account.',
    authKind: 'oauth_token',
    defaultApi: 'openai-chat-completions',
    defaultBaseUrl: 'https://api.githubcopilot.com',
    runtimeAdapter: { kind: 'github-copilot' },
    category: 'account',
    modelDiscovery: { kind: 'protocol' },
    credentialLabel: 'GitHub token',
  },
]

function alibabaCodingPlanModels(): ConnectionModel[] {
  return planModels('openai-chat-completions', [
    'qwen3.7-plus',
    'qwen3.7-max',
    'qwen3.6-plus',
    'qwen3.6-flash',
    'qwen3.5-plus',
    'qwen3-max-2026-01-23',
    'qwen3-coder-next',
    'qwen3-coder-plus',
    'glm-5',
    'glm-4.7',
    'kimi-k2.5',
    'MiniMax-M2.5',
  ])
}

export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>()

  constructor(definitions: readonly ProviderDefinition[] = BUILTIN_PROVIDER_DEFINITIONS) {
    for (const definition of definitions) this.register(definition)
  }

  register(definition: ProviderDefinition): void {
    this.definitions.set(definition.id, structuredClone(definition))
  }

  resolve(providerType: string): ProviderDefinition {
    const definition = this.definitions.get(providerType)
    if (definition) return structuredClone(definition)
    return {
      id: providerType,
      label: providerType,
      authKind: 'api_key',
      defaultApi: 'openai-chat-completions',
      runtimeAdapter: {
        kind: 'openai-compatible',
        name: providerType,
        includeUsage: true,
      },
      category: 'custom',
      modelDiscovery: { kind: 'protocol' },
      credentialLabel: 'API key',
    }
  }

  list(): ProviderDefinition[] {
    return Array.from(this.definitions.values(), (definition) => structuredClone(definition))
  }
}

export function createProviderRegistry(
  definitions?: readonly ProviderDefinition[],
): ProviderRegistry {
  return new ProviderRegistry(definitions)
}
