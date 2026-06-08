import type { ToolWebSearchRequest, ToolWebSearchResult } from '../runtime/core'

interface TavilyResponse {
  answer?: string
  results?: Array<{
    title?: string
    url?: string
    content?: string
  }>
}

export async function webSearch(request: ToolWebSearchRequest): Promise<ToolWebSearchResult> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not set. Add it to .env and restart the app.')
  }

  const body: Record<string, unknown> = {
    query: request.query,
    search_depth: request.searchDepth,
    topic: request.topic,
    max_results: request.maxResults,
    include_answer: true,
  }
  if (request.timeRange) body.time_range = request.timeRange

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: request.signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Tavily ${response.status}: ${text || response.statusText}`)
  }

  const data = (await response.json()) as TavilyResponse
  return {
    answer: data.answer,
    results: (data.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content,
    })),
  }
}
