import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent } from '../agent-protocol'
import {
  type AgentEventAppendResult,
  AILA_AGENT_EVENT_SCHEMA_VERSION,
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  type ConversationRecord,
  type ConversationSummary,
  type ConversationWorkspaceRef,
  createInterruptedConversationRecoveryEvent,
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
  normalizeConversationMeta,
  orderedUniqueAgentEvents,
  type PersistedAgentEvent,
  type PersistedMessage,
  prepareAgentEvent,
  preparePersistedMessage,
  replayConversationActivity,
  upsertPersistedMessage,
} from '../conversation-core'
import type { AgentRuntimeStore } from '../runtime'

export interface FileRuntimeStoreOptions {
  dataDir: string
  createId?: () => string
  now?: () => number
}

export function createFileRuntimeStore(options: FileRuntimeStoreOptions): AgentRuntimeStore {
  const conversationsDir = join(options.dataDir, 'conversations')
  const eventsDir = join(options.dataDir, 'events')
  const createId = options.createId ?? randomUUID
  const now = options.now ?? Date.now

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
    const persisted = prepareAgentEvent(event)
    events.push(persisted)
    await writeEvents(conversationId, events)

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
          usage: { ...usage, updatedAt: timestamp },
        },
      }))
      return structuredClone(record.meta)
    },
    async deleteConversation(conversationId): Promise<void> {
      await Promise.all([
        rm(join(conversationsDir, `${conversationId}.json`), { force: true }),
        rm(join(eventsDir, `${conversationId}.json`), { force: true }),
      ])
    },
  }
}

function nextUpdatedAt(current: number, candidate: number): number {
  return candidate > current ? candidate : current + 1
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
