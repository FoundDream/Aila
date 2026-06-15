import type { ChatMessage, ModelInfo, ToolCall, UserContentPart } from './agent-protocol'
import type {
  ConversationContextCheckpoint,
  PersistedFileBlock,
  PersistedImageBlock,
  PersistedMessage,
  PersistedTextBlock,
  PersistedToolCallBlock,
  PersistedToolResultRef,
} from './conversation-core'

const APPROX_CHARS_PER_TOKEN = 4
const DEFAULT_CONTEXT_TOKENS = 32_000
const RESERVED_OUTPUT_TOKENS = 4_000
const MIN_CONTEXT_CHARS = 16_000
const MAX_CONTEXT_CHARS = 180_000
const MAX_TOOL_RESULT_CHARS = 16_000
const MAX_OMITTED_SUMMARY_CHARS = 5_000
const MAX_FILE_ATTACHMENT_CHARS = 16_000
const AUTO_COMPACT_THRESHOLD = 0.85
const AUTO_COMPACT_MIN_HISTORY_ROUNDS = 4

interface ContextRound {
  source: PersistedMessage
  messages: ChatMessage[]
  charCost: number
  sourceIndex: number
}

export type AgentContextSectionKind =
  | 'stable_instructions'
  | 'dynamic_context'
  | 'compaction_summary'
  | 'selected_history'
  | 'current_user_message'

export type AgentContextSectionSource = 'runtime' | 'conversation' | 'compaction' | 'user'

export type AgentContextSectionCachePolicy = 'stable' | 'turn' | 'conversation' | 'no_cache'

export interface AgentContextSectionMetadata {
  id: string
  source: AgentContextSectionSource
  cachePolicy: AgentContextSectionCachePolicy
  hash: string
  cacheKey: string | null
  messageCount: number
  charCost: number
}

export interface AgentContextSection {
  kind: AgentContextSectionKind
  metadata: AgentContextSectionMetadata
  messages: ChatMessage[]
}

export interface AgentContextPlanSection {
  kind: AgentContextSectionKind
  id: string
  source: AgentContextSectionSource
  cachePolicy: AgentContextSectionCachePolicy
  hash: string
  cacheKey: string | null
  messageStartIndex: number
  messageEndIndex: number
  messageCount: number
  charCost: number
}

export interface AgentContextPlan {
  version: 1
  sections: AgentContextPlanSection[]
  totalMessages: number
  totalCharCost: number
  cacheableSections: number
  budget: AgentContextBudgetPlan
  compaction: AgentContextCompactionPlan
}

export type AgentContextBudgetPressure = 'ok' | 'near_limit' | 'over_budget'

export interface AgentContextBudgetPlan {
  contextTokens: number
  reservedOutputTokens: number
  inputBudgetTokens: number
  budgetChars: number
  softBudgetChars: number
  fixedCharCost: number
  compactionCharCost: number
  selectedHistoryCharCost: number
  totalCharCost: number
  remainingChars: number
  utilization: number
  pressure: AgentContextBudgetPressure
}

export type AgentContextAutoCompactReason = 'soft_limit' | 'over_budget' | 'omitted_history'

export interface AgentContextRecommendedCheckpoint {
  id: string
  boundaryMessageId: string
  sourceMessageIds: string[]
  omittedRoundCount: number
  summary: string
  charCost: number
}

export interface AgentContextCompactionPlan {
  activeCheckpointId: string | null
  activeBoundaryMessageId: string | null
  omittedRoundCount: number
  omittedMessageIds: string[]
  selectedRoundCount: number
  shouldAutoCompact: boolean
  reason: AgentContextAutoCompactReason | null
  recommendedCheckpoint: AgentContextRecommendedCheckpoint | null
}

export interface AssembleAgentContextInput {
  stableInstructions?: ChatMessage[]
  dynamicContext?: ChatMessage[]
  /** @deprecated Use dynamicContext. Kept while adapters migrate to ContextAssembler sections. */
  transientContext?: ChatMessage[]
  messages: PersistedMessage[]
  modelInfo: ModelInfo
  compactionCheckpoint?: ConversationContextCheckpoint | null
}

export type BuildAgentContextInput = AssembleAgentContextInput

export interface AgentContextResult {
  messages: ChatMessage[]
  sections: AgentContextSection[]
  plan: AgentContextPlan
  stats: {
    budgetChars: number
    includedRounds: number
    omittedRounds: number
    shouldAutoCompact: boolean
  }
}

function charCost(messages: ChatMessage[]): number {
  return JSON.stringify(messages).length
}

export interface ContextBudgetManagerInput {
  modelInfo: ModelInfo
  reservedOutputTokens?: number
  approxCharsPerToken?: number
  minContextChars?: number
  maxContextChars?: number
  autoCompactThreshold?: number
}

export interface ContextBudgetSnapshot {
  contextTokens: number
  reservedOutputTokens: number
  inputBudgetTokens: number
  budgetChars: number
  softBudgetChars: number
}

export class ContextBudgetManager {
  readonly budget: ContextBudgetSnapshot

  constructor(input: ContextBudgetManagerInput) {
    const approxCharsPerToken = input.approxCharsPerToken ?? APPROX_CHARS_PER_TOKEN
    const reservedOutputTokens = input.reservedOutputTokens ?? RESERVED_OUTPUT_TOKENS
    const contextTokens = input.modelInfo.contextLength ?? DEFAULT_CONTEXT_TOKENS
    const inputBudgetTokens = Math.max(4_000, contextTokens - reservedOutputTokens)
    const rawBudgetChars = inputBudgetTokens * approxCharsPerToken
    const budgetChars = Math.max(
      input.minContextChars ?? MIN_CONTEXT_CHARS,
      Math.min(input.maxContextChars ?? MAX_CONTEXT_CHARS, rawBudgetChars),
    )
    const threshold = input.autoCompactThreshold ?? AUTO_COMPACT_THRESHOLD
    this.budget = {
      contextTokens,
      reservedOutputTokens,
      inputBudgetTokens,
      budgetChars,
      softBudgetChars: Math.floor(budgetChars * threshold),
    }
  }

  availableAfter(fixedCharCost: number): number {
    return Math.max(0, this.budget.budgetChars - fixedCharCost)
  }

  pressure(totalCharCost: number): AgentContextBudgetPressure {
    if (totalCharCost > this.budget.budgetChars) return 'over_budget'
    if (totalCharCost >= this.budget.softBudgetChars) return 'near_limit'
    return 'ok'
  }

  utilization(totalCharCost: number): number {
    if (this.budget.budgetChars <= 0) return 1
    return totalCharCost / this.budget.budgetChars
  }
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
    (b): b is PersistedToolCallBlock =>
      b.type === 'tool_call' && (b.result !== undefined || b.resultRef !== undefined),
  )
}

function toolResultContent(tc: PersistedToolCallBlock): string {
  if (tc.result !== undefined) return tc.result
  if (tc.resultRef) return formatPersistedToolResultReference(tc.name, tc.resultRef)
  return ''
}

function formatPersistedToolResultReference(name: string, ref: PersistedToolResultRef): string {
  return [
    `<tool-result name="${name}" persisted="true">`,
    `Full output stored at: ${ref.path}`,
    `Relative path: ${ref.relativePath}`,
    `Original size: ${ref.sizeChars} chars`,
    `Preview (${ref.preview.length} chars):`,
    ref.preview,
    '</tool-result>',
  ].join('\n')
}

function messageToRound(message: PersistedMessage, sourceIndex: number): ContextRound | null {
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
    return { source: message, messages, charCost: charCost(messages), sourceIndex }
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
    content: truncateChars(toolResultContent(tc), MAX_TOOL_RESULT_CHARS, `tool result ${tc.name}`),
  }))

  const messages = [assistant, ...toolMessages]
  return { source: message, messages, charCost: charCost(messages), sourceIndex }
}

function preview(text: string, max = 240): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : `${compact.slice(0, max)}...`
}

function summarizeOmittedRoundsContent(rounds: ContextRound[]): string | null {
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

  return truncateChars(lines.join('\n'), MAX_OMITTED_SUMMARY_CHARS, 'omitted summary')
}

function summarizeOmittedRounds(rounds: ContextRound[]): ChatMessage | null {
  const content = summarizeOmittedRoundsContent(rounds)
  if (!content) return null
  return {
    role: 'system',
    content,
  }
}

function latestUserMessage(messages: PersistedMessage[]): PersistedMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user') return message
  }
  return null
}

function activeCheckpointInput(
  messages: PersistedMessage[],
  checkpoint: ConversationContextCheckpoint | null | undefined,
): { checkpoint: ConversationContextCheckpoint; boundaryIndex: number } | null {
  if (!checkpoint) return null
  const boundaryIndex = messages.findIndex((message) => message.id === checkpoint.boundaryMessageId)
  if (boundaryIndex === -1) return null
  return { checkpoint, boundaryIndex }
}

function checkpointToMessage(checkpoint: ConversationContextCheckpoint): ChatMessage {
  return {
    role: 'system',
    content: [
      'Earlier conversation context checkpoint:',
      checkpoint.summary,
      `Checkpoint boundary message id: ${checkpoint.boundaryMessageId}.`,
    ].join('\n'),
  }
}

function selectRoundsWithinBudget(rounds: ContextRound[], budgetChars: number): ContextRound[] {
  if (budgetChars <= 0) return []
  const selected: ContextRound[] = []
  let used = 0
  for (let i = rounds.length - 1; i >= 0; i--) {
    const round = rounds[i]
    if (used + round.charCost > budgetChars) break
    selected.unshift(round)
    used += round.charCost
  }
  return selected
}

function contextRoundsCharCost(rounds: ContextRound[]): number {
  return rounds.reduce((total, round) => total + round.charCost, 0)
}

function oldestAutoCompactCandidates(rounds: ContextRound[]): ContextRound[] {
  if (rounds.length < AUTO_COMPACT_MIN_HISTORY_ROUNDS) return []
  return rounds.slice(0, Math.floor(rounds.length / 2))
}

function checkpointSummary(
  activeCheckpoint: ConversationContextCheckpoint | null,
  rounds: ContextRound[],
): string | null {
  const next = summarizeOmittedRoundsContent(rounds)
  if (!next) return activeCheckpoint?.summary ?? null
  if (!activeCheckpoint) return next
  return truncateChars(
    [activeCheckpoint.summary, next].join('\n\n'),
    MAX_OMITTED_SUMMARY_CHARS,
    'checkpoint summary',
  )
}

function createRecommendedCheckpoint(
  activeCheckpoint: ConversationContextCheckpoint | null,
  rounds: ContextRound[],
): AgentContextRecommendedCheckpoint | null {
  if (rounds.length === 0) return null
  const boundary = rounds[rounds.length - 1]?.source
  if (!boundary) return null
  const summary = checkpointSummary(activeCheckpoint, rounds)
  if (!summary) return null
  const sourceMessageIds = [
    ...(activeCheckpoint?.sourceMessageIds ?? []),
    ...rounds.map((round) => round.source.id),
  ]
  const boundaryMessageId = boundary.id
  return {
    id: `ctx_${contextHash({ boundaryMessageId, sourceMessageIds, summary }).slice(0, 16)}`,
    boundaryMessageId,
    sourceMessageIds,
    omittedRoundCount: (activeCheckpoint?.omittedRoundCount ?? 0) + rounds.length,
    summary,
    charCost: charCost([{ role: 'system', content: summary }]),
  }
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function contextHash(value: unknown): string {
  const input = stableStringify(value)
  let high = 0xdeadbeef ^ input.length
  let low = 0x41c6ce57 ^ input.length
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    high = Math.imul(high ^ code, 2654435761)
    low = Math.imul(low ^ code, 1597334677)
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909)
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909)
  return `${(high >>> 0).toString(16).padStart(8, '0')}${(low >>> 0).toString(16).padStart(8, '0')}`
}

function sectionDefaults(kind: AgentContextSectionKind): {
  source: AgentContextSectionSource
  cachePolicy: AgentContextSectionCachePolicy
} {
  switch (kind) {
    case 'stable_instructions':
      return { source: 'runtime', cachePolicy: 'stable' }
    case 'dynamic_context':
      return { source: 'runtime', cachePolicy: 'turn' }
    case 'compaction_summary':
      return { source: 'compaction', cachePolicy: 'conversation' }
    case 'selected_history':
      return { source: 'conversation', cachePolicy: 'conversation' }
    case 'current_user_message':
      return { source: 'user', cachePolicy: 'no_cache' }
  }
}

function section(kind: AgentContextSectionKind, messages: ChatMessage[]): AgentContextSection[] {
  if (messages.length === 0) return []
  const defaults = sectionDefaults(kind)
  const hash = contextHash(messages)
  const cacheKey = defaults.cachePolicy === 'no_cache' ? null : `agent-context:v1:${kind}:${hash}`
  return [
    {
      kind,
      metadata: {
        id: kind,
        ...defaults,
        hash,
        cacheKey,
        messageCount: messages.length,
        charCost: charCost(messages),
      },
      messages,
    },
  ]
}

function createContextPlan(
  sections: AgentContextSection[],
  budget: AgentContextBudgetPlan,
  compaction: AgentContextCompactionPlan,
): AgentContextPlan {
  let cursor = 0
  let totalCharCost = 0
  let cacheableSections = 0
  const planSections = sections.map((contextSection): AgentContextPlanSection => {
    const messageStartIndex = cursor
    const messageEndIndex = messageStartIndex + contextSection.messages.length
    cursor = messageEndIndex
    totalCharCost += contextSection.metadata.charCost
    if (contextSection.metadata.cachePolicy !== 'no_cache') cacheableSections += 1
    return {
      kind: contextSection.kind,
      id: contextSection.metadata.id,
      source: contextSection.metadata.source,
      cachePolicy: contextSection.metadata.cachePolicy,
      hash: contextSection.metadata.hash,
      cacheKey: contextSection.metadata.cacheKey,
      messageStartIndex,
      messageEndIndex,
      messageCount: contextSection.metadata.messageCount,
      charCost: contextSection.metadata.charCost,
    }
  })

  return {
    version: 1,
    sections: planSections,
    totalMessages: cursor,
    totalCharCost,
    cacheableSections,
    budget: {
      ...budget,
      totalCharCost,
      remainingChars: budget.budgetChars - totalCharCost,
      utilization: budget.budgetChars <= 0 ? 1 : totalCharCost / budget.budgetChars,
      pressure:
        totalCharCost > budget.budgetChars
          ? 'over_budget'
          : totalCharCost >= budget.softBudgetChars
            ? 'near_limit'
            : 'ok',
    },
    compaction,
  }
}

export class ContextAssembler {
  assemble(input: AssembleAgentContextInput): AgentContextResult {
    return assembleAgentContext(input)
  }
}

export function assembleAgentContext(input: AssembleAgentContextInput): AgentContextResult {
  const budgetManager = new ContextBudgetManager({ modelInfo: input.modelInfo })
  const dynamicContext = [...(input.dynamicContext ?? []), ...(input.transientContext ?? [])]
  const currentUser = latestUserMessage(input.messages)
  const allRounds = input.messages
    .map((message, index) => messageToRound(message, index))
    .filter((r): r is ContextRound => r !== null)
  const activeInput = activeCheckpointInput(input.messages, input.compactionCheckpoint)
  const activeCheckpoint = activeInput?.checkpoint ?? null
  const checkpointMessages = activeCheckpoint ? [checkpointToMessage(activeCheckpoint)] : []
  const candidateRounds =
    activeInput === null
      ? allRounds
      : allRounds.filter((round) => round.sourceIndex > activeInput.boundaryIndex)
  const currentUserRound =
    currentUser === null
      ? null
      : (candidateRounds.find((round) => round.source.id === currentUser.id) ?? null)
  const historyRounds =
    currentUserRound === null
      ? candidateRounds
      : candidateRounds.filter((round) => round.source.id !== currentUserRound.source.id)
  const fixedWithoutCompactionMessages = [
    ...(input.stableInstructions ?? []),
    ...dynamicContext,
    ...(currentUserRound ? currentUserRound.messages : []),
  ]
  const fixedWithoutCompactionCost = charCost(fixedWithoutCompactionMessages)

  let selectedHistory = selectRoundsWithinBudget(
    historyRounds,
    budgetManager.availableAfter(fixedWithoutCompactionCost + charCost(checkpointMessages)),
  )
  let omittedRounds = historyRounds.slice(0, historyRounds.length - selectedHistory.length)
  let omittedSummary = summarizeOmittedRounds(omittedRounds)

  if (omittedSummary) {
    selectedHistory = selectRoundsWithinBudget(
      historyRounds,
      budgetManager.availableAfter(
        fixedWithoutCompactionCost + charCost([...checkpointMessages, omittedSummary]),
      ),
    )
    omittedRounds = historyRounds.slice(0, historyRounds.length - selectedHistory.length)
    omittedSummary = summarizeOmittedRounds(omittedRounds)
  }

  const compactionMessages = [...checkpointMessages, ...(omittedSummary ? [omittedSummary] : [])]
  const selectedHistoryCharCost = contextRoundsCharCost(selectedHistory)
  const compactionCharCost = charCost(compactionMessages)
  const totalCharCost = fixedWithoutCompactionCost + compactionCharCost + selectedHistoryCharCost
  const pressure = budgetManager.pressure(totalCharCost)
  const autoCompactReason: AgentContextAutoCompactReason | null =
    omittedRounds.length > 0
      ? 'omitted_history'
      : pressure === 'over_budget'
        ? 'over_budget'
        : pressure === 'near_limit'
          ? 'soft_limit'
          : null
  const autoCompactCandidates =
    omittedRounds.length > 0
      ? omittedRounds
      : autoCompactReason
        ? oldestAutoCompactCandidates(selectedHistory)
        : []
  const recommendedCheckpoint = createRecommendedCheckpoint(activeCheckpoint, autoCompactCandidates)
  const compactionPlan: AgentContextCompactionPlan = {
    activeCheckpointId: activeCheckpoint?.id ?? null,
    activeBoundaryMessageId: activeCheckpoint?.boundaryMessageId ?? null,
    omittedRoundCount: omittedRounds.length,
    omittedMessageIds: omittedRounds.map((round) => round.source.id),
    selectedRoundCount: selectedHistory.length + (currentUserRound ? 1 : 0),
    shouldAutoCompact: recommendedCheckpoint !== null,
    reason: recommendedCheckpoint ? autoCompactReason : null,
    recommendedCheckpoint,
  }
  const budgetPlan: AgentContextBudgetPlan = {
    ...budgetManager.budget,
    fixedCharCost: fixedWithoutCompactionCost,
    compactionCharCost,
    selectedHistoryCharCost,
    totalCharCost,
    remainingChars: budgetManager.budget.budgetChars - totalCharCost,
    utilization: budgetManager.utilization(totalCharCost),
    pressure,
  }
  const sections: AgentContextSection[] = [
    ...section('stable_instructions', input.stableInstructions ?? []),
    ...section('dynamic_context', dynamicContext),
    ...section('compaction_summary', compactionMessages),
    ...section(
      'selected_history',
      selectedHistory.flatMap((round) => round.messages),
    ),
    ...(currentUserRound ? section('current_user_message', currentUserRound.messages) : []),
  ]
  const output = sections.flatMap((contextSection) => contextSection.messages)
  const plan = createContextPlan(sections, budgetPlan, compactionPlan)

  return {
    messages: output,
    sections,
    plan,
    stats: {
      budgetChars: budgetManager.budget.budgetChars,
      includedRounds: selectedHistory.length + (currentUserRound ? 1 : 0),
      omittedRounds: omittedRounds.length,
      shouldAutoCompact: compactionPlan.shouldAutoCompact,
    },
  }
}

export function buildAgentContext(input: BuildAgentContextInput): AgentContextResult {
  return assembleAgentContext(input)
}
