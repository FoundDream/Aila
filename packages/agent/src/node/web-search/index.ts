import type {
  ToolWebSearcher,
  ToolWebSearchRequest,
  ToolWebSearchResult,
  ToolWebSearchResultItem,
} from '../../tools'

export type WebSearchProviderId =
  | 'tavily'
  | 'searxng'
  | 'brave'
  | 'google'
  | 'duckduckgo'
  | 'wikimedia'
  | 'hackernews'
  | 'arxiv'
  | 'stackexchange'
  | (string & {})

export interface WebSearchProviderConfig {
  apiKey?: string
  baseUrl?: string
  cx?: string
  site?: string
  language?: string
  disabled?: boolean
  headers?: Record<string, string>
}

export interface WebSearchProvider {
  id: WebSearchProviderId
  canHandle?: (request: ToolWebSearchRequest) => boolean
  search: (request: ToolWebSearchRequest) => Promise<ToolWebSearchResult>
}

export interface CreateWebSearchRegistryInput {
  providers?: Partial<Record<WebSearchProviderId, WebSearchProviderConfig>>
  adapters?: WebSearchProvider[]
  order?: WebSearchProviderId[]
  advancedMode?: 'first-success' | 'merge'
  fetch?: typeof fetch
}

interface ProviderSearchFailure {
  provider: WebSearchProviderId
  error: unknown
}

const DEFAULT_ORDER: WebSearchProviderId[] = [
  'tavily',
  'searxng',
  'brave',
  'google',
  'duckduckgo',
  'wikimedia',
]

const NEWS_ORDER: WebSearchProviderId[] = [
  'tavily',
  'brave',
  'searxng',
  'hackernews',
  'google',
  'duckduckgo',
  'wikimedia',
]

const DEFAULT_PROVIDERS: Partial<Record<WebSearchProviderId, WebSearchProviderConfig>> = {
  duckduckgo: {},
  wikimedia: {},
  hackernews: {},
  arxiv: {},
  stackexchange: { site: 'stackoverflow' },
}

export class WebSearchRegistry {
  private readonly providers = new Map<WebSearchProviderId, WebSearchProvider>()

  constructor(
    private readonly input: CreateWebSearchRegistryInput = {},
    providers: WebSearchProvider[] = [],
  ) {
    for (const provider of providers) this.register(provider)
  }

  register(provider: WebSearchProvider): void {
    this.providers.set(provider.id, provider)
  }

  list(): WebSearchProvider[] {
    return Array.from(this.providers.values())
  }

  async search(request: ToolWebSearchRequest): Promise<ToolWebSearchResult> {
    const providers = this.resolveProviders(request)
    if (providers.length === 0) throw new Error('No web search providers are configured')

    if (request.searchDepth === 'advanced' && this.input.advancedMode !== 'first-success') {
      return this.searchMerged(request, providers)
    }
    return this.searchFirstSuccess(request, providers)
  }

  private resolveProviders(request: ToolWebSearchRequest): WebSearchProvider[] {
    const order = this.resolveOrder(request)
    const seen = new Set<WebSearchProviderId>()
    const providers: WebSearchProvider[] = []
    for (const id of order) {
      if (seen.has(id)) continue
      seen.add(id)
      const provider = this.providers.get(id)
      if (!provider) continue
      if (provider.canHandle && !provider.canHandle(request)) continue
      providers.push(provider)
    }
    return providers
  }

  private resolveOrder(request: ToolWebSearchRequest): WebSearchProviderId[] {
    const base =
      request.topic === 'news'
        ? NEWS_ORDER
        : this.input.order?.length
          ? this.input.order
          : DEFAULT_ORDER
    if (request.searchDepth !== 'advanced') return base

    const expanded = [...base]
    if (looksAcademic(request.query)) expanded.push('arxiv')
    if (looksTechnical(request.query)) expanded.push('stackexchange', 'hackernews')
    return expanded
  }

  private async searchFirstSuccess(
    request: ToolWebSearchRequest,
    providers: WebSearchProvider[],
  ): Promise<ToolWebSearchResult> {
    const failures: ProviderSearchFailure[] = []
    let emptyResult: ToolWebSearchResult | null = null
    for (const provider of providers) {
      try {
        const result = normalizeResult(
          await provider.search(request),
          provider.id,
          request.maxResults,
        )
        if (isUsefulResult(result)) return result
        emptyResult ??= result
      } catch (error) {
        failures.push({ provider: provider.id, error })
      }
    }
    if (emptyResult) return emptyResult
    throw webSearchError(failures)
  }

  private async searchMerged(
    request: ToolWebSearchRequest,
    providers: WebSearchProvider[],
  ): Promise<ToolWebSearchResult> {
    const settled = await Promise.all(
      providers.map(async (provider) => {
        try {
          return {
            status: 'fulfilled' as const,
            provider: provider.id,
            result: normalizeResult(
              await provider.search(request),
              provider.id,
              request.maxResults,
            ),
          }
        } catch (error) {
          return { status: 'rejected' as const, provider: provider.id, error }
        }
      }),
    )
    const failures: ProviderSearchFailure[] = []
    const results: ToolWebSearchResultItem[] = []
    let answer: string | undefined
    for (const item of settled) {
      if (item.status === 'rejected') {
        failures.push({ provider: item.provider, error: item.error })
        continue
      }
      answer ??= item.result.answer
      results.push(...(item.result.results ?? []))
    }
    if (results.length === 0 && !answer && failures.length === settled.length) {
      throw webSearchError(failures)
    }
    return {
      ...(answer && { answer }),
      results: dedupeResults(results).slice(0, request.maxResults),
    }
  }
}

export function createWebSearchRegistry(
  input: CreateWebSearchRegistryInput = {},
): WebSearchRegistry {
  const registry = new WebSearchRegistry(input)
  registerBuiltInWebSearchProviders(registry, input)
  for (const adapter of input.adapters ?? []) registry.register(adapter)
  return registry
}

export function createDefaultWebSearch(input: CreateWebSearchRegistryInput = {}): ToolWebSearcher {
  const registry = createWebSearchRegistry(input)
  return (request) => registry.search(request)
}

export function registerBuiltInWebSearchProviders(
  registry: WebSearchRegistry,
  input: CreateWebSearchRegistryInput = {},
): void {
  const providerConfigs = resolveProviderConfigs(input)
  const httpFetch = input.fetch ?? fetch
  maybeRegister(registry, 'tavily', providerConfigs, (config) =>
    createTavilyProvider(config, httpFetch),
  )
  maybeRegister(registry, 'searxng', providerConfigs, (config) =>
    createSearxngProvider(config, httpFetch),
  )
  maybeRegister(registry, 'brave', providerConfigs, (config) =>
    createBraveProvider(config, httpFetch),
  )
  maybeRegister(registry, 'google', providerConfigs, (config) =>
    createGoogleProvider(config, httpFetch),
  )
  maybeRegister(registry, 'duckduckgo', providerConfigs, (config) =>
    createDuckDuckGoProvider(config, httpFetch),
  )
  maybeRegister(registry, 'wikimedia', providerConfigs, (config) =>
    createWikimediaProvider(config, httpFetch),
  )
  maybeRegister(registry, 'hackernews', providerConfigs, (config) =>
    createHackerNewsProvider(config, httpFetch),
  )
  maybeRegister(registry, 'arxiv', providerConfigs, (config) =>
    createArxivProvider(config, httpFetch),
  )
  maybeRegister(registry, 'stackexchange', providerConfigs, (config) =>
    createStackExchangeProvider(config, httpFetch),
  )
}

function maybeRegister(
  registry: WebSearchRegistry,
  id: WebSearchProviderId,
  configs: Partial<Record<WebSearchProviderId, WebSearchProviderConfig>>,
  createProvider: (config: WebSearchProviderConfig) => WebSearchProvider | null,
): void {
  const config = configs[id]
  if (!config || config.disabled) return
  const provider = createProvider(config)
  if (provider) registry.register(provider)
}

function resolveProviderConfigs(
  input: CreateWebSearchRegistryInput,
): Partial<Record<WebSearchProviderId, WebSearchProviderConfig>> {
  const merged: Partial<Record<WebSearchProviderId, WebSearchProviderConfig>> = {
    ...DEFAULT_PROVIDERS,
    ...(input.providers ?? {}),
  }
  for (const [id, config] of Object.entries(merged)) {
    merged[id] = resolveProviderConfig(config ?? {})
  }
  return merged
}

function resolveProviderConfig(config: WebSearchProviderConfig): WebSearchProviderConfig {
  return {
    ...config,
    ...(config.apiKey !== undefined && { apiKey: config.apiKey.trim() }),
    ...(config.baseUrl !== undefined && { baseUrl: trimTrailingSlash(config.baseUrl.trim()) }),
    ...(config.cx !== undefined && { cx: config.cx.trim() }),
  }
}

function createTavilyProvider(
  config: WebSearchProviderConfig,
  httpFetch: typeof fetch,
): WebSearchProvider | null {
  if (!config.apiKey) return null
  const apiKey = config.apiKey
  return {
    id: 'tavily',
    async search(request) {
      const body: Record<string, unknown> = {
        query: request.query,
        search_depth: request.searchDepth,
        topic: request.topic,
        max_results: request.maxResults,
        include_answer: true,
      }
      if (request.timeRange) body.time_range = request.timeRange
      const data = await fetchJson<TavilyResponse>(
        httpFetch,
        'https://api.tavily.com/search',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(config.headers ?? {}),
          },
          body: JSON.stringify(body),
          signal: request.signal,
        },
        'Tavily',
      )
      return {
        answer: data.answer,
        results: (data.results ?? []).map((result) => ({
          title: result.title,
          url: result.url,
          content: result.content,
          source: 'tavily',
        })),
      }
    },
  }
}

function createSearxngProvider(
  config: WebSearchProviderConfig,
  httpFetch: typeof fetch,
): WebSearchProvider | null {
  if (!config.baseUrl) return null
  return {
    id: 'searxng',
    async search(request) {
      const url = new URL(`${config.baseUrl}/search`)
      url.searchParams.set('q', request.query)
      url.searchParams.set('format', 'json')
      url.searchParams.set('categories', request.topic === 'news' ? 'news' : 'general')
      if (request.timeRange) url.searchParams.set('time_range', searxngTimeRange(request.timeRange))
      const data = await fetchJson<SearxngResponse>(
        httpFetch,
        url,
        {
          headers: config.headers,
          signal: request.signal,
        },
        'SearXNG',
      )
      return {
        answer: data.answers?.[0],
        results: (data.results ?? []).map((result) => ({
          title: result.title,
          url: result.url,
          content: result.content,
          source: 'searxng',
          publishedAt: result.publishedDate,
        })),
      }
    },
  }
}

function createBraveProvider(
  config: WebSearchProviderConfig,
  httpFetch: typeof fetch,
): WebSearchProvider | null {
  if (!config.apiKey) return null
  const apiKey = config.apiKey
  return {
    id: 'brave',
    async search(request) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search')
      url.searchParams.set('q', request.query)
      url.searchParams.set('count', String(Math.min(request.maxResults, 10)))
      if (request.timeRange) url.searchParams.set('freshness', braveFreshness(request.timeRange))
      const data = await fetchJson<BraveResponse>(
        httpFetch,
        url,
        {
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': apiKey,
            ...(config.headers ?? {}),
          },
          signal: request.signal,
        },
        'Brave',
      )
      return {
        results: (data.web?.results ?? []).map((result) => ({
          title: result.title,
          url: result.url,
          content: result.description,
          source: 'brave',
          publishedAt: result.age,
        })),
      }
    },
  }
}

function createGoogleProvider(
  config: WebSearchProviderConfig,
  httpFetch: typeof fetch,
): WebSearchProvider | null {
  if (!config.apiKey || !config.cx) return null
  return {
    id: 'google',
    async search(request) {
      const url = new URL('https://www.googleapis.com/customsearch/v1')
      url.searchParams.set('key', config.apiKey ?? '')
      url.searchParams.set('cx', config.cx ?? '')
      url.searchParams.set('q', request.query)
      url.searchParams.set('num', String(Math.min(request.maxResults, 10)))
      const data = await fetchJson<GoogleResponse>(
        httpFetch,
        url,
        {
          headers: config.headers,
          signal: request.signal,
        },
        'Google',
      )
      return {
        results: (data.items ?? []).map((result) => ({
          title: result.title,
          url: result.link,
          content: result.snippet,
          source: 'google',
        })),
      }
    },
  }
}

function createDuckDuckGoProvider(
  config: WebSearchProviderConfig,
  httpFetch: typeof fetch,
): WebSearchProvider {
  return {
    id: 'duckduckgo',
    async search(request) {
      const url = new URL(config.baseUrl ?? 'https://api.duckduckgo.com/')
      url.searchParams.set('q', request.query)
      url.searchParams.set('format', 'json')
      url.searchParams.set('no_redirect', '1')
      url.searchParams.set('no_html', '1')
      url.searchParams.set('skip_disambig', '1')
      const data = await fetchJson<DuckDuckGoResponse>(
        httpFetch,
        url,
        {
          headers: config.headers,
          signal: request.signal,
        },
        'DuckDuckGo',
      )
      const results = [
        ...duckDuckGoTopicResults(data.RelatedTopics ?? []),
        ...(data.AbstractURL
          ? [
              {
                title: data.Heading,
                url: data.AbstractURL,
                content: data.AbstractText,
                source: 'duckduckgo',
              },
            ]
          : []),
      ]
      return {
        answer: data.AbstractText || undefined,
        results,
      }
    },
  }
}

function createWikimediaProvider(
  config: WebSearchProviderConfig,
  httpFetch: typeof fetch,
): WebSearchProvider {
  return {
    id: 'wikimedia',
    async search(request) {
      const language = config.language ?? 'en'
      const url = new URL(
        config.baseUrl ?? `https://api.wikimedia.org/core/v1/wikipedia/${language}/search/page`,
      )
      url.searchParams.set('q', request.query)
      url.searchParams.set('limit', String(Math.min(request.maxResults, 10)))
      const data = await fetchJson<WikimediaResponse>(
        httpFetch,
        url,
        {
          headers: {
            'Api-User-Agent': 'Aila/0.1 (https://github.com/)',
            ...(config.headers ?? {}),
          },
          signal: request.signal,
        },
        'Wikimedia',
      )
      return {
        results: (data.pages ?? []).map((page) => {
          const title = page.title ?? page.key ?? request.query
          return {
            title: page.title,
            url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(page.key ?? title)}`,
            content: stripHtml(page.excerpt ?? page.description ?? ''),
            source: 'wikimedia',
          }
        }),
      }
    },
  }
}

function createHackerNewsProvider(
  config: WebSearchProviderConfig,
  httpFetch: typeof fetch,
): WebSearchProvider {
  return {
    id: 'hackernews',
    canHandle: (request) => request.topic === 'news' || looksTechnical(request.query),
    async search(request) {
      const url = new URL(config.baseUrl ?? 'https://hn.algolia.com/api/v1/search')
      url.searchParams.set('query', request.query)
      url.searchParams.set('tags', 'story')
      url.searchParams.set('hitsPerPage', String(Math.min(request.maxResults, 10)))
      const data = await fetchJson<HackerNewsResponse>(
        httpFetch,
        url,
        {
          headers: config.headers,
          signal: request.signal,
        },
        'Hacker News',
      )
      return {
        results: (data.hits ?? []).map((hit) => ({
          title: hit.title ?? hit.story_title,
          url: hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
          content: hit.comment_text ? stripHtml(hit.comment_text) : undefined,
          source: 'hackernews',
          publishedAt: hit.created_at,
        })),
      }
    },
  }
}

function createArxivProvider(
  config: WebSearchProviderConfig,
  httpFetch: typeof fetch,
): WebSearchProvider {
  return {
    id: 'arxiv',
    canHandle: (request) => request.searchDepth === 'advanced' && looksAcademic(request.query),
    async search(request) {
      const url = new URL(config.baseUrl ?? 'https://export.arxiv.org/api/query')
      url.searchParams.set('search_query', `all:${request.query}`)
      url.searchParams.set('start', '0')
      url.searchParams.set('max_results', String(Math.min(request.maxResults, 10)))
      const response = await httpFetch(url, { headers: config.headers, signal: request.signal })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`arXiv ${response.status}: ${text || response.statusText}`)
      }
      const xml = await response.text()
      return { results: parseArxivEntries(xml) }
    },
  }
}

function createStackExchangeProvider(
  config: WebSearchProviderConfig,
  httpFetch: typeof fetch,
): WebSearchProvider {
  return {
    id: 'stackexchange',
    canHandle: (request) => request.searchDepth === 'advanced' && looksTechnical(request.query),
    async search(request) {
      const url = new URL(config.baseUrl ?? 'https://api.stackexchange.com/2.3/search/advanced')
      url.searchParams.set('order', 'desc')
      url.searchParams.set('sort', 'relevance')
      url.searchParams.set('site', config.site ?? 'stackoverflow')
      url.searchParams.set('q', request.query)
      url.searchParams.set('pagesize', String(Math.min(request.maxResults, 10)))
      const data = await fetchJson<StackExchangeResponse>(
        httpFetch,
        url,
        {
          headers: config.headers,
          signal: request.signal,
        },
        'Stack Exchange',
      )
      return {
        results: (data.items ?? []).map((item) => ({
          title: decodeHtml(stripHtml(item.title ?? '')),
          url: item.link,
          content: item.tags?.length ? `Tags: ${item.tags.join(', ')}` : undefined,
          source: 'stackexchange',
          publishedAt: item.creation_date
            ? new Date(item.creation_date * 1000).toISOString()
            : undefined,
        })),
      }
    },
  }
}

async function fetchJson<T>(
  httpFetch: typeof fetch,
  url: string | URL,
  init: RequestInit,
  providerLabel: string,
): Promise<T> {
  const response = await httpFetch(url, init)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${providerLabel} ${response.status}: ${text || response.statusText}`)
  }
  return (await response.json()) as T
}

function normalizeResult(
  result: ToolWebSearchResult,
  source: WebSearchProviderId,
  maxResults: number,
): ToolWebSearchResult {
  return {
    ...(result.answer && { answer: result.answer }),
    results: (result.results ?? [])
      .map((item) => normalizeResultItem(item, source))
      .filter((item) => item.title || item.url || item.content)
      .slice(0, maxResults),
  }
}

function normalizeResultItem(
  item: ToolWebSearchResultItem,
  source: WebSearchProviderId,
): ToolWebSearchResultItem {
  return {
    ...(item.title && { title: decodeHtml(stripHtml(item.title)) }),
    ...(item.url && { url: item.url }),
    ...(item.content && { content: decodeHtml(stripHtml(item.content)) }),
    source: item.source ?? source,
    ...(item.publishedAt && { publishedAt: item.publishedAt }),
  }
}

function dedupeResults(results: ToolWebSearchResultItem[]): ToolWebSearchResultItem[] {
  const seen = new Set<string>()
  const deduped: ToolWebSearchResultItem[] = []
  for (const result of results) {
    const key = result.url ? normalizeUrl(result.url) : `title:${result.title ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(result)
  }
  return deduped
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return url
  }
}

function isUsefulResult(result: ToolWebSearchResult): boolean {
  return Boolean(result.answer?.trim() || result.results?.length)
}

function webSearchError(failures: ProviderSearchFailure[]): Error {
  if (failures.length === 0) return new Error('No web search results')
  return new Error(
    `All web search providers failed: ${failures
      .map((failure) => `${failure.provider}: ${errorMessage(failure.error)}`)
      .join('; ')}`,
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function searxngTimeRange(timeRange: NonNullable<ToolWebSearchRequest['timeRange']>): string {
  if (timeRange === 'day') return 'day'
  if (timeRange === 'year') return 'year'
  return 'month'
}

function braveFreshness(timeRange: NonNullable<ToolWebSearchRequest['timeRange']>): string {
  switch (timeRange) {
    case 'day':
      return 'pd'
    case 'week':
      return 'pw'
    case 'month':
      return 'pm'
    case 'year':
      return 'py'
  }
}

function looksAcademic(query: string): boolean {
  return /\b(arxiv|paper|papers|research|study|studies|citation|doi|preprint)\b/i.test(query)
}

function looksTechnical(query: string): boolean {
  return /\b(error|exception|typescript|javascript|python|react|node|vite|electron|api|sdk|github|stackoverflow|bug|compile|runtime)\b/i.test(
    query,
  )
}

function duckDuckGoTopicResults(topics: DuckDuckGoTopic[]): ToolWebSearchResultItem[] {
  return topics.flatMap((topic) => {
    if (topic.Topics) return duckDuckGoTopicResults(topic.Topics)
    if (!topic.FirstURL && !topic.Text) return []
    return [
      {
        title: topic.Text?.split(' - ')[0],
        url: topic.FirstURL,
        content: topic.Text,
        source: 'duckduckgo',
      },
    ]
  })
}

function parseArxivEntries(xml: string): ToolWebSearchResultItem[] {
  const entries = Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g))
  return entries.map((entry) => {
    const raw = entry[1] ?? ''
    return {
      title: decodeHtml(stripXml(readXmlTag(raw, 'title'))),
      url: readXmlTag(raw, 'id'),
      content: decodeHtml(stripXml(readXmlTag(raw, 'summary'))),
      source: 'arxiv',
      publishedAt: readXmlTag(raw, 'published') || undefined,
    }
  })
}

function readXmlTag(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim()
}

function stripXml(value?: string): string | undefined {
  if (!value) return undefined
  return value.replace(/\s+/g, ' ').trim()
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtml(value?: string): string | undefined {
  if (!value) return undefined
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

interface TavilyResponse {
  answer?: string
  results?: Array<{ title?: string; url?: string; content?: string }>
}

interface SearxngResponse {
  answers?: string[]
  results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }>
}

interface BraveResponse {
  web?: {
    results?: Array<{ title?: string; url?: string; description?: string; age?: string }>
  }
}

interface GoogleResponse {
  items?: Array<{ title?: string; link?: string; snippet?: string }>
}

interface DuckDuckGoTopic {
  Text?: string
  FirstURL?: string
  Topics?: DuckDuckGoTopic[]
}

interface DuckDuckGoResponse {
  Heading?: string
  AbstractText?: string
  AbstractURL?: string
  RelatedTopics?: DuckDuckGoTopic[]
}

interface WikimediaResponse {
  pages?: Array<{ key?: string; title?: string; excerpt?: string; description?: string }>
}

interface HackerNewsResponse {
  hits?: Array<{
    title?: string
    story_title?: string
    url?: string
    story_url?: string
    objectID: string
    created_at?: string
    comment_text?: string
  }>
}

interface StackExchangeResponse {
  items?: Array<{
    title?: string
    link?: string
    tags?: string[]
    creation_date?: number
  }>
}
