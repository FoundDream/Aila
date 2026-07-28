import {
  type ConversationSummary,
  createInterruptedConversationRecoveryEvent,
  type PersistedRunEvent,
  replayConversationActivity,
} from '../conversation-core'
import { projectConversation, sessionRunEvents } from '../session-journal'
import { createWorkbenchEvent } from '../workbench-events'
import type {
  RuntimeCreateConversationInput,
  RuntimeResolveConversationInput,
  RuntimeResolveConversationResult,
} from './api-types'
import {
  cloneRuntimeConversationSummaries,
  cloneRuntimeConversationSummary,
  cloneRuntimePersistedRunEvents,
  cloneRuntimeRunEventAppendResults,
  cloneRuntimeValue,
  sortRuntimeConversationSummaries,
} from './clone'
import type { WorkbenchServices } from './services'

export class ConversationCatalog {
  constructor(private readonly services: WorkbenchServices) {}

  async createConversation(
    input: RuntimeCreateConversationInput = {},
  ): Promise<ConversationSummary> {
    const { store } = this.services
    if (!store.createConversation) throw new Error('runtime store cannot create conversations')
    const summary = cloneRuntimeConversationSummary(
      await store.createConversation(input.workspace ?? undefined),
    )
    this.services.emit(createWorkbenchEvent('conversations:updated', summary))
    return summary
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const { store } = this.services
    if (!store.listConversations) throw new Error('runtime store cannot list conversations')
    return sortRuntimeConversationSummaries(
      cloneRuntimeConversationSummaries(await store.listConversations()),
    )
  }

  async resolveConversation(
    input: RuntimeResolveConversationInput = {},
  ): Promise<RuntimeResolveConversationResult> {
    if (input.conversationId && input.resumeLatest) {
      throw new Error('conversationId and resumeLatest cannot be combined')
    }
    if (input.resumeLatest) {
      const [summary] = await this.listConversations()
      if (!summary) throw new Error('no conversations found to resume')
      return { conversationId: summary.id, isExisting: true, summary }
    }
    if (input.conversationId) {
      const record = projectConversation(
        await this.services.store.listSessionEntries(input.conversationId),
        {
          entryTransforms: this.services.host.sessionEntryTransforms,
          customEntryProjectors: this.services.host.sessionCustomEntryProjectors,
        },
      )
      return {
        conversationId: input.conversationId,
        isExisting: true,
        summary: cloneRuntimeConversationSummary(record.meta),
      }
    }
    const summary = await this.createConversation()
    return { conversationId: summary.id, isExisting: false, summary }
  }

  async recoverInterruptedActivities(
    reason = 'runtime restarted before this turn finished',
  ): Promise<ConversationSummary[]> {
    const { store } = this.services
    if (store.recoverInterruptedActivities) {
      const recoveredResults = cloneRuntimeRunEventAppendResults(
        await store.recoverInterruptedActivities(reason),
      )
      const recovered: ConversationSummary[] = []
      for (const result of recoveredResults) {
        this.services.emit(createWorkbenchEvent('run:event', result.event))
        if (!result.summary) continue
        this.services.emit(createWorkbenchEvent('conversations:updated', result.summary))
        recovered.push(result.summary)
      }
      await this.resetInterruptedSessionPhases()
      return [...recovered].sort((a, b) => b.updatedAt - a.updatedAt)
    }

    if (!store.listConversations) return []
    const conversations = cloneRuntimeConversationSummaries(await store.listConversations())
    const recovered: ConversationSummary[] = []
    await Promise.all(
      conversations.map(async (summary) => {
        const events = cloneRuntimePersistedRunEvents(
          sessionRunEvents(await store.listSessionEntries(summary.id)),
        )
        const recoveryEvent = createInterruptedConversationRecoveryEvent(events, {
          reason,
          activity: replayConversationActivity(events) ?? summary.activity,
        })
        if (!recoveryEvent) return
        const appended = await store.appendSessionEntry(summary.id, {
          type: 'run.event',
          timestamp: recoveryEvent.timestamp,
          entryId: recoveryEvent.eventId,
          turnId: recoveryEvent.turnId,
          runId: recoveryEvent.runId,
          stepId: recoveryEvent.stepId,
          data: { event: cloneRuntimeValue(recoveryEvent) },
        })
        if (appended.entry.type !== 'run.event') return
        const event = cloneRuntimeValue(appended.entry.data.event) as PersistedRunEvent
        const nextSummary = cloneRuntimeConversationSummary(appended.summary)
        this.services.emit(createWorkbenchEvent('run:event', event))
        this.services.emit(createWorkbenchEvent('conversations:updated', nextSummary))
        recovered.push(nextSummary)
      }),
    )
    await this.resetInterruptedSessionPhases()
    return recovered.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private async resetInterruptedSessionPhases(): Promise<void> {
    const { store } = this.services
    if (!store.listConversations) return
    const conversations = await store.listConversations()
    await Promise.all(
      conversations.map(async (summary) => {
        const tree = await store.getSessionTree(summary.id)
        if (tree.phase === 'idle') return
        await store.appendSessionEntry(summary.id, {
          type: 'session.phase.changed',
          timestamp: this.services.now(),
          data: { phase: 'idle' },
        })
      }),
    )
  }
}
