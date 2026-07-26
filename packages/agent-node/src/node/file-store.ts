import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentRunArtifact,
  AgentRunCheckpoint,
  AgentRuntimeStore,
} from '@aila/agent'
import {
  type AgentEventAppendResult,
  AILA_AGENT_EVENT_SCHEMA_VERSION,
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  appendConversationContextTurnLedgerEntry,
  appendPlanRevisionToPlan,
  type ConversationRecord,
  type ConversationSummary,
  type ConversationWorkspaceRef,
  createConversationUsageSnapshot,
  createInterruptedConversationRecoveryEvent,
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
  normalizeConversationMeta,
  orderedUniqueAgentEvents,
  type PersistedAgentEvent,
  type PersistedMessage,
  type PlanArtifact,
  prepareAgentEventAppend,
  prepareAgentRunArtifact,
  prepareAgentRunCheckpoint,
  preparePersistedMessage,
  preparePlanArtifact,
  replayConversationActivity,
  upsertPersistedMessage,
} from '@aila/agent'
import { getNodeToolResultsConversationDir } from './tool-result-store'

export interface FileRuntimeStoreOptions {
  dataDir: string
  toolResultDir?: string
  createId?: () => string
  createEventId?: () => string
  now?: () => number
}

export function createFileRuntimeStore(options: FileRuntimeStoreOptions): AgentRuntimeStore {
  const conversationsDir = join(options.dataDir, 'conversations')
  const eventsDir = join(options.dataDir, 'events')
  const plansDir = join(options.dataDir, 'plans')
  const runsDir = join(options.dataDir, 'runs')
  const createId = options.createId ?? randomUUID
  const createEventId = options.createEventId ?? randomUUID
  const now = options.now ?? Date.now
  const runWriteChains = new Map<string, Promise<void>>()

  async function readRecord(conversationId: string): Promise<ConversationRecord> {
    const path = join(conversationsDir, `${conversationId}.json`)
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as ConversationRecord
    return {
      meta: normalizeConversationMeta(parsed.meta, conversationId),
      messages: (parsed.messages ?? [])
        .map((message) => preparePersistedMessage(message as PersistedMessage))
        .filter(Boolean),
    }
  }

  async function writeRecord(record: ConversationRecord): Promise<void> {
    await mkdir(conversationsDir, { recursive: true })
    await writeFile(
      join(conversationsDir, `${record.meta.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf-8',
    )
  }

  async function readEvents(conversationId: string): Promise<PersistedAgentEvent[]> {
    try {
      const raw = await readFile(join(eventsDir, `${conversationId}.json`), 'utf-8')
      const parsed = JSON.parse(raw) as PersistedAgentEvent[]
      return orderedUniqueAgentEvents(
        parsed.map((event) => ({
          ...event,
          schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
        })),
      )
    } catch {
      return []
    }
  }

  async function writeEvents(conversationId: string, events: PersistedAgentEvent[]): Promise<void> {
    await mkdir(eventsDir, { recursive: true })
    await writeFile(
      join(eventsDir, `${conversationId}.json`),
      `${JSON.stringify(orderedUniqueAgentEvents(events), null, 2)}\n`,
      'utf-8',
    )
  }

  function planConversationDir(conversationId: string): string {
    return join(plansDir, conversationId)
  }

  function runConversationDir(conversationId: string): string {
    return join(runsDir, encodeURIComponent(conversationId))
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

  async function queueRunWrite<T>(
    conversationId: string,
    runId: string,
    writer: () => Promise<T>,
  ): Promise<T> {
    const key = `${conversationId}\0${runId}`
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

  async function readRunCheckpoint(
    conversationId: string,
    runId: string,
  ): Promise<AgentRunCheckpoint | null> {
    try {
      const raw = await readFile(runCheckpointPath(conversationId, runId), 'utf-8')
      return JSON.parse(raw) as AgentRunCheckpoint
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return null
      throw error
    }
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

  function planJsonPath(conversationId: string, planId: string): string {
    return join(planConversationDir(conversationId), `${planId}.json`)
  }

  function planMarkdownPath(conversationId: string, planId: string): string {
    return join(planConversationDir(conversationId), `${planId}.md`)
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

  async function updateRecord(
    conversationId: string,
    update: (record: ConversationRecord) => ConversationRecord,
  ): Promise<ConversationRecord> {
    const record = update(await readRecord(conversationId))
    await writeRecord(record)
    return record
  }

  async function recordAgentEvent(
    conversationId: string,
    event: AgentEvent,
  ): Promise<AgentEventAppendResult> {
    const record = await readRecord(conversationId)
    const events = await readEvents(conversationId)
    const previousActivity = replayConversationActivity(events)
    const prepared = prepareAgentEventAppend(events, event, createEventId)
    const persisted = prepared.event
    if (!prepared.duplicate) {
      events.push(persisted)
      await writeEvents(conversationId, events)
    }

    const activity = replayConversationActivity(events)
    if (!activity || sameConversationActivity(previousActivity, activity)) {
      return { event: persisted }
    }
    if (record.meta.activity && record.meta.activity.updatedAt > activity.updatedAt) {
      return { event: persisted }
    }

    const updated = {
      ...record,
      meta: {
        ...record.meta,
        updatedAt: nextUpdatedAt(record.meta.updatedAt, persisted.timestamp),
        activity,
      },
    }
    await writeRecord(updated)
    return { event: persisted, summary: updated.meta }
  }

  return {
    async createConversation(
      docId?: string,
      workspace?: ConversationWorkspaceRef | null,
    ): Promise<ConversationSummary> {
      const createdAt = now()
      const meta: ConversationSummary = {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id: createId(),
        title: DEFAULT_CONVERSATION_TITLE,
        createdAt,
        updatedAt: createdAt,
        ...(docId ? { docId } : {}),
        ...(workspace ? { workspace: structuredClone(workspace) } : {}),
      }
      await writeRecord({ meta, messages: [] })
      await writeEvents(meta.id, [])
      return structuredClone(meta)
    },
    async getConversation(conversationId): Promise<ConversationRecord> {
      return structuredClone(await readRecord(conversationId))
    },
    async saveMessage(conversationId, message): Promise<ConversationSummary> {
      const record = await updateRecord(conversationId, (current) => {
        const messages = [...current.messages]
        const prepared = preparePersistedMessage(message)
        upsertPersistedMessage(messages, prepared)
        const title =
          current.meta.title === DEFAULT_CONVERSATION_TITLE
            ? (deriveConversationTitle(prepared) ?? current.meta.title)
            : current.meta.title
        return {
          meta: {
            ...current.meta,
            title,
            updatedAt: nextUpdatedAt(current.meta.updatedAt, now()),
          },
          messages,
        }
      })
      return structuredClone(record.meta)
    },
    recordAgentEvent,
    async listConversations(): Promise<readonly ConversationSummary[]> {
      await mkdir(conversationsDir, { recursive: true })
      const files = await readdir(conversationsDir)
      const records = await Promise.all(
        files
          .filter((file) => file.endsWith('.json'))
          .map((file) => readRecord(file.slice(0, -'.json'.length)).catch(() => null)),
      )
      return records
        .filter((record): record is ConversationRecord => record !== null)
        .map((record) => structuredClone(record.meta))
        .sort((left, right) => right.updatedAt - left.updatedAt)
    },
    async listAgentEvents(conversationId): Promise<readonly PersistedAgentEvent[]> {
      return structuredClone(await readEvents(conversationId))
    },
    async recoverInterruptedActivities(reason): Promise<readonly AgentEventAppendResult[]> {
      const summaries = (await this.listConversations?.()) ?? []
      const recovered: AgentEventAppendResult[] = []
      for (const summary of summaries) {
        const events = await readEvents(summary.id)
        const activity = replayConversationActivity(events)
        const recoveryEvent = createInterruptedConversationRecoveryEvent(events, {
          reason,
          activity,
        })
        if (!recoveryEvent) continue
        recovered.push(await recordAgentEvent(summary.id, recoveryEvent))
      }
      return recovered
    },
    async renameConversation(conversationId, title): Promise<ConversationSummary> {
      const record = await updateRecord(conversationId, (current) => ({
        ...current,
        meta: {
          ...current.meta,
          title: title.trim() || DEFAULT_CONVERSATION_TITLE,
          updatedAt: nextUpdatedAt(current.meta.updatedAt, now()),
        },
      }))
      return structuredClone(record.meta)
    },
    async recordUsage(conversationId, usage): Promise<ConversationSummary> {
      const timestamp = now()
      const record = await updateRecord(conversationId, (current) => ({
        ...current,
        meta: {
          ...current.meta,
          updatedAt: nextUpdatedAt(current.meta.updatedAt, timestamp),
          usage: createConversationUsageSnapshot(current.meta.usage, usage, timestamp),
        },
      }))
      return structuredClone(record.meta)
    },
    async saveContextCheckpoint(conversationId, checkpoint): Promise<ConversationSummary> {
      const record = await updateRecord(conversationId, (current) => ({
        ...current,
        meta: {
          ...current.meta,
          updatedAt: nextUpdatedAt(current.meta.updatedAt, checkpoint.createdAt),
          context: {
            ...(current.meta.context ?? {}),
            checkpoint: structuredClone(checkpoint),
          },
        },
      }))
      return structuredClone(record.meta)
    },
    async recordContextTurnLedger(conversationId, entry): Promise<ConversationSummary> {
      const record = await updateRecord(conversationId, (current) => ({
        ...current,
        meta: {
          ...current.meta,
          updatedAt: nextUpdatedAt(current.meta.updatedAt, entry.createdAt),
          context: appendConversationContextTurnLedgerEntry(current.meta.context, entry),
        },
      }))
      return structuredClone(record.meta)
    },
    async saveRunCheckpoint(checkpoint): Promise<AgentRunCheckpoint> {
      return queueRunWrite(
        checkpoint.identity.conversationId,
        checkpoint.identity.runId,
        async () => {
          await readRecord(checkpoint.identity.conversationId)
          const previous = await readRunCheckpoint(
            checkpoint.identity.conversationId,
            checkpoint.identity.runId,
          )
          const prepared = prepareAgentRunCheckpoint(checkpoint, previous ?? undefined)
          const dir = runDir(prepared.identity.conversationId, prepared.identity.runId)
          await mkdir(dir, { recursive: true })
          await writeJsonAtomic(
            runCheckpointPath(prepared.identity.conversationId, prepared.identity.runId),
            prepared,
          )
          return structuredClone(prepared)
        },
      )
    },
    async getRunCheckpoint(conversationId, runId): Promise<AgentRunCheckpoint | null> {
      const checkpoint = await readRunCheckpoint(conversationId, runId)
      return checkpoint ? structuredClone(checkpoint) : null
    },
    async listRunCheckpoints(conversationId): Promise<readonly AgentRunCheckpoint[]> {
      const dir = runConversationDir(conversationId)
      await mkdir(dir, { recursive: true })
      const entries = await readdir(dir, { withFileTypes: true })
      const checkpoints = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) =>
            readRunCheckpoint(conversationId, decodeURIComponent(entry.name)).catch(() => null),
          ),
      )
      return checkpoints
        .filter((checkpoint): checkpoint is AgentRunCheckpoint => checkpoint !== null)
        .map((checkpoint) => structuredClone(checkpoint))
        .sort((left, right) => right.updatedAt - left.updatedAt)
    },
    async saveRunArtifact(artifact): Promise<AgentRunArtifact> {
      return queueRunWrite(artifact.conversationId, artifact.runId, async () => {
        await readRecord(artifact.conversationId)
        const prepared = prepareAgentRunArtifact(artifact)
        const dir = runArtifactsDir(prepared.conversationId, prepared.runId)
        const path = join(dir, `${encodeURIComponent(prepared.artifactId)}.json`)
        await mkdir(dir, { recursive: true })
        try {
          const existing = prepareAgentRunArtifact(
            JSON.parse(await readFile(path, 'utf-8')) as AgentRunArtifact,
          )
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
    },
    async listRunArtifacts(conversationId, runId): Promise<readonly AgentRunArtifact[]> {
      const dir = runArtifactsDir(conversationId, runId)
      await mkdir(dir, { recursive: true })
      const files = await readdir(dir)
      const artifacts = await Promise.all(
        files
          .filter((file) => file.endsWith('.json'))
          .map(async (file) => {
            try {
              return prepareAgentRunArtifact(
                JSON.parse(await readFile(join(dir, file), 'utf-8')) as AgentRunArtifact,
              )
            } catch {
              return null
            }
          }),
      )
      return artifacts
        .filter((artifact): artifact is AgentRunArtifact => artifact !== null)
        .map((artifact) => structuredClone(artifact))
        .sort((left, right) => left.createdAt - right.createdAt)
    },
    async createPlan(plan): Promise<PlanArtifact> {
      await readRecord(plan.conversationId)
      const prepared = preparePlanArtifact(plan)
      try {
        await readPlan(prepared.conversationId, prepared.id)
        throw new Error(`plan already exists: ${prepared.conversationId}/${prepared.id}`)
      } catch (error) {
        if (!isErrnoCode(error, 'ENOENT')) throw error
      }
      return structuredClone(await writePlan(prepared))
    },
    async getPlan(conversationId, planId): Promise<PlanArtifact> {
      return structuredClone(await readPlan(conversationId, planId))
    },
    async listPlans(conversationId): Promise<readonly PlanArtifact[]> {
      await mkdir(planConversationDir(conversationId), { recursive: true })
      const files = await readdir(planConversationDir(conversationId))
      const plans = await Promise.all(
        files
          .filter((file) => file.endsWith('.json'))
          .map((file) =>
            readPlan(conversationId, file.slice(0, -'.json'.length)).catch(() => null),
          ),
      )
      return plans
        .filter((plan): plan is PlanArtifact => plan !== null)
        .map((plan) => structuredClone(plan))
        .sort((left, right) => right.updatedAt - left.updatedAt)
    },
    async updatePlan(plan): Promise<PlanArtifact> {
      await readRecord(plan.conversationId)
      const prepared = preparePlanArtifact(plan)
      await readPlan(prepared.conversationId, prepared.id)
      return structuredClone(await writePlan(prepared))
    },
    async appendPlanRevision(input): Promise<PlanArtifact> {
      await readRecord(input.conversationId)
      const current = await readPlan(input.conversationId, input.planId)
      const updated = appendPlanRevisionToPlan(current, input.revision, now())
      return structuredClone(await writePlan(updated))
    },
    async deleteConversation(conversationId): Promise<void> {
      const runWritePrefix = `${conversationId}\0`
      await Promise.all(
        [...runWriteChains]
          .filter(([key]) => key.startsWith(runWritePrefix))
          .map(([, chain]) => chain.catch(() => {})),
      )
      await Promise.all([
        rm(join(conversationsDir, `${conversationId}.json`), { force: true }),
        rm(join(eventsDir, `${conversationId}.json`), { force: true }),
        rm(planConversationDir(conversationId), { recursive: true, force: true }),
        rm(runConversationDir(conversationId), { recursive: true, force: true }),
        rm(getNodeToolResultsConversationDir(conversationId, options), {
          recursive: true,
          force: true,
        }),
      ])
      for (const key of runWriteChains.keys()) {
        if (key.startsWith(runWritePrefix)) runWriteChains.delete(key)
      }
    },
  }
}

function nextUpdatedAt(current: number, candidate: number): number {
  return candidate > current ? candidate : current + 1
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

function sameConversationActivity(
  left: ConversationSummary['activity'],
  right: ConversationSummary['activity'],
): boolean {
  return (
    left?.state === right?.state &&
    left?.title === right?.title &&
    left?.updatedAt === right?.updatedAt &&
    left?.eventType === right?.eventType &&
    left?.messageId === right?.messageId &&
    left?.detail === right?.detail &&
    left?.toolName === right?.toolName
  )
}
