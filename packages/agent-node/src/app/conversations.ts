import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  activityFromRunEvent,
  appendConversationContextTurnLedgerEntry,
  appendPlanRevisionToPlan,
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
  normalizeConversationMeta,
  normalizePersistedMessage,
  normalizeRunCheckpoint,
  normalizeRunEvent,
  orderedUniqueRunEvents,
  type PersistedMessage,
  type PersistedRunEvent,
  type PlanArtifact,
  type PlanRevisionInput,
  preparePersistedMessage,
  preparePlanArtifact,
  prepareRunArtifact,
  prepareRunCheckpoint,
  prepareRunEventAppend,
  type RunArtifact,
  type RunCheckpoint,
  type RunEvent,
  type RunEventAppendResult,
  replayConversationActivity,
  type UsageInfo,
  upsertPersistedMessage,
} from '@aila/agent'
import { getNodeToolResultsConversationDir } from '../node/tool-result-store'
import { getConversationsDir, getDataDir, getPlansDir, getRunsDir } from './paths'

export {
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  AILA_RUN_EVENT_SCHEMA_VERSION,
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
  orderedUniqueRunEvents,
  type PersistedBlock,
  type PersistedFileBlock,
  type PersistedImageBlock,
  type PersistedMessage,
  type PersistedRunEvent,
  type PersistedTextBlock,
  type PersistedToolCallBlock,
  type RunEventAppendResult,
  replayConversationActivity,
  replayConversationRuntimeState,
} from '@aila/agent'

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
const runWriteChains = new Map<string, Promise<void>>()

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

function runConversationDir(conversationId: string): string {
  return join(getRunsDir(), encodeURIComponent(conversationId))
}

function runDir(conversationId: string, runId: string): string {
  return join(runConversationDir(conversationId), encodeURIComponent(runId))
}

function runCheckpointPath(conversationId: string, runId: string): string {
  return join(runDir(conversationId, runId), 'checkpoint.json')
}

function runArtifactsDir(conversationId: string, runId: string): string {
  return join(runDir(conversationId, runId), 'artifacts')
}

function runWriteKey(conversationId: string, runId: string): string {
  return `${conversationId}:${runId}`
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

async function queueEventWrite<T>(id: string, writer: () => Promise<T>): Promise<T> {
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

async function queueRunWrite<T>(
  conversationId: string,
  runId: string,
  writer: () => Promise<T>,
): Promise<T> {
  const key = runWriteKey(conversationId, runId)
  const previous = runWriteChains.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(writer)
  const guard = run.then(
    () => undefined,
    () => undefined,
  )
  runWriteChains.set(key, guard)
  guard.finally(() => {
    if (runWriteChains.get(key) === guard) runWriteChains.delete(key)
  })
  return run
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
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
): Promise<RunEventAppendResult[]> {
  const list = await listConversations()
  const recovered: RunEventAppendResult[] = []
  await Promise.all(
    list.map(async (meta) => {
      const events = await listRunEvents(meta.id)
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
      recovered.push(await appendRunEventAndTouchConversation(meta.id, recoveryEvent))
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
    ...(workspace ? { workspace: structuredClone(workspace) } : {}),
  }
  await writeMeta(meta)
  await writeFile(logPath(meta.id), '', 'utf-8')
  return meta
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

export async function appendRunEvent(id: string, event: RunEvent): Promise<PersistedRunEvent> {
  await ensureDir()
  return queueEventWrite(id, async () => {
    const existing = await listRunEvents(id)
    const prepared = prepareRunEventAppend(existing, event, randomUUID)
    if (!prepared.duplicate) {
      await appendFile(eventLogPath(id), `${JSON.stringify(prepared.event)}\n`, 'utf-8')
    }
    return prepared.event
  })
}

export async function appendRunEventAndTouchConversation(
  id: string,
  event: RunEvent,
): Promise<RunEventAppendResult> {
  const persisted = await appendRunEvent(id, event)
  const activity = activityFromRunEvent(persisted)
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

export async function listRunEvents(id: string): Promise<PersistedRunEvent[]> {
  await ensureDir()
  let raw = ''
  try {
    raw = await readFile(eventLogPath(id), 'utf-8')
  } catch {
    return []
  }

  const events: PersistedRunEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = normalizeRunEvent(JSON.parse(trimmed) as Partial<PersistedRunEvent>, id)
      if (!event) continue
      events.push(event)
    } catch {
      // skip malformed line
    }
  }
  return orderedUniqueRunEvents(events)
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

        const events: PersistedRunEvent[] = []
        for (const line of raw.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const event = normalizeRunEvent(
              JSON.parse(trimmed) as Partial<PersistedRunEvent>,
              conversationId,
            )
            if (event) events.push(event)
          } catch {
            // Keep usage stats available even if one event line is malformed.
          }
        }

        for (const event of orderedUniqueRunEvents(events)) {
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

export async function getRunCheckpoint(
  conversationId: string,
  runId: string,
): Promise<RunCheckpoint | null> {
  try {
    const raw = await readFile(runCheckpointPath(conversationId, runId), 'utf-8')
    return structuredClone(normalizeRunCheckpoint(JSON.parse(raw)))
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return null
    throw error
  }
}

export async function saveRunCheckpoint(checkpoint: RunCheckpoint): Promise<RunCheckpoint> {
  await readMeta(checkpoint.identity.conversationId)
  return queueRunWrite(checkpoint.identity.conversationId, checkpoint.identity.runId, async () => {
    const previous = await getRunCheckpoint(
      checkpoint.identity.conversationId,
      checkpoint.identity.runId,
    )
    const prepared = prepareRunCheckpoint(checkpoint, previous ?? undefined)
    const dir = runDir(prepared.identity.conversationId, prepared.identity.runId)
    await mkdir(dir, { recursive: true })
    await writeJsonAtomic(
      runCheckpointPath(prepared.identity.conversationId, prepared.identity.runId),
      prepared,
    )
    return structuredClone(prepared)
  })
}

export async function listRunCheckpoints(conversationId: string): Promise<RunCheckpoint[]> {
  const dir = runConversationDir(conversationId)
  await mkdir(dir, { recursive: true })
  const entries = await readdir(dir, { withFileTypes: true })
  const checkpoints = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        getRunCheckpoint(conversationId, decodeURIComponent(entry.name)).catch(() => null),
      ),
  )
  return checkpoints
    .filter((checkpoint): checkpoint is RunCheckpoint => checkpoint !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function saveRunArtifact(artifact: RunArtifact): Promise<RunArtifact> {
  await readMeta(artifact.conversationId)
  return queueRunWrite(artifact.conversationId, artifact.runId, async () => {
    const prepared = prepareRunArtifact(artifact)
    const dir = runArtifactsDir(prepared.conversationId, prepared.runId)
    const path = join(dir, `${encodeURIComponent(prepared.artifactId)}.json`)
    await mkdir(dir, { recursive: true })
    try {
      const existing = prepareRunArtifact(JSON.parse(await readFile(path, 'utf-8')) as RunArtifact)
      if (JSON.stringify(existing) !== JSON.stringify(prepared)) {
        throw new Error(`run artifact is immutable: ${prepared.artifactId}`)
      }
      return structuredClone(existing)
    } catch (error) {
      if (!isErrnoCode(error, 'ENOENT')) throw error
    }
    await writeJsonAtomic(path, prepared)
    return structuredClone(prepared)
  })
}

export async function listRunArtifacts(
  conversationId: string,
  runId: string,
): Promise<RunArtifact[]> {
  const dir = runArtifactsDir(conversationId, runId)
  await mkdir(dir, { recursive: true })
  const files = await readdir(dir)
  const artifacts = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => {
        try {
          return prepareRunArtifact(
            JSON.parse(await readFile(join(dir, file), 'utf-8')) as RunArtifact,
          )
        } catch {
          return null
        }
      }),
  )
  return artifacts
    .filter((artifact): artifact is RunArtifact => artifact !== null)
    .sort((left, right) => left.createdAt - right.createdAt)
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
  await Promise.all(
    [...runWriteChains]
      .filter(([key]) => key.startsWith(`${id}:`))
      .map(([, chain]) => chain.catch(() => {})),
  )
  await Promise.all([
    rm(metaPath(id), { force: true }),
    rm(logPath(id), { force: true }),
    rm(eventLogPath(id), { force: true }),
    rm(planConversationDir(id), { recursive: true, force: true }),
    rm(runConversationDir(id), { recursive: true, force: true }),
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
  for (const key of runWriteChains.keys()) {
    if (key.startsWith(`${id}:`)) runWriteChains.delete(key)
  }
}
