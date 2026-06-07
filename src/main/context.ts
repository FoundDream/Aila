import type { ChatMessage, ModelInfo, ToolCall } from './agent'
import type { PersistedMessage, PersistedTextBlock, PersistedToolCallBlock } from './conversations'
import type { DocRecord } from './docs'

const APPROX_CHARS_PER_TOKEN = 4
const DEFAULT_CONTEXT_TOKENS = 32_000
const RESERVED_OUTPUT_TOKENS = 4_000
const MIN_CONTEXT_CHARS = 16_000
const MAX_CONTEXT_CHARS = 180_000
const MAX_TOOL_RESULT_CHARS = 16_000
const MAX_OMITTED_SUMMARY_CHARS = 5_000
const MAX_DOC_CHARS = 70_000
const DOC_CHUNK_TARGET_CHARS = 2_400

interface ContextRound {
  source: PersistedMessage
  messages: ChatMessage[]
  charCost: number
}

export interface BuildAgentContextInput {
  messages: PersistedMessage[]
  modelInfo: ModelInfo
  latestUserText: string
  doc?: DocRecord | null
  profileInstructions?: string
}

export interface AgentContextResult {
  messages: ChatMessage[]
  stats: {
    budgetChars: number
    includedRounds: number
    omittedRounds: number
    docWasTruncated: boolean
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

interface DocChunk {
  index: number
  text: string
  score: number
}

function keywords(text: string): string[] {
  const found = text.toLowerCase().match(/[a-z0-9_\-/]{3,}|[\u4e00-\u9fff]{2,}/g) ?? []
  return Array.from(new Set(found)).slice(0, 24)
}

function chunkMarkdown(content: string): DocChunk[] {
  const blocks = content.split(/(?=\n#{1,6}\s)|\n{2,}/g)
  const chunks: DocChunk[] = []
  let current = ''

  function flush(): void {
    if (!current.trim()) {
      current = ''
      return
    }
    chunks.push({ index: chunks.length, text: current.trim(), score: 0 })
    current = ''
  }

  for (const block of blocks) {
    if (current.length + block.length > DOC_CHUNK_TARGET_CHARS) flush()
    current = current ? `${current}\n\n${block}` : block
  }
  flush()

  return chunks.length > 0 ? chunks : [{ index: 0, text: content, score: 0 }]
}

function buildDocContext(doc: DocRecord, latestUserText: string, maxChars: number): ChatMessage {
  const header =
    '你正在协助用户编辑一篇 Markdown 文档。可以用 `edit_doc` 工具直接修改它。' +
    '如果文档内容被分片注入，chunk 标记不是文档正文的一部分；调用 `edit_doc` 时只使用正文里的原文片段。\n' +
    `文档元信息：\n  - path: ${doc.path}\n  - title: ${doc.title}\n\n`

  const contentBudget = Math.max(4_000, maxChars - header.length - 1_000)
  if (doc.content.length <= contentBudget) {
    return {
      role: 'system',
      content: `${header}当前完整内容如下：\n\n---\n\n${doc.content}`,
    }
  }

  const terms = keywords(latestUserText)
  const chunks = chunkMarkdown(doc.content)
  const lastIndex = chunks.length - 1

  for (const chunk of chunks) {
    const lower = chunk.text.toLowerCase()
    if (chunk.index === 0) chunk.score += 3
    if (chunk.index === lastIndex) chunk.score += 2
    for (const term of terms) {
      if (lower.includes(term)) chunk.score += 5
    }
  }

  const selected: DocChunk[] = []
  let used = 0
  for (const chunk of [...chunks].sort((a, b) => b.score - a.score || a.index - b.index)) {
    const boundedChunk =
      chunk.text.length > contentBudget
        ? {
            ...chunk,
            text: truncateChars(chunk.text, Math.max(1_000, contentBudget - 80), 'doc chunk'),
          }
        : chunk
    const nextCost = boundedChunk.text.length + 80
    if (selected.length > 0 && used + nextCost > contentBudget) continue
    selected.push(boundedChunk)
    used += nextCost
    if (used >= contentBudget) break
  }

  selected.sort((a, b) => a.index - b.index)
  const body = selected
    .map((chunk) => `--- chunk ${chunk.index + 1}/${chunks.length} ---\n${chunk.text}`)
    .join('\n\n')

  return {
    role: 'system',
    content:
      `${header}当前文档较长，已按上下文预算注入 ${selected.length}/${chunks.length} 个相关片段。\n\n` +
      body,
  }
}

export function buildAgentContext(input: BuildAgentContextInput): AgentContextResult {
  const budgetChars = getContextBudgetChars(input.modelInfo)
  const docBudget = Math.min(MAX_DOC_CHARS, Math.floor(budgetChars * 0.45))
  const docMessage = input.doc ? buildDocContext(input.doc, input.latestUserText, docBudget) : null
  const docCost = docMessage ? charCost([docMessage]) : 0
  const historyBudget = Math.max(MIN_CONTEXT_CHARS, budgetChars - docCost)
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
  if (docMessage) output.push(docMessage)
  if (summaryMessage) output.push(summaryMessage)
  output.push(...selected.flatMap((round) => round.messages))

  return {
    messages: output,
    stats: {
      budgetChars,
      includedRounds: selected.length,
      omittedRounds: omittedCount,
      docWasTruncated: Boolean(input.doc && input.doc.content.length > docBudget),
    },
  }
}
