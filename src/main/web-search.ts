import { createDefaultWebSearch } from '@aila/agent/node'

export const webSearch = createDefaultWebSearch({
  providers: {
    tavily: { apiKey: '$TAVILY_API_KEY' },
    searxng: { baseUrl: '$SEARXNG_URL' },
    brave: { apiKey: '$BRAVE_SEARCH_API_KEY' },
    google: { apiKey: '$GOOGLE_SEARCH_API_KEY', cx: '$GOOGLE_SEARCH_CX' },
    duckduckgo: {},
    wikimedia: {},
    hackernews: {},
    arxiv: {},
    stackexchange: {},
  },
})
