import { type Static, Type } from '@sinclair/typebox'
import { tavily } from '@tavily/core'
import type { Tool } from '../../agent-core/types'
import type { ToolContext } from '../types'

const SEARCH_DESCRIPTION =
  'Search the web for current information using Tavily. Use this when you need up-to-date information, facts, documentation, news, or anything not available in local files.'

const SEARCH_PROMPT_SNIPPET =
  'Search the web for current information, facts, documentation, or news.'

const SEARCH_PROMPT_GUIDELINES = [
  'Use web_search when the user asks about current events, recent data, or anything not available in local files',
  'Prefer "basic" searchDepth for simple factual queries; use "advanced" for in-depth research',
  'Use the "news" topic for recent events, "finance" for market or financial data',
  'Always cite the source URL when presenting search results to the user',
  'Combine multiple search queries when the topic is complex rather than relying on a single broad query',
]

const EXTRACT_DESCRIPTION =
  'Extract the main content from one or more web pages. Use this when you have a specific URL and need to read its contents.'

const EXTRACT_PROMPT_SNIPPET = 'Extract and read the main content from web page URLs.'

const EXTRACT_PROMPT_GUIDELINES = [
  'Use web_extract when you have specific URLs to read, such as documentation pages, articles, or reference links',
  'Prefer web_extract over web_search when the user provides a direct URL',
  'You can extract multiple URLs in a single call for efficiency',
  'Report any failed extractions to the user with the URL and error reason',
]

const searchSchema = Type.Object({
  query: Type.String({ description: 'The search query' }),
  searchDepth: Type.Optional(
    Type.Union([Type.Literal('basic'), Type.Literal('advanced')], {
      description:
        'Search depth: "basic" for fast results, "advanced" for thorough results. Defaults to "basic".',
    }),
  ),
  topic: Type.Optional(
    Type.Union([Type.Literal('general'), Type.Literal('news'), Type.Literal('finance')], {
      description: 'Search topic category. Defaults to "general".',
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({ description: 'Maximum number of results to return. Defaults to 5.' }),
  ),
  includeAnswer: Type.Optional(
    Type.Boolean({ description: 'Include a short AI-generated answer. Defaults to true.' }),
  ),
})

const extractSchema = Type.Object({
  urls: Type.Array(Type.String(), { description: 'URLs to extract content from' }),
})

type SearchParams = Static<typeof searchSchema>
type ExtractParams = Static<typeof extractSchema>

function getClient(ctx: ToolContext) {
  const apiKey = ctx.getWebSearchConfig().tavilyApiKey
  if (!apiKey) {
    throw new Error('Web Search is not configured. Add a Tavily API key in Settings > Web Search.')
  }
  return tavily({ apiKey })
}

function createWebSearchTool(ctx: ToolContext): Tool<typeof searchSchema> {
  return {
    name: 'web_search',
    label: 'Web Search',
    description: SEARCH_DESCRIPTION,
    promptSnippet: SEARCH_PROMPT_SNIPPET,
    promptGuidelines: SEARCH_PROMPT_GUIDELINES,
    parameters: searchSchema,
    async execute(params: SearchParams, _ctx) {
      const client = getClient(ctx)
      const response = await client.search(params.query, {
        searchDepth: params.searchDepth ?? 'basic',
        topic: params.topic,
        maxResults: params.maxResults ?? 5,
        includeAnswer: params.includeAnswer !== false,
      })

      const parts: string[] = []

      if (response.answer) {
        parts.push(`**Answer:** ${response.answer}`)
        parts.push('')
      }

      for (const result of response.results) {
        parts.push(`### ${result.title}`)
        parts.push(`URL: ${result.url}`)
        parts.push(result.content)
        parts.push('')
      }

      return {
        content: [{ type: 'text', text: parts.join('\n') }],
        details: undefined,
      }
    },
  }
}

function createWebExtractTool(ctx: ToolContext): Tool<typeof extractSchema> {
  return {
    name: 'web_extract',
    label: 'Web Extract',
    description: EXTRACT_DESCRIPTION,
    promptSnippet: EXTRACT_PROMPT_SNIPPET,
    promptGuidelines: EXTRACT_PROMPT_GUIDELINES,
    parameters: extractSchema,
    async execute(params: ExtractParams, _ctx) {
      const client = getClient(ctx)
      const response = await client.extract(params.urls)

      const parts: string[] = []

      for (const result of response.results) {
        parts.push(`### ${result.title ?? result.url}`)
        parts.push(`URL: ${result.url}`)
        parts.push(result.rawContent)
        parts.push('')
      }

      if (response.failedResults.length > 0) {
        parts.push('**Failed to extract:**')
        for (const failed of response.failedResults) {
          parts.push(`- ${failed.url}: ${failed.error}`)
        }
      }

      return {
        content: [{ type: 'text', text: parts.join('\n') }],
        details: undefined,
      }
    },
  }
}

export function createTavilyTools(ctx: ToolContext): Tool[] {
  return [createWebSearchTool(ctx), createWebExtractTool(ctx)]
}
