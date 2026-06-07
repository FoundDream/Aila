import type { ChatMessage, ModelInfo, ToolCall } from './agent'
import type { PersistedMessage, PersistedTextBlock, PersistedToolCallBlock } from './conversations'

const APPROX_CHARS_PER_TOKEN = 4
const DEFAULT_CONTEXT_TOKENS = 32_000
const RESERVED_OUTPUT_TOKENS = 4_000
const MIN_CONTEXT_CHARS = 16_000
const MAX_CONTEXT_CHARS = 180_000
const MAX_TOOL_RESULT_CHARS = 16_000
const MAX_OMITTED_SUMMARY_CHARS = 5_000

interface ContextRound {
  source: PersistedMessage
  messages: ChatMessage[]
  charCost: number
}

export interface BuildAgentContextInput {
  messages: PersistedMessage[]
  modelInfo: ModelInfo
  profileInstructions?: string
  transientContext?: ChatMessage[]
}

export interface AgentContextResult {
  messages: ChatMessage[]
  stats: {
    budgetChars: number
    includedRounds: number
    omittedRounds: number
  }
}

function charCost(messages: ChatMessage[]): number {
  return JSON.stringify(messages).length
}

function getContextBudgetChars(modelInfo: ModelInfo): number {
  const contextTokens = modelInfo.contextLength ?? DEFAULT_CONTEXT_TOKENS
  const inputTokens = Math.max(4_000, contextTokens - RESERVED_OUTPUT_TOKENS)
  const budget = inputTokens * APPROX_CHARS_PER_TOKEN
  return Math.max(MIN_CONTEXT_CHARS, Math.min(MAX_CONTEXT_CHARS, budget))
}

function truncateChars(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[${label} truncated: ${text.length - maxChars} chars omitted]`
}

function textContent(message: PersistedMessage): string {
  return message.blocks
    .filter((b): b is PersistedTextBlock => b.type === 'text')
    .map((b) => b.content)
    .join('')
}

function toolCalls(message: PersistedMessage): PersistedToolCallBlock[] {
  return message.blocks.filter(
    (b): b is PersistedToolCallBlock => b.type === 'tool_call' && b.result !== undefined,
  )
}

function messageToRound(message: PersistedMessage): ContextRound | null {
  if (message.role === 'user') {
    const content = textContent(message)
    if (!content) return null
    const messages: ChatMessage[] = [{ role: 'user', content }]
    return { source: message, messages, charCost: charCost(messages) }
  }

  if (message.status !== 'done') return null

  const content = textContent(message)
  const calls = toolCalls(message)
  if (!content && calls.length === 0) return null

  const assistant: ChatMessage = {
    role: 'assistant',
    content,
    ...(calls.length > 0 && {
      tool_calls: calls.map(
        (tc): ToolCall => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        }),
      ),
    }),
  }

  const toolMessages: ChatMessage[] = calls.map((tc) => ({
    role: 'tool',
    tool_call_id: tc.id,
    content: truncateChars(tc.result ?? '', MAX_TOOL_RESULT_CHARS, `tool result ${tc.name}`),
  }))

  const messages = [assistant, ...toolMessages]
  return { source: message, messages, charCost: charCost(messages) }
}

function preview(text: string, max = 240): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : `${compact.slice(0, max)}...`
}

function summarizeOmittedRounds(rounds: ContextRound[]): ChatMessage | null {
  if (rounds.length === 0) return null

  const userSnippets: string[] = []
  const toolNames = new Map<string, number>()

  for (const round of rounds) {
    const source = round.source
    if (source.role === 'user') {
      const snippet = preview(textContent(source))
      if (snippet) userSnippets.push(snippet)
      continue
    }
    for (const tc of toolCalls(source)) {
      toolNames.set(tc.name, (toolNames.get(tc.name) ?? 0) + 1)
    }
  }

  const recentUserSnippets = userSnippets.slice(-8)
  const toolSummary = Array.from(toolNames.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} x${count}`)
    .join(', ')

  const lines = [
    'Earlier conversation context was compacted to stay within the model context window.',
    `Omitted persisted rounds: ${rounds.length}.`,
  ]
  if (recentUserSnippets.length > 0) {
    lines.push('Recent omitted user requests:')
    for (const snippet of recentUserSnippets) lines.push(`- ${snippet}`)
  }
  if (toolSummary) lines.push(`Omitted tool activity: ${toolSummary}.`)

  return {
    role: 'system',
    content: truncateChars(lines.join('\n'), MAX_OMITTED_SUMMARY_CHARS, 'omitted summary'),
  }
}

export function buildAgentContext(input: BuildAgentContextInput): AgentContextResult {
  const budgetChars = getContextBudgetChars(input.modelInfo)
  const historyBudget = Math.max(MIN_CONTEXT_CHARS, budgetChars)
  const rounds = input.messages.map(messageToRound).filter((r): r is ContextRound => r !== null)

  const selected: ContextRound[] = []
  let used = 0
  for (let i = rounds.length - 1; i >= 0; i--) {
    const round = rounds[i]
    if (selected.length > 0 && used + round.charCost > historyBudget) break
    selected.unshift(round)
    used += round.charCost
  }

  const omittedCount = Math.max(0, rounds.length - selected.length)
  const summaryMessage = summarizeOmittedRounds(rounds.slice(0, omittedCount))
  const output: ChatMessage[] = []
  if (input.profileInstructions?.trim()) {
    output.push({
      role: 'system',
      content: `Agent profile instructions:\n${input.profileInstructions.trim()}`,
    })
  }
  if (input.transientContext) output.push(...input.transientContext)
  if (summaryMessage) output.push(summaryMessage)
  output.push(...selected.flatMap((round) => round.messages))

  return {
    messages: output,
    stats: {
      budgetChars,
      includedRounds: selected.length,
      omittedRounds: omittedCount,
    },
  }
}
