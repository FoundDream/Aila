import type { ChatMessage, ModelInfo, ToolCall, UserContentPart } from './agent-protocol'
import type {
  ConversationCompactArtifact,
  ConversationCompactFileArtifact,
  ConversationCompactToolActivity,
  ConversationCompactToolResultArtifact,
  ConversationContextCheckpoint,
  PersistedFileBlock,
  PersistedImageBlock,
  PersistedMessage,
  PersistedTextBlock,
  PersistedToolCallBlock,
  PersistedToolResultRef,
} from './conversation-core'
import type { ProviderId } from './models'

const APPROX_CHARS_PER_TOKEN = 4
const DEFAULT_CONTEXT_TOKENS = 32_000
const RESERVED_OUTPUT_TOKENS = 4_000
const MIN_CONTEXT_CHARS = 16_000
const MAX_CONTEXT_CHARS = 180_000
const MAX_TOOL_RESULT_CHARS = 16_000
const MAX_OMITTED_SUMMARY_CHARS = 5_000
const MAX_FILE_ATTACHMENT_CHARS = 16_000
const MAX_COMPACT_ARTIFACT_ITEMS = 20
const MAX_COMPACT_ARTIFACT_TEXT_CHARS = 2_000
const AUTO_COMPACT_THRESHOLD = 0.85
const AUTO_COMPACT_MIN_HISTORY_ROUNDS = 4
const MANUAL_COMPACT_KEEP_RECENT_ROUNDS = 2
const MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 6
const MICROCOMPACT_CLEARED_TOOL_RESULT =
  '[Old tool result content microcompacted; use checkpoint artifacts or rerun the tool if full output is needed.]'

interface ContextRound {
  source: PersistedMessage
  messages: ChatMessage[]
  charCost: number
  estimatedTokens: number
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
  estimatedTokens: number
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
  estimatedTokens: number
}

export interface AgentContextPlan {
  version: 1
  sections: AgentContextPlanSection[]
  totalMessages: number
  totalCharCost: number
  totalEstimatedTokens: number
  cacheableSections: number
  ledger: AgentContextTokenLedger
  budget: AgentContextBudgetPlan
  compaction: AgentContextCompactionPlan
}

export type ContextTokenEstimateMethod = 'provider_char_ratio'

export interface ContextTokenEstimatorSnapshot {
  providerId: ProviderId | 'unknown'
  model: string
  charsPerToken: number
  method: ContextTokenEstimateMethod
}

export interface ContextTokenEstimate {
  charCost: number
  estimatedTokens: number
  estimator: ContextTokenEstimatorSnapshot
}

export interface AgentContextTokenLedgerEntry {
  kind: AgentContextSectionKind
  id: string
  source: AgentContextSectionSource
  cachePolicy: AgentContextSectionCachePolicy
  messageCount: number
  charCost: number
  estimatedTokens: number
}

export interface AgentContextTokenPreflight {
  inputTokens: number
  method: string
  providerId?: ProviderId | 'unknown'
  model?: string
  countedAt: number
}

export interface AgentContextTokenLedger {
  estimator: ContextTokenEstimatorSnapshot
  entries: AgentContextTokenLedgerEntry[]
  totalEstimatedTokens: number
  inputBudgetTokens: number
  remainingInputTokens: number
  preflight?: AgentContextTokenPreflight
}

export type AgentContextBudgetPressure = 'ok' | 'near_limit' | 'over_budget'

export interface AgentContextBudgetPlan {
  contextTokens: number
  reservedOutputTokens: number
  inputBudgetTokens: number
  budgetChars: number
  softBudgetChars: number
  estimator: ContextTokenEstimatorSnapshot
  fixedCharCost: number
  compactionCharCost: number
  selectedHistoryCharCost: number
  totalCharCost: number
  fixedEstimatedTokens: number
  compactionEstimatedTokens: number
  selectedHistoryEstimatedTokens: number
  totalEstimatedTokens: number
  preflightInputTokens?: number
  remainingChars: number
  remainingInputTokens: number
  remainingPreflightInputTokens?: number
  utilization: number
  tokenUtilization: number
  preflightTokenUtilization?: number
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
  sourceCharCost: number
  sourceEstimatedTokens: number
  artifact: ConversationCompactArtifact
}

export interface AgentContextCompactionPlan {
  activeCheckpointId: string | null
  activeBoundaryMessageId: string | null
  omittedRoundCount: number
  omittedMessageIds: string[]
  selectedRoundCount: number
  microcompact: AgentContextMicrocompactPlan
  shouldAutoCompact: boolean
  reason: AgentContextAutoCompactReason | null
  recommendedCheckpoint: AgentContextRecommendedCheckpoint | null
}

export interface AgentContextMicrocompactPlan {
  keepRecentToolResults: number
  clearedToolResultCount: number
  keptToolResultCount: number
  savedChars: number
  savedEstimatedTokens: number
}

export interface AssembleAgentContextInput {
  stableInstructions?: ChatMessage[]
  dynamicContext?: ChatMessage[]
  messages: PersistedMessage[]
  modelInfo: ModelInfo
  providerId?: ProviderId
  compactionCheckpoint?: ConversationContextCheckpoint | null
}

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

export interface RecommendManualContextCheckpointInput extends AssembleAgentContextInput {
  keepRecentRounds?: number
}

function charCost(messages: ChatMessage[]): number {
  return JSON.stringify(messages).length
}

export interface ContextBudgetManagerInput {
  modelInfo: ModelInfo
  providerId?: ProviderId
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
  estimator: ContextTokenEstimatorSnapshot
}

function charsPerTokenForProvider(providerId: ProviderId | undefined, model: string): number {
  const provider = providerId ?? 'unknown'
  const modelKey = model.toLowerCase()
  if (provider === 'anthropic') return 3.8
  if (provider === 'google') return 4.2
  if (provider === 'openai') return 4
  if (provider === 'deepseek') return 4
  if (provider === 'openrouter') {
    if (modelKey.includes('claude')) return 3.8
    if (modelKey.includes('gemini')) return 4.2
    if (modelKey.includes('gpt') || modelKey.includes('openai')) return 4
  }
  return APPROX_CHARS_PER_TOKEN
}

export class ContextTokenEstimator {
  readonly snapshot: ContextTokenEstimatorSnapshot

  constructor(input: { modelInfo: ModelInfo; providerId?: ProviderId; charsPerToken?: number }) {
    this.snapshot = {
      providerId: input.providerId ?? 'unknown',
      model: input.modelInfo.model,
      charsPerToken:
        input.charsPerToken ?? charsPerTokenForProvider(input.providerId, input.modelInfo.model),
      method: 'provider_char_ratio',
    }
  }

  estimateChars(charCost: number): ContextTokenEstimate {
    const estimatedTokens = Math.max(0, Math.ceil(charCost / this.snapshot.charsPerToken))
    return { charCost, estimatedTokens, estimator: this.snapshot }
  }

  estimateMessages(messages: ChatMessage[]): ContextTokenEstimate {
    return this.estimateChars(charCost(messages))
  }
}

export class ContextBudgetManager {
  readonly budget: ContextBudgetSnapshot
  readonly estimator: ContextTokenEstimator

  constructor(input: ContextBudgetManagerInput) {
    const charsPerToken =
      input.approxCharsPerToken ?? charsPerTokenForProvider(input.providerId, input.modelInfo.model)
    this.estimator = new ContextTokenEstimator({
      modelInfo: input.modelInfo,
      providerId: input.providerId,
      charsPerToken,
    })
    const reservedOutputTokens = input.reservedOutputTokens ?? RESERVED_OUTPUT_TOKENS
    const contextTokens = input.modelInfo.contextLength ?? DEFAULT_CONTEXT_TOKENS
    const inputBudgetTokens = Math.max(4_000, contextTokens - reservedOutputTokens)
    const rawBudgetChars = inputBudgetTokens * charsPerToken
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
      estimator: this.estimator.snapshot,
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

function createContextRound(
  source: PersistedMessage,
  messages: ChatMessage[],
  sourceIndex: number,
  estimator: ContextTokenEstimator,
): ContextRound {
  const cost = charCost(messages)
  return {
    source,
    messages,
    charCost: cost,
    estimatedTokens: estimator.estimateChars(cost).estimatedTokens,
    sourceIndex,
  }
}

function messageToRound(
  message: PersistedMessage,
  sourceIndex: number,
  estimator: ContextTokenEstimator,
): ContextRound | null {
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
    return createContextRound(message, messages, sourceIndex, estimator)
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
  return createContextRound(message, messages, sourceIndex, estimator)
}

function preview(text: string, max = 240): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : `${compact.slice(0, max)}...`
}

function uniqueStrings(values: string[], max = MAX_COMPACT_ARTIFACT_ITEMS): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const compact = preview(value, MAX_COMPACT_ARTIFACT_TEXT_CHARS)
    if (!compact || seen.has(compact)) continue
    seen.add(compact)
    output.push(compact)
    if (output.length >= max) break
  }
  return output
}

function extractPathMentions(text: string): string[] {
  const matches = text.match(
    /(?:^|[\s"'(])([./~A-Za-z0-9_-]+\/[./A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|go|rs|java|kt|swift|yml|yaml|toml|lock|sql|sh|zsh|fish|txt))/g,
  )
  if (!matches) return []
  return matches
    .map((match) => match.trim().replace(/^["'(\s]+/, ''))
    .map((match) => match.replace(/[)"',.;:]+$/, ''))
    .filter(Boolean)
}

function mergeFileArtifacts(
  files: ConversationCompactFileArtifact[],
): ConversationCompactFileArtifact[] {
  const counts = new Map<string, number>()
  for (const file of files) counts.set(file.path, (counts.get(file.path) ?? 0) + file.mentions)
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COMPACT_ARTIFACT_ITEMS)
    .map(([path, mentions]) => ({ path, mentions }))
}

function mergeToolActivity(
  activities: ConversationCompactToolActivity[],
): ConversationCompactToolActivity[] {
  const counts = new Map<string, number>()
  for (const activity of activities) {
    counts.set(activity.name, (counts.get(activity.name) ?? 0) + activity.count)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COMPACT_ARTIFACT_ITEMS)
    .map(([name, count]) => ({ name, count }))
}

function uniqueToolResults(
  toolResults: ConversationCompactToolResultArtifact[],
): ConversationCompactToolResultArtifact[] {
  const seen = new Set<string>()
  const output: ConversationCompactToolResultArtifact[] = []
  for (const result of toolResults) {
    if (seen.has(result.toolCallId)) continue
    seen.add(result.toolCallId)
    output.push({
      ...result,
      preview: truncateChars(
        result.preview,
        MAX_COMPACT_ARTIFACT_TEXT_CHARS,
        'tool result preview',
      ),
    })
    if (output.length >= MAX_COMPACT_ARTIFACT_ITEMS) break
  }
  return output
}

function looksLikeDecision(text: string): boolean {
  return /\b(implemented|fixed|changed|decided|selected|switched|persisted|stored|added|removed|committed|amended)\b/i.test(
    text,
  )
}

function looksLikeNextStep(text: string): boolean {
  return (
    /\b(next|todo|pending|follow[- ]?up|remaining)\b/i.test(text) ||
    /下一步|待办|继续|还需要/.test(text)
  )
}

function compactArtifactFromRounds(
  activeCheckpoint: ConversationContextCheckpoint | null,
  rounds: ContextRound[],
): ConversationCompactArtifact | null {
  if (rounds.length === 0) return activeCheckpoint?.artifact ?? null

  const userRequests = [...(activeCheckpoint?.artifact?.userRequests ?? [])]
  const decisions = [...(activeCheckpoint?.artifact?.decisions ?? [])]
  const files: ConversationCompactFileArtifact[] = [...(activeCheckpoint?.artifact?.files ?? [])]
  const toolActivity: ConversationCompactToolActivity[] = [
    ...(activeCheckpoint?.artifact?.toolActivity ?? []),
  ]
  const toolResults: ConversationCompactToolResultArtifact[] = [
    ...(activeCheckpoint?.artifact?.toolResults ?? []),
  ]
  const nextSteps = [...(activeCheckpoint?.artifact?.nextSteps ?? [])]

  const userSnippets: string[] = []

  for (const round of rounds) {
    const source = round.source
    const text = textContent(source)
    if (source.role === 'user') {
      const snippet = preview(text)
      if (snippet) userSnippets.push(snippet)
      for (const file of source.blocks.filter((b): b is PersistedFileBlock => b.type === 'file')) {
        files.push({ path: file.name, mentions: 1 })
      }
    }

    if (text) {
      for (const path of extractPathMentions(text)) files.push({ path, mentions: 1 })
      const sentences = text
        .split(/\n+|(?<=[.!?。！？])\s+/)
        .map((item) => item.trim())
        .filter(Boolean)
      for (const sentence of sentences) {
        if (looksLikeDecision(sentence)) decisions.push(sentence)
        if (looksLikeNextStep(sentence)) nextSteps.push(sentence)
      }
    }

    for (const tc of toolCalls(source)) {
      toolActivity.push({ name: tc.name, count: 1 })
      if (tc.arguments) {
        for (const path of extractPathMentions(tc.arguments)) files.push({ path, mentions: 1 })
      }
      if (tc.resultRef) {
        toolResults.push({
          toolCallId: tc.id,
          toolName: tc.name,
          sizeChars: tc.resultRef.sizeChars,
          preview: tc.resultRef.preview,
          path: tc.resultRef.path,
          relativePath: tc.resultRef.relativePath,
        })
      } else if (tc.result && tc.result.length > MAX_TOOL_RESULT_CHARS) {
        toolResults.push({
          toolCallId: tc.id,
          toolName: tc.name,
          sizeChars: tc.result.length,
          preview: preview(tc.result, MAX_COMPACT_ARTIFACT_TEXT_CHARS),
        })
      }
    }
  }

  userRequests.push(...userSnippets.slice(-8))

  const next: ConversationCompactArtifact = {
    schemaVersion: 1,
    summary: [
      activeCheckpoint?.artifact?.summary ?? activeCheckpoint?.summary,
      `Omitted persisted rounds: ${(activeCheckpoint?.omittedRoundCount ?? 0) + rounds.length}.`,
    ]
      .filter(Boolean)
      .join('\n'),
    userRequests: uniqueStrings(userRequests.slice(-MAX_COMPACT_ARTIFACT_ITEMS)),
    decisions: uniqueStrings(decisions.slice(-MAX_COMPACT_ARTIFACT_ITEMS)),
    files: mergeFileArtifacts(files),
    toolActivity: mergeToolActivity(toolActivity),
    toolResults: uniqueToolResults(toolResults),
    nextSteps: uniqueStrings(nextSteps.slice(-MAX_COMPACT_ARTIFACT_ITEMS)),
  }

  return next
}

function renderCompactArtifact(artifact: ConversationCompactArtifact): string {
  const lines = [
    'Earlier conversation context was compacted to stay within the model context window.',
    artifact.summary,
  ]

  if (artifact.userRequests.length > 0) {
    lines.push('Recent omitted user requests:')
    for (const snippet of artifact.userRequests.slice(-8)) lines.push(`- ${snippet}`)
  }
  if (artifact.decisions.length > 0) {
    lines.push('Recovered decisions and implementation notes:')
    for (const decision of artifact.decisions.slice(-8)) lines.push(`- ${preview(decision)}`)
  }
  if (artifact.files.length > 0) {
    lines.push('Recovered file references:')
    for (const file of artifact.files.slice(0, 12)) {
      lines.push(`- ${file.path} (${file.mentions} mention${file.mentions === 1 ? '' : 's'})`)
    }
  }
  if (artifact.toolActivity.length > 0) {
    lines.push(
      `Omitted tool activity: ${artifact.toolActivity
        .map((activity) => `${activity.name} x${activity.count}`)
        .join(', ')}.`,
    )
  }
  if (artifact.toolResults.length > 0) {
    lines.push('Persisted tool outputs available for rehydration:')
    for (const result of artifact.toolResults.slice(0, 8)) {
      const location = result.relativePath ?? result.path ?? 'inline preview only'
      lines.push(
        `- ${result.toolName} ${result.toolCallId}: ${location} (${result.sizeChars} chars)`,
      )
      if (result.preview) lines.push(`  Preview: ${preview(result.preview)}`)
    }
  }
  if (artifact.nextSteps.length > 0) {
    lines.push('Possible next steps recovered from omitted context:')
    for (const step of artifact.nextSteps.slice(-6)) lines.push(`- ${preview(step)}`)
  }

  return truncateChars(lines.join('\n'), MAX_OMITTED_SUMMARY_CHARS, 'omitted summary')
}

function summarizeOmittedRounds(
  activeCheckpoint: ConversationContextCheckpoint | null,
  rounds: ContextRound[],
): ChatMessage | null {
  const artifact = compactArtifactFromRounds(activeCheckpoint, rounds)
  if (!artifact) return null
  const content = renderCompactArtifact(artifact)
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
  const content = checkpoint.artifact
    ? renderCompactArtifact(checkpoint.artifact)
    : checkpoint.summary
  return {
    role: 'system',
    content: [
      'Earlier conversation context checkpoint:',
      content,
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

function contextRoundsEstimatedTokens(rounds: ContextRound[]): number {
  return rounds.reduce((total, round) => total + round.estimatedTokens, 0)
}

function microcompactHistoryRounds(
  rounds: ContextRound[],
  estimator: ContextTokenEstimator,
  keepRecentToolResults = MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS,
): { rounds: ContextRound[]; plan: AgentContextMicrocompactPlan } {
  const toolResultIds = rounds.flatMap((round) =>
    round.messages
      .filter(
        (message): message is Extract<ChatMessage, { role: 'tool' }> => message.role === 'tool',
      )
      .map((message) => message.tool_call_id),
  )
  if (toolResultIds.length === 0) {
    return {
      rounds,
      plan: {
        keepRecentToolResults,
        clearedToolResultCount: 0,
        keptToolResultCount: 0,
        savedChars: 0,
        savedEstimatedTokens: 0,
      },
    }
  }

  const keepSet = new Set(toolResultIds.slice(-Math.max(1, keepRecentToolResults)))
  let clearedToolResultCount = 0
  let keptToolResultCount = 0
  let savedChars = 0
  let savedEstimatedTokens = 0

  const compacted = rounds.map((round): ContextRound => {
    let touched = false
    const messages = round.messages.map((message): ChatMessage => {
      if (message.role !== 'tool') return message
      if (keepSet.has(message.tool_call_id)) {
        keptToolResultCount += 1
        return message
      }
      if (message.content === MICROCOMPACT_CLEARED_TOOL_RESULT) return message
      clearedToolResultCount += 1
      touched = true
      return { ...message, content: MICROCOMPACT_CLEARED_TOOL_RESULT }
    })
    if (!touched) return round
    const nextCharCost = charCost(messages)
    const nextEstimatedTokens = estimator.estimateChars(nextCharCost).estimatedTokens
    savedChars += Math.max(0, round.charCost - nextCharCost)
    savedEstimatedTokens += Math.max(0, round.estimatedTokens - nextEstimatedTokens)
    return {
      ...round,
      messages,
      charCost: nextCharCost,
      estimatedTokens: nextEstimatedTokens,
    }
  })

  return {
    rounds: compacted,
    plan: {
      keepRecentToolResults,
      clearedToolResultCount,
      keptToolResultCount,
      savedChars,
      savedEstimatedTokens,
    },
  }
}

function oldestAutoCompactCandidates(rounds: ContextRound[]): ContextRound[] {
  if (rounds.length < AUTO_COMPACT_MIN_HISTORY_ROUNDS) return []
  return rounds.slice(0, Math.floor(rounds.length / 2))
}

function createRecommendedCheckpoint(
  activeCheckpoint: ConversationContextCheckpoint | null,
  rounds: ContextRound[],
): AgentContextRecommendedCheckpoint | null {
  if (rounds.length === 0) return null
  const boundary = rounds[rounds.length - 1]?.source
  if (!boundary) return null
  const artifact = compactArtifactFromRounds(activeCheckpoint, rounds)
  if (!artifact) return null
  const summary = renderCompactArtifact(artifact)
  const sourceMessageIds = [
    ...(activeCheckpoint?.sourceMessageIds ?? []),
    ...rounds.map((round) => round.source.id),
  ]
  const boundaryMessageId = boundary.id
  const sourceCharCost = contextRoundsCharCost(rounds)
  const sourceEstimatedTokens = contextRoundsEstimatedTokens(rounds)
  return {
    id: `ctx_${contextHash({ boundaryMessageId, sourceMessageIds, summary }).slice(0, 16)}`,
    boundaryMessageId,
    sourceMessageIds,
    omittedRoundCount: (activeCheckpoint?.omittedRoundCount ?? 0) + rounds.length,
    summary,
    charCost: charCost([{ role: 'system', content: summary }]),
    sourceCharCost,
    sourceEstimatedTokens,
    artifact,
  }
}

export function recommendManualContextCheckpoint(
  input: RecommendManualContextCheckpointInput,
): AgentContextRecommendedCheckpoint | null {
  const budgetManager = new ContextBudgetManager({
    modelInfo: input.modelInfo,
    providerId: input.providerId,
  })
  const estimator = budgetManager.estimator
  const allRounds = input.messages
    .map((message, index) => messageToRound(message, index, estimator))
    .filter((round): round is ContextRound => round !== null)
  const activeInput = activeCheckpointInput(input.messages, input.compactionCheckpoint)
  const activeCheckpoint = activeInput?.checkpoint ?? null
  const candidateRounds =
    activeInput === null
      ? allRounds
      : allRounds.filter((round) => round.sourceIndex > activeInput.boundaryIndex)
  const keepRecentRounds = Math.max(
    0,
    Math.floor(input.keepRecentRounds ?? MANUAL_COMPACT_KEEP_RECENT_ROUNDS),
  )
  const compactable = candidateRounds.slice(
    0,
    Math.max(0, candidateRounds.length - keepRecentRounds),
  )
  if (compactable.length === 0) return null
  const { rounds } = microcompactHistoryRounds(compactable, estimator)
  return createRecommendedCheckpoint(activeCheckpoint, rounds)
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

function section(
  kind: AgentContextSectionKind,
  messages: ChatMessage[],
  estimator: ContextTokenEstimator,
): AgentContextSection[] {
  if (messages.length === 0) return []
  const defaults = sectionDefaults(kind)
  const hash = contextHash(messages)
  const cacheKey = defaults.cachePolicy === 'no_cache' ? null : `agent-context:v1:${kind}:${hash}`
  const cost = charCost(messages)
  const estimatedTokens = estimator.estimateChars(cost).estimatedTokens
  return [
    {
      kind,
      metadata: {
        id: kind,
        ...defaults,
        hash,
        cacheKey,
        messageCount: messages.length,
        charCost: cost,
        estimatedTokens,
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
  let totalEstimatedTokens = 0
  let cacheableSections = 0
  const planSections = sections.map((contextSection): AgentContextPlanSection => {
    const messageStartIndex = cursor
    const messageEndIndex = messageStartIndex + contextSection.messages.length
    cursor = messageEndIndex
    totalCharCost += contextSection.metadata.charCost
    totalEstimatedTokens += contextSection.metadata.estimatedTokens
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
      estimatedTokens: contextSection.metadata.estimatedTokens,
    }
  })
  const ledgerEntries: AgentContextTokenLedgerEntry[] = planSections.map((planSection) => ({
    kind: planSection.kind,
    id: planSection.id,
    source: planSection.source,
    cachePolicy: planSection.cachePolicy,
    messageCount: planSection.messageCount,
    charCost: planSection.charCost,
    estimatedTokens: planSection.estimatedTokens,
  }))

  return {
    version: 1,
    sections: planSections,
    totalMessages: cursor,
    totalCharCost,
    totalEstimatedTokens,
    cacheableSections,
    ledger: {
      estimator: budget.estimator,
      entries: ledgerEntries,
      totalEstimatedTokens,
      inputBudgetTokens: budget.inputBudgetTokens,
      remainingInputTokens: budget.inputBudgetTokens - totalEstimatedTokens,
    },
    budget: {
      ...budget,
      totalCharCost,
      remainingChars: budget.budgetChars - totalCharCost,
      totalEstimatedTokens,
      remainingInputTokens: budget.inputBudgetTokens - totalEstimatedTokens,
      utilization: budget.budgetChars <= 0 ? 1 : totalCharCost / budget.budgetChars,
      tokenUtilization:
        budget.inputBudgetTokens <= 0 ? 1 : totalEstimatedTokens / budget.inputBudgetTokens,
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

export function applyAgentContextTokenPreflight(
  plan: AgentContextPlan,
  preflight: AgentContextTokenPreflight,
): AgentContextPlan {
  const normalized: AgentContextTokenPreflight = {
    ...preflight,
    inputTokens: Math.max(0, preflight.inputTokens),
    method: preflight.method.trim() || 'provider_preflight',
  }
  return {
    ...plan,
    ledger: {
      ...plan.ledger,
      preflight: normalized,
    },
    budget: {
      ...plan.budget,
      preflightInputTokens: normalized.inputTokens,
      remainingPreflightInputTokens: plan.budget.inputBudgetTokens - normalized.inputTokens,
      preflightTokenUtilization:
        plan.budget.inputBudgetTokens <= 0
          ? 1
          : normalized.inputTokens / plan.budget.inputBudgetTokens,
    },
  }
}

export function assembleAgentContext(input: AssembleAgentContextInput): AgentContextResult {
  const budgetManager = new ContextBudgetManager({
    modelInfo: input.modelInfo,
    providerId: input.providerId,
  })
  const estimator = budgetManager.estimator
  const dynamicContext = [...(input.dynamicContext ?? [])]
  const currentUser = latestUserMessage(input.messages)
  const allRounds = input.messages
    .map((message, index) => messageToRound(message, index, estimator))
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
  const uncompactedHistoryRounds =
    currentUserRound === null
      ? candidateRounds
      : candidateRounds.filter((round) => round.source.id !== currentUserRound.source.id)
  const { rounds: historyRounds, plan: microcompactPlan } = microcompactHistoryRounds(
    uncompactedHistoryRounds,
    estimator,
  )
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
  let omittedSummary = summarizeOmittedRounds(activeCheckpoint, omittedRounds)

  if (omittedSummary) {
    selectedHistory = selectRoundsWithinBudget(
      historyRounds,
      budgetManager.availableAfter(
        fixedWithoutCompactionCost + charCost([...checkpointMessages, omittedSummary]),
      ),
    )
    omittedRounds = historyRounds.slice(0, historyRounds.length - selectedHistory.length)
    omittedSummary = summarizeOmittedRounds(activeCheckpoint, omittedRounds)
  }

  const compactionMessages = [...checkpointMessages, ...(omittedSummary ? [omittedSummary] : [])]
  const selectedHistoryCharCost = contextRoundsCharCost(selectedHistory)
  const compactionCharCost = charCost(compactionMessages)
  const fixedEstimatedTokens = estimator.estimateMessages(
    fixedWithoutCompactionMessages,
  ).estimatedTokens
  const compactionEstimatedTokens = estimator.estimateMessages(compactionMessages).estimatedTokens
  const selectedHistoryEstimatedTokens = contextRoundsEstimatedTokens(selectedHistory)
  const totalEstimatedTokens =
    fixedEstimatedTokens + compactionEstimatedTokens + selectedHistoryEstimatedTokens
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
    microcompact: microcompactPlan,
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
    fixedEstimatedTokens,
    compactionEstimatedTokens,
    selectedHistoryEstimatedTokens,
    totalEstimatedTokens,
    remainingChars: budgetManager.budget.budgetChars - totalCharCost,
    remainingInputTokens: budgetManager.budget.inputBudgetTokens - totalEstimatedTokens,
    utilization: budgetManager.utilization(totalCharCost),
    tokenUtilization:
      budgetManager.budget.inputBudgetTokens <= 0
        ? 1
        : totalEstimatedTokens / budgetManager.budget.inputBudgetTokens,
    pressure,
  }
  const sections: AgentContextSection[] = [
    ...section('stable_instructions', input.stableInstructions ?? [], estimator),
    ...section('dynamic_context', dynamicContext, estimator),
    ...section('compaction_summary', compactionMessages, estimator),
    ...section(
      'selected_history',
      selectedHistory.flatMap((round) => round.messages),
      estimator,
    ),
    ...(currentUserRound
      ? section('current_user_message', currentUserRound.messages, estimator)
      : []),
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
