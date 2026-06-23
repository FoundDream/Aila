import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentEvent,
  appendPlanRevisionToPlan,
  type PlanArtifact,
  type PlanRevisionInput,
  preparePlanArtifact,
  type UsageInfo,
} from '@aila/agent'
import { getNodeToolResultsConversationDir } from '@aila/agent/node'
import {
  type AgentEventAppendResult,
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  activityFromAgentEvent,
  appendConversationContextTurnLedgerEntry,
  type ConversationContextCheckpoint,
  type ConversationContextTurnLedgerEntry,
  type ConversationMeta,
  type ConversationRecord,
  type ConversationSummary,
  type ConversationWorkspaceRef,
  conversationActivityEquals,
  createConversationUsageSnapshot,
  createInterruptedConversationRecoveryEvent,
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
  interruptedRecoveryEventFromLegacyActivity,
  normalizeAgentEvent,
  normalizeConversationMeta,
  normalizePersistedMessage,
  orderedUniqueAgentEvents,
  type PersistedAgentEvent,
  type PersistedMessage,
  prepareAgentEvent,
  preparePersistedMessage,
  replayConversationActivity,
  upsertPersistedMessage,
} from '../../packages/agent/src/conversation-core'
import { getConversationsDir, getDataDir, getPlansDir } from './paths'

export {
  type AgentEventAppendResult,
  AILA_AGENT_EVENT_SCHEMA_VERSION,
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  type ConversationActivity,
  type ConversationActivityState,
  type ConversationCompactArtifact,
  type ConversationCompactFileArtifact,
  type ConversationCompactToolActivity,
  type ConversationCompactToolResultArtifact,
  type ConversationContextCheckpoint,
  type ConversationContextState,
  type ConversationContextTurnLedgerEntry,
  type ConversationInterruptedRecoveryOptions,
  type ConversationMeta,
  type ConversationRecord,
  type ConversationRuntimePendingApproval,
  type ConversationRuntimeReplayPlan,
  type ConversationRuntimeReplayState,
  type ConversationRuntimeReplayTurn,
  type ConversationRuntimeStatePhase,
  type ConversationSummary,
  type ConversationUsage,
  createInterruptedConversationRecoveryEvent,
  orderedUniqueAgentEvents,
  type PersistedAgentEvent,
  type PersistedBlock,
  type PersistedFileBlock,
  type PersistedImageBlock,
  type PersistedMessage,
  type PersistedTextBlock,
  type PersistedToolCallBlock,
  replayConversationActivity,
  replayConversationRuntimeState,
} from '../../packages/agent/src/conversation-core'

export interface TokenUsageDay {
  date: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheMissTokens: number
  reasoningTokens: number
  modelCallCount: number
  turnCount: number
}

export interface TokenUsageStats {
  generatedAt: number
  today: TokenUsageDay
  lifetime: TokenUsageDay
  peakDay: TokenUsageDay | null
  currentStreakDays: number
  longestStreakDays: number
  days: TokenUsageDay[]
}

const metaWriteChains = new Map<string, Promise<void>>()
const messageWriteChains = new Map<string, Promise<void>>()
const eventWriteChains = new Map<string, Promise<void>>()
const planWriteChains = new Map<string, Promise<void>>()

async function ensureDir(): Promise<string> {
  const dir = getConversationsDir()
  await mkdir(dir, { recursive: true })
  return dir
}

function logPath(id: string): string {
  return join(getConversationsDir(), `${id}.jsonl`)
}

function eventLogPath(id: string): string {
  return join(getConversationsDir(), `${id}.events.jsonl`)
}

function metaPath(id: string): string {
  return join(getConversationsDir(), `${id}.meta.json`)
}

function planConversationDir(conversationId: string): string {
  return join(getPlansDir(), conversationId)
}

function planJsonPath(conversationId: string, planId: string): string {
  return join(planConversationDir(conversationId), `${planId}.json`)
}

function planMarkdownPath(conversationId: string, planId: string): string {
  return join(planConversationDir(conversationId), `${planId}.md`)
}

function planWriteKey(conversationId: string, planId: string): string {
  return `${conversationId}:${planId}`
}

async function readMeta(id: string): Promise<ConversationMeta> {
  const raw = await readFile(metaPath(id), 'utf-8')
  return normalizeConversationMeta(JSON.parse(raw) as Partial<ConversationMeta>, id)
}

async function writeMeta(meta: ConversationMeta): Promise<void> {
  await ensureDir()
  await writeFile(
    metaPath(meta.id),
    JSON.stringify(normalizeConversationMeta(meta), null, 2),
    'utf-8',
  )
}

async function updateMeta(
  id: string,
  updater: (current: ConversationMeta) => ConversationMeta,
): Promise<ConversationMeta> {
  const previous = metaWriteChains.get(id) ?? Promise.resolve()
  const run = previous
    .catch(() => {})
    .then(async () => {
      const current = await readMeta(id)
      const next = normalizeConversationMeta(updater(current), id)
      await writeMeta(next)
      return next
    })
  const guard = run.then(
    () => undefined,
    () => undefined,
  )
  metaWriteChains.set(id, guard)
  guard.finally(() => {
    if (metaWriteChains.get(id) === guard) metaWriteChains.delete(id)
  })
  return run
}

async function queueMessageWrite(id: string, writer: () => Promise<void>): Promise<void> {
  const previous = messageWriteChains.get(id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(writer)
  const guard = run.then(
    () => undefined,
    () => undefined,
  )
  messageWriteChains.set(id, guard)
  guard.finally(() => {
    if (messageWriteChains.get(id) === guard) messageWriteChains.delete(id)
  })
  return run
}

async function queueEventWrite(id: string, writer: () => Promise<void>): Promise<void> {
  const previous = eventWriteChains.get(id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(writer)
  const guard = run.then(
    () => undefined,
    () => undefined,
  )
  eventWriteChains.set(id, guard)
  guard.finally(() => {
    if (eventWriteChains.get(id) === guard) eventWriteChains.delete(id)
  })
  return run
}

async function queuePlanWrite<T>(
  conversationId: string,
  planId: string,
  writer: () => Promise<T>,
): Promise<T> {
  const key = planWriteKey(conversationId, planId)
  const previous = planWriteChains.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(writer)
  const guard = run.then(
    () => undefined,
    () => undefined,
  )
  planWriteChains.set(key, guard)
  guard.finally(() => {
    if (planWriteChains.get(key) === guard) planWriteChains.delete(key)
  })
  return run
}

function nextUpdatedAt(current: ConversationMeta, timestamp = Date.now()): number {
  return Math.max(Date.now(), timestamp, current.updatedAt + 1)
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

async function readPlan(conversationId: string, planId: string): Promise<PlanArtifact> {
  const raw = await readFile(planJsonPath(conversationId, planId), 'utf-8')
  return preparePlanArtifact(JSON.parse(raw) as PlanArtifact)
}

async function writePlan(plan: PlanArtifact): Promise<PlanArtifact> {
  const prepared = preparePlanArtifact(plan)
  await mkdir(planConversationDir(prepared.conversationId), { recursive: true })
  await Promise.all([
    writeFile(
      planJsonPath(prepared.conversationId, prepared.id),
      `${JSON.stringify(prepared, null, 2)}\n`,
      'utf-8',
    ),
    writeFile(
      planMarkdownPath(prepared.conversationId, prepared.id),
      `${prepared.markdown}\n`,
      'utf-8',
    ),
  ])
  return prepared
}

export async function listConversations(): Promise<ConversationSummary[]> {
  await ensureDir()
  const entries = await readdir(getConversationsDir())
  const records = await Promise.all(
    entries
      .filter((name) => name.endsWith('.meta.json'))
      .map(async (name) => {
        try {
          const raw = await readFile(join(getConversationsDir(), name), 'utf-8')
          return normalizeConversationMeta(JSON.parse(raw) as Partial<ConversationMeta>)
        } catch {
          return null
        }
      }),
  )
  return records
    .filter((record): record is ConversationMeta => record !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function listChatConversations(): Promise<ConversationSummary[]> {
  const list = await listConversations()
  return list.filter((meta) => !meta.docId)
}

export async function recoverInterruptedConversationActivities(
  reason = 'runtime restarted before this turn finished',
): Promise<ConversationSummary[]> {
  const results = await recoverInterruptedConversationActivityResults(reason)
  return results
    .map((result) => result.summary)
    .filter((summary): summary is ConversationSummary => summary !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function recoverInterruptedConversationActivityResults(
  reason = 'runtime restarted before this turn finished',
): Promise<AgentEventAppendResult[]> {
  const list = await listConversations()
  const recovered: AgentEventAppendResult[] = []
  await Promise.all(
    list.map(async (meta) => {
      const events = await listAgentEvents(meta.id)
      const replayedActivity = replayConversationActivity(events)
      const activity = replayedActivity ?? meta.activity
      if (!activity) return
      if (replayedActivity && !conversationActivityEquals(meta.activity, replayedActivity)) {
        await updateMeta(meta.id, (current) =>
          current.activity && current.activity.updatedAt > replayedActivity.updatedAt
            ? current
            : {
                ...current,
                updatedAt: nextUpdatedAt(current, replayedActivity.updatedAt),
                activity: replayedActivity,
              },
        )
      }
      const recoveryEvent =
        createInterruptedConversationRecoveryEvent(events, { reason, activity }) ??
        interruptedRecoveryEventFromLegacyActivity(
          meta.id,
          replayedActivity ? undefined : activity,
          reason,
        )
      if (!recoveryEvent) return
      recovered.push(await appendAgentEventAndTouchConversation(meta.id, recoveryEvent))
    }),
  )
  return recovered.sort(
    (a, b) =>
      (b.summary?.updatedAt ?? b.event.timestamp) - (a.summary?.updatedAt ?? a.event.timestamp),
  )
}

export async function getConversation(id: string): Promise<ConversationRecord> {
  const meta = await readMeta(id)
  let raw = ''
  try {
    raw = await readFile(logPath(id), 'utf-8')
  } catch {
    // log file may not exist yet for a freshly created conversation
  }
  const messages: PersistedMessage[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const message = normalizePersistedMessage(JSON.parse(trimmed) as Partial<PersistedMessage>)
      if (message) upsertPersistedMessage(messages, message)
    } catch {
      // skip malformed line -- keeps the rest of the conversation readable
    }
  }
  return { meta, messages }
}

export async function createConversation(
  docId?: string,
  workspace?: ConversationWorkspaceRef | null,
): Promise<ConversationSummary> {
  await ensureDir()
  const now = Date.now()
  const meta: ConversationMeta = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: randomUUID(),
    title: DEFAULT_CONVERSATION_TITLE,
    createdAt: now,
    updatedAt: now,
    ...(docId ? { docId } : {}),
    ...(workspace ? { workspace: structuredClone(workspace) } : {}),
  }
  await writeMeta(meta)
  await writeFile(logPath(meta.id), '', 'utf-8')
  return meta
}

// Doc-bound conversations: a doc may have N of them. Title is derived from
// the first user message (same path as chat-tab conversations); listConversations
// already sorts by updatedAt desc, so we just filter.
export async function listDocConversations(docId: string): Promise<ConversationSummary[]> {
  const list = await listConversations()
  return list.filter((meta) => meta.docId === docId)
}

export async function appendMessage(
  id: string,
  message: PersistedMessage,
): Promise<ConversationSummary> {
  await ensureDir()
  await queueMessageWrite(id, () =>
    appendFile(logPath(id), `${JSON.stringify(preparePersistedMessage(message))}\n`, 'utf-8'),
  )
  return touchMetaAfterMessage(id, message)
}

export async function upsertMessage(
  id: string,
  message: PersistedMessage,
): Promise<ConversationSummary> {
  await ensureDir()
  await queueMessageWrite(id, async () => {
    let raw = ''
    try {
      raw = await readFile(logPath(id), 'utf-8')
    } catch {
      raw = ''
    }

    const prepared = preparePersistedMessage(message)
    const preparedLine = JSON.stringify(prepared)
    const nextLines: string[] = []
    let replaced = false

    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const existing = JSON.parse(trimmed) as Partial<PersistedMessage>
        if (existing.id === prepared.id) {
          if (!replaced) {
            nextLines.push(preparedLine)
            replaced = true
          }
          continue
        }
      } catch {
        nextLines.push(line)
        continue
      }
      nextLines.push(line)
    }

    if (!replaced) nextLines.push(preparedLine)
    await writeFile(logPath(id), `${nextLines.join('\n')}\n`, 'utf-8')
  })
  return touchMetaAfterMessage(id, message)
}

function touchMetaAfterMessage(
  id: string,
  message: PersistedMessage,
): Promise<ConversationSummary> {
  return updateMeta(id, (current) => {
    const next: ConversationMeta = {
      ...current,
      updatedAt: nextUpdatedAt(current),
    }
    if (current.title === DEFAULT_CONVERSATION_TITLE) {
      const derived = deriveConversationTitle(message)
      if (derived) next.title = derived
    }
    return next
  })
}

export async function appendAgentEvent(
  id: string,
  event: AgentEvent,
): Promise<PersistedAgentEvent> {
  await ensureDir()
  const prepared = prepareAgentEvent(event)
  await queueEventWrite(id, () =>
    appendFile(eventLogPath(id), `${JSON.stringify(prepared)}\n`, 'utf-8'),
  )
  return prepared
}

export async function appendAgentEventAndTouchConversation(
  id: string,
  event: AgentEvent,
): Promise<AgentEventAppendResult> {
  const persisted = await appendAgentEvent(id, event)
  const activity = activityFromAgentEvent(persisted)
  const summary = activity
    ? await updateMeta(id, (current) =>
        current.activity && current.activity.updatedAt > activity.updatedAt
          ? current
          : {
              ...current,
              updatedAt: nextUpdatedAt(current, persisted.timestamp),
              activity,
            },
      )
    : undefined
  return { event: persisted, ...(summary ? { summary } : {}) }
}

export async function listAgentEvents(id: string): Promise<PersistedAgentEvent[]> {
  await ensureDir()
  let raw = ''
  try {
    raw = await readFile(eventLogPath(id), 'utf-8')
  } catch {
    return []
  }

  const events: PersistedAgentEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = normalizeAgentEvent(JSON.parse(trimmed) as Partial<PersistedAgentEvent>, id)
      if (!event) continue
      events.push(event)
    } catch {
      // skip malformed line
    }
  }
  return orderedUniqueAgentEvents(events)
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function localMidnight(timestamp: number): Date {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function emptyTokenUsageDay(date: string): TokenUsageDay {
  return {
    date,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    modelCallCount: 0,
    turnCount: 0,
  }
}

function finiteUsageToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
}

function addUsageToDay(day: TokenUsageDay, usage: unknown): void {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return
  const record = usage as Record<string, unknown>
  const inputTokens = finiteUsageToken(record.promptTokens)
  const outputTokens = finiteUsageToken(record.completionTokens)
  day.inputTokens += inputTokens
  day.outputTokens += outputTokens
  day.totalTokens += finiteUsageToken(record.totalTokens) || inputTokens + outputTokens
  day.cacheReadTokens += finiteUsageToken(record.cacheReadTokens)
  day.cacheWriteTokens += finiteUsageToken(record.cacheWriteTokens)
  day.cacheMissTokens += finiteUsageToken(record.cacheMissTokens)
  day.reasoningTokens += finiteUsageToken(record.reasoningTokens)
  day.modelCallCount += finiteUsageToken(record.modelCallCount)
  day.turnCount += 1
}

function addDayInto(total: TokenUsageDay, day: TokenUsageDay): void {
  total.totalTokens += day.totalTokens
  total.inputTokens += day.inputTokens
  total.outputTokens += day.outputTokens
  total.cacheReadTokens += day.cacheReadTokens
  total.cacheWriteTokens += day.cacheWriteTokens
  total.cacheMissTokens += day.cacheMissTokens
  total.reasoningTokens += day.reasoningTokens
  total.modelCallCount += day.modelCallCount
  total.turnCount += day.turnCount
}

export async function getTokenUsageStats(now = Date.now()): Promise<TokenUsageStats> {
  await ensureDir()
  const dayMap = new Map<string, TokenUsageDay>()
  const entries = await readdir(getConversationsDir())

  await Promise.all(
    entries
      .filter((name) => name.endsWith('.events.jsonl'))
      .map(async (name) => {
        const conversationId = name.slice(0, -'.events.jsonl'.length)
        let raw = ''
        try {
          raw = await readFile(join(getConversationsDir(), name), 'utf-8')
        } catch {
          return
        }

        const events: PersistedAgentEvent[] = []
        for (const line of raw.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const event = normalizeAgentEvent(
              JSON.parse(trimmed) as Partial<PersistedAgentEvent>,
              conversationId,
            )
            if (event) events.push(event)
          } catch {
            // Keep usage stats available even if one event line is malformed.
          }
        }

        for (const event of orderedUniqueAgentEvents(events)) {
          if (event.type !== 'turn.completed') continue
          const data = event.data
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue
          const usage = (data as { usage?: unknown }).usage
          const key = localDateKey(event.timestamp)
          const day = dayMap.get(key) ?? emptyTokenUsageDay(key)
          addUsageToDay(day, usage)
          dayMap.set(key, day)
        }
      }),
  )

  const todayKey = localDateKey(now)
  const todayStart = localMidnight(now)
  const days: TokenUsageDay[] = []
  for (let offset = 364; offset >= 0; offset -= 1) {
    const key = localDateKey(addLocalDays(todayStart, -offset).getTime())
    days.push(dayMap.get(key) ?? emptyTokenUsageDay(key))
  }

  const lifetime = emptyTokenUsageDay('all')
  const sortedAllDays = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  for (const day of sortedAllDays) addDayInto(lifetime, day)

  let peakDay: TokenUsageDay | null = null
  for (const day of sortedAllDays) {
    if (day.totalTokens > 0 && (!peakDay || day.totalTokens > peakDay.totalTokens)) {
      peakDay = day
    }
  }

  let longestStreakDays = 0
  let streak = 0
  if (sortedAllDays.length > 0) {
    const [year, month, dayOfMonth] = sortedAllDays[0].date.split('-').map(Number)
    const cursor = new Date(year, (month ?? 1) - 1, dayOfMonth ?? 1)
    while (cursor.getTime() <= todayStart.getTime()) {
      const key = localDateKey(cursor.getTime())
      if ((dayMap.get(key)?.totalTokens ?? 0) > 0) {
        streak += 1
        longestStreakDays = Math.max(longestStreakDays, streak)
      } else {
        streak = 0
      }
      cursor.setDate(cursor.getDate() + 1)
    }
  }

  let currentStreakDays = 0
  for (let offset = 0; ; offset += 1) {
    const key = localDateKey(addLocalDays(todayStart, -offset).getTime())
    const day = dayMap.get(key)
    if (!day || day.totalTokens <= 0) break
    currentStreakDays += 1
  }

  return {
    generatedAt: now,
    today: dayMap.get(todayKey) ?? emptyTokenUsageDay(todayKey),
    lifetime,
    peakDay,
    currentStreakDays,
    longestStreakDays,
    days,
  }
}

export async function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  return updateMeta(id, (current) => ({
    ...current,
    title: title.trim() || DEFAULT_CONVERSATION_TITLE,
    updatedAt: nextUpdatedAt(current),
  }))
}

export async function setConversationUsage(
  id: string,
  usage: UsageInfo,
): Promise<ConversationSummary> {
  const timestamp = Date.now()
  return updateMeta(id, (current) => ({
    ...current,
    updatedAt: nextUpdatedAt(current, timestamp),
    usage: createConversationUsageSnapshot(current.usage, usage, timestamp),
  }))
}

export async function setConversationContextCheckpoint(
  id: string,
  checkpoint: ConversationContextCheckpoint,
): Promise<ConversationSummary> {
  return updateMeta(id, (current) => ({
    ...current,
    updatedAt: nextUpdatedAt(current, checkpoint.createdAt),
    context: {
      ...(current.context ?? {}),
      checkpoint: structuredClone(checkpoint),
    },
  }))
}

export async function recordConversationContextTurnLedger(
  id: string,
  entry: ConversationContextTurnLedgerEntry,
): Promise<ConversationSummary> {
  return updateMeta(id, (current) => ({
    ...current,
    updatedAt: nextUpdatedAt(current, entry.createdAt),
    context: appendConversationContextTurnLedgerEntry(current.context, entry),
  }))
}

export async function createPlan(plan: PlanArtifact): Promise<PlanArtifact> {
  await readMeta(plan.conversationId)
  const prepared = preparePlanArtifact(plan)
  return queuePlanWrite(prepared.conversationId, prepared.id, async () => {
    try {
      await readPlan(prepared.conversationId, prepared.id)
      throw new Error(`plan already exists: ${prepared.conversationId}/${prepared.id}`)
    } catch (error) {
      if (!isErrnoCode(error, 'ENOENT')) throw error
    }
    return structuredClone(await writePlan(prepared))
  })
}

export async function getPlan(conversationId: string, planId: string): Promise<PlanArtifact> {
  return structuredClone(await readPlan(conversationId, planId))
}

export async function listPlans(conversationId: string): Promise<PlanArtifact[]> {
  await mkdir(planConversationDir(conversationId), { recursive: true })
  const entries = await readdir(planConversationDir(conversationId))
  const plans = await Promise.all(
    entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => readPlan(conversationId, name.slice(0, -'.json'.length)).catch(() => null)),
  )
  return plans
    .filter((plan): plan is PlanArtifact => plan !== null)
    .map((plan) => structuredClone(plan))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function updatePlan(plan: PlanArtifact): Promise<PlanArtifact> {
  await readMeta(plan.conversationId)
  const prepared = preparePlanArtifact(plan)
  return queuePlanWrite(prepared.conversationId, prepared.id, async () => {
    await readPlan(prepared.conversationId, prepared.id)
    return structuredClone(await writePlan(prepared))
  })
}

export async function appendPlanRevision(input: PlanRevisionInput): Promise<PlanArtifact> {
  await readMeta(input.conversationId)
  return queuePlanWrite(input.conversationId, input.planId, async () => {
    const current = await readPlan(input.conversationId, input.planId)
    const updated = appendPlanRevisionToPlan(current, input.revision, Date.now())
    return structuredClone(await writePlan(updated))
  })
}

export async function deleteConversation(id: string): Promise<void> {
  await metaWriteChains.get(id)?.catch(() => {})
  await messageWriteChains.get(id)?.catch(() => {})
  await eventWriteChains.get(id)?.catch(() => {})
  await Promise.all(
    [...planWriteChains]
      .filter(([key]) => key.startsWith(`${id}:`))
      .map(([, chain]) => chain.catch(() => {})),
  )
  await Promise.all([
    rm(metaPath(id), { force: true }),
    rm(logPath(id), { force: true }),
    rm(eventLogPath(id), { force: true }),
    rm(planConversationDir(id), { recursive: true, force: true }),
    rm(getNodeToolResultsConversationDir(id, { dataDir: getDataDir() }), {
      recursive: true,
      force: true,
    }),
  ])
  metaWriteChains.delete(id)
  messageWriteChains.delete(id)
  eventWriteChains.delete(id)
  for (const key of planWriteChains.keys()) {
    if (key.startsWith(`${id}:`)) planWriteChains.delete(key)
  }
}

export interface DocRefRewrite {
  oldPath: string
  newPath: string
  // True for folder renames/moves: matches docIds equal to oldPath or starting
  // with `${oldPath}/`. False (or omitted) for doc renames: only exact match.
  isFolder?: boolean
}

// Cascade-rewrite meta.docId across every doc-bound conversation after a doc
// or folder is renamed/moved. Mirrors Obsidian's "rename + scan vault and
// rewrite wikilinks" behaviour. Caller (docs.ts) invokes after fs.rename has
// already committed; failure here leaves the file rename in place and the
// affected conversations show broken doc-bindings.
export async function rewriteDocRefs(rewrites: DocRefRewrite[]): Promise<ConversationSummary[]> {
  if (rewrites.length === 0) return []
  await ensureDir()
  const dir = getConversationsDir()
  const entries = await readdir(dir)
  const updated: ConversationSummary[] = []
  const rewriteDocId = (docId: string): string | null => {
    for (const r of rewrites) {
      if (r.isFolder) {
        if (docId === r.oldPath || docId.startsWith(`${r.oldPath}/`)) {
          return `${r.newPath}${docId.slice(r.oldPath.length)}`
        }
      } else if (docId === r.oldPath) {
        return r.newPath
      }
    }
    return null
  }
  await Promise.all(
    entries
      .filter((name) => name.endsWith('.meta.json'))
      .map(async (name) => {
        const path = join(dir, name)
        let raw: string
        try {
          raw = await readFile(path, 'utf-8')
        } catch {
          return
        }
        let meta: ConversationMeta
        try {
          meta = normalizeConversationMeta(JSON.parse(raw) as Partial<ConversationMeta>)
        } catch {
          return
        }
        const docId = meta.docId
        if (!docId) return
        if (rewriteDocId(docId) === null) return
        const next = await updateMeta(meta.id, (current) => {
          const currentDocId = current.docId
          if (!currentDocId) return current
          const nextDocId = rewriteDocId(currentDocId)
          return nextDocId === null ? current : { ...current, docId: nextDocId }
        })
        if (next.docId !== docId) updated.push(next)
      }),
  )
  return updated
}
