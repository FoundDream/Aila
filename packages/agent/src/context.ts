import type { ChatMessage, ModelInfo, ToolCall, UserContentPart } from './agent-protocol'
import type {
  PersistedFileBlock,
  PersistedImageBlock,
  PersistedMessage,
  PersistedTextBlock,
  PersistedToolCallBlock,
} from './conversation-core'

const APPROX_CHARS_PER_TOKEN = 4
const DEFAULT_CONTEXT_TOKENS = 32_000
const RESERVED_OUTPUT_TOKENS = 4_000
const MIN_CONTEXT_CHARS = 16_000
const MAX_CONTEXT_CHARS = 180_000
const MAX_TOOL_RESULT_CHARS = 16_000
const MAX_OMITTED_SUMMARY_CHARS = 5_000
const MAX_FILE_ATTACHMENT_CHARS = 16_000

interface ContextRound {
  source: PersistedMessage
  messages: ChatMessage[]
  charCost: number
}

export type AgentContextSectionKind =
  | 'stable_instructions'
  | 'dynamic_context'
  | 'compaction_summary'
  | 'selected_history'
  | 'current_user_message'

export interface AgentContextSection {
  kind: AgentContextSectionKind
  messages: ChatMessage[]
}

export interface AssembleAgentContextInput {
  stableInstructions?: ChatMessage[]
  dynamicContext?: ChatMessage[]
  /** @deprecated Use dynamicContext. Kept while adapters migrate to ContextAssembler sections. */
  transientContext?: ChatMessage[]
  messages: PersistedMessage[]
  modelInfo: ModelInfo
}

export type BuildAgentContextInput = AssembleAgentContextInput

export interface AgentContextResult {
  messages: ChatMessage[]
  sections: AgentContextSection[]
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
    const files = message.blocks.filter((b): b is PersistedFileBlock => b.type === 'file')
    const images = message.blocks.filter((b): b is PersistedImageBlock => b.type === 'image')

    const sections = [textContent(message)]
    for (const file of files) {
      const body = truncateChars(file.content, MAX_FILE_ATTACHMENT_CHARS, `file ${file.name}`)
      sections.push(`[Attached file: ${file.name}]\n\`\`\`\n${body}\n\`\`\``)
    }
    const text = sections.filter(Boolean).join('\n\n')
    if (!text && images.length === 0) return null

    const content: string | UserContentPart[] =
      images.length === 0
        ? text
        : [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...images.map((img) => ({ type: 'image' as const, url: img.url, mime: img.mime })),
          ]
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

function latestUserMessage(messages: PersistedMessage[]): PersistedMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user') return message
  }
  return null
}

function section(kind: AgentContextSectionKind, messages: ChatMessage[]): AgentContextSection[] {
  return messages.length > 0 ? [{ kind, messages }] : []
}

export class ContextAssembler {
  assemble(input: AssembleAgentContextInput): AgentContextResult {
    return assembleAgentContext(input)
  }
}

export function assembleAgentContext(input: AssembleAgentContextInput): AgentContextResult {
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
  const currentUser = latestUserMessage(input.messages)
  const currentUserIndex =
    currentUser === null ? -1 : selected.findIndex((round) => round.source.id === currentUser.id)
  const selectedHistory =
    currentUserIndex === -1
      ? selected
      : selected.filter((_, index) => index !== currentUserIndex)
  const currentUserRound = currentUserIndex === -1 ? null : selected[currentUserIndex]

  const dynamicContext = [...(input.dynamicContext ?? []), ...(input.transientContext ?? [])]
  const sections: AgentContextSection[] = [
    ...section('stable_instructions', input.stableInstructions ?? []),
    ...section('dynamic_context', dynamicContext),
    ...(summaryMessage ? section('compaction_summary', [summaryMessage]) : []),
    ...section(
      'selected_history',
      selectedHistory.flatMap((round) => round.messages),
    ),
    ...(currentUserRound ? section('current_user_message', currentUserRound.messages) : []),
  ]
  const output = sections.flatMap((contextSection) => contextSection.messages)

  return {
    messages: output,
    sections,
    stats: {
      budgetChars,
      includedRounds: selected.length,
      omittedRounds: omittedCount,
    },
  }
}

export function buildAgentContext(input: BuildAgentContextInput): AgentContextResult {
  return assembleAgentContext(input)
}
