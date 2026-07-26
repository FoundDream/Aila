import type { ToolWebSearchRequest, ToolWebSearchResult } from '@aila/agent'
import { type CreateWebSearchRegistryInput, createDefaultWebSearch } from '../node/web-search'
import { loadSettings } from './settings'

export async function webSearch(request: ToolWebSearchRequest): Promise<ToolWebSearchResult> {
  return createDefaultWebSearch({ providers: buildWebSearchProviders() })(request)
}

function buildWebSearchProviders(): CreateWebSearchRegistryInput['providers'] {
  const settings = loadSettings().webSearch?.providers ?? {}
  return {
    ...(settings.tavily?.apiKey?.trim() && {
      tavily: { apiKey: settings.tavily.apiKey.trim() },
    }),
    ...(settings.searxng?.baseUrl?.trim() && {
      searxng: { baseUrl: settings.searxng.baseUrl.trim() },
    }),
    ...(settings.brave?.apiKey?.trim() && {
      brave: { apiKey: settings.brave.apiKey.trim() },
    }),
    ...(settings.google?.apiKey?.trim() &&
      settings.google.cx?.trim() && {
        google: { apiKey: settings.google.apiKey.trim(), cx: settings.google.cx.trim() },
      }),
    duckduckgo: { disabled: settings.duckduckgo?.enabled === false },
    wikimedia: { disabled: settings.wikimedia?.enabled === false },
    hackernews: { disabled: settings.hackernews?.enabled === false },
    arxiv: { disabled: settings.arxiv?.enabled === false },
    stackexchange: {
      disabled: settings.stackexchange?.enabled === false,
      site: settings.stackexchange?.site?.trim() || 'stackoverflow',
    },
  }
}
