import type {
  ConversationRecord,
  ConversationRuntimeReplayState,
  ConversationSummary,
  PersistedMessage,
  PersistedRunEvent,
} from '../conversation-core'
import type { RunPayload, RunSnapshot } from '../run-persistence'
import type { BlobGarbageCollectionResult, SessionTree } from '../session-journal'
import type { LoadedSkill } from '../skills'
import type { ToolRegistry } from '../tools'
import type { SessionInputQueueMode, SessionInputQueueState } from '../workbench-events'
import type {
  ActiveAssistantTurn,
  ConversationAbortReason,
  ConversationRuntimeHydration,
  ConversationRuntimeStateSnapshot,
  RuntimeAppendSessionCustomInput,
  RuntimeAppendSessionCustomMessageInput,
  RuntimeAppendUserMessageInput,
  RuntimeCompactConversationInput,
  RuntimeCompactConversationResult,
  RuntimeCreateConversationInput,
  RuntimeExecuteToolInput,
  RuntimeForkRunInput,
  RuntimeForkSessionInput,
  RuntimeNavigateSessionInput,
  RuntimeQueueControlInput,
  RuntimeRecordRunEventInput,
  RuntimeResolveConversationInput,
  RuntimeResolveConversationResult,
  RuntimeResumeRunInput,
  RuntimeRetryLastInput,
  RuntimeRunControlInput,
  RuntimeRunInspection,
  RuntimeRunPayloadInput,
  RuntimeRunSummary,
  RuntimeSendInput,
  RuntimeSendResult,
  RuntimeToolPackLoadInput,
} from './api-types'
import { ConversationCatalog } from './catalog'
import { WorkbenchServices } from './services'
import {
  type InternalSessionRuntimeOptions,
  SessionRuntime,
  SHARED_WORKBENCH_SERVICES,
  sessionRuntimeDeletedHandlers,
  sessionRuntimeEngines,
} from './session-runtime'
import type { Workbench, WorkbenchOptions } from './workbench-host'

/**
 * Multi-session process facade. Durable conversation execution is delegated to
 * one SessionRuntime instance per conversation.
 */
export class WorkbenchRuntime implements Workbench {
  private readonly services: WorkbenchServices
  private readonly catalog: ConversationCatalog
  private readonly sessions = new Map<string, SessionRuntime>()
  private shutdownStarted = false
  private shutdownPromise: Promise<void> | null = null

  constructor(options: WorkbenchOptions = {}) {
    this.services = new WorkbenchServices(options)
    this.catalog = new ConversationCatalog(this.services)
  }

  getSessionRuntime(conversationId: string): SessionRuntime {
    const existing = this.sessions.get(conversationId)
    if (existing) return existing
    const sessionOptions: InternalSessionRuntimeOptions = {
      ...this.services.options,
      store: this.services.store,
      [SHARED_WORKBENCH_SERVICES]: this.services,
    }
    const session = new SessionRuntime(conversationId, sessionOptions)
    sessionRuntimeDeletedHandlers.set(session, () => {
      if (this.sessions.get(conversationId) === session) this.sessions.delete(conversationId)
    })
    this.sessions.set(conversationId, session)
    if (this.shutdownStarted) void session.shutdown('shutdown')
    return session
  }

  async getToolRegistry(input?: RuntimeToolPackLoadInput): Promise<ToolRegistry> {
    if (!input?.conversationId) return this.services.getToolRegistry(input)
    const session = this.getSessionRuntime(input.conversationId)
    return session.getToolRegistry(input.record ?? (await session.getConversation()))
  }

  async getSkills(): Promise<LoadedSkill[]> {
    return this.services.getSkills()
  }

  async reloadToolPacks(): Promise<ToolRegistry> {
    return this.services.reloadToolPacks()
  }

  async createConversation(
    input: RuntimeCreateConversationInput = {},
  ): Promise<ConversationSummary> {
    const summary = await this.catalog.createConversation(input)
    this.getSessionRuntime(summary.id)
    return summary
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return this.catalog.listConversations()
  }

  async getConversation(conversationId: string): Promise<ConversationRecord> {
    return this.getSessionRuntime(conversationId).getConversation()
  }

  async getSessionTree(conversationId: string): Promise<SessionTree> {
    return this.getSessionRuntime(conversationId).getSessionTree()
  }

  async navigateSession(input: RuntimeNavigateSessionInput): Promise<ConversationRecord> {
    return this.getSessionRuntime(input.conversationId).navigateSession(input)
  }

  async forkSession(input: RuntimeForkSessionInput): Promise<ConversationSummary> {
    const summary = await this.getSessionRuntime(input.conversationId).forkSession(input)
    this.getSessionRuntime(summary.id)
    return summary
  }

  async collectSessionGarbage(conversationId: string): Promise<BlobGarbageCollectionResult> {
    return this.getSessionRuntime(conversationId).collectGarbage()
  }

  async compactConversation(
    input: RuntimeCompactConversationInput,
  ): Promise<RuntimeCompactConversationResult> {
    return this.getSessionRuntime(input.conversationId).compact(input)
  }

  async resolveConversation(
    input: RuntimeResolveConversationInput = {},
  ): Promise<RuntimeResolveConversationResult> {
    const resolved = await this.catalog.resolveConversation(input)
    this.getSessionRuntime(resolved.conversationId)
    return resolved
  }

  async hydrateConversation(conversationId: string): Promise<ConversationRuntimeHydration> {
    return this.getSessionRuntime(conversationId).hydrate()
  }

  async getConversationRuntimeState(
    conversationId: string,
  ): Promise<ConversationRuntimeReplayState> {
    return this.getSessionRuntime(conversationId).getRuntimeState()
  }

  async listConversationRuntimeStates(): Promise<ConversationRuntimeStateSnapshot[]> {
    const conversations = await this.listConversations()
    return Promise.all(
      conversations.map(async ({ id }) => ({
        conversationId: id,
        state: await this.getSessionRuntime(id).getRuntimeState(),
      })),
    )
  }

  async listRunEvents(conversationId: string): Promise<PersistedRunEvent[]> {
    return this.getSessionRuntime(conversationId).listRunEvents()
  }

  async getRunSnapshot(conversationId: string, runId: string): Promise<RunSnapshot | null> {
    return this.getSessionRuntime(conversationId).getRunSnapshot(runId)
  }

  async listRunSnapshots(conversationId: string): Promise<RunSnapshot[]> {
    return this.getSessionRuntime(conversationId).listRunSnapshots()
  }

  async listRunSummaries(conversationId: string): Promise<RuntimeRunSummary[]> {
    return this.getSessionRuntime(conversationId).listRunSummaries()
  }

  async inspectRun(input: RuntimeRunControlInput): Promise<RuntimeRunInspection> {
    return this.getSessionRuntime(input.conversationId).inspectRun(input)
  }

  async getRunPayload(input: RuntimeRunPayloadInput): Promise<RunPayload> {
    return this.getSessionRuntime(input.conversationId).getRunPayload(input)
  }

  async appendUserMessage(input: RuntimeAppendUserMessageInput): Promise<PersistedMessage> {
    return this.getSessionRuntime(input.conversationId).appendUserMessage(input)
  }

  async appendSessionCustomEntry(input: RuntimeAppendSessionCustomInput): Promise<string> {
    return this.getSessionRuntime(input.conversationId).appendCustomEntry(input)
  }

  async appendSessionCustomMessage(input: RuntimeAppendSessionCustomMessageInput): Promise<string> {
    return this.getSessionRuntime(input.conversationId).appendCustomMessage(input)
  }

  async recordRunEvent(event: RuntimeRecordRunEventInput): Promise<boolean> {
    return this.getSessionRuntime(event.conversationId).recordRunEvent(event)
  }

  async renameConversation(conversationId: string, title: string): Promise<ConversationSummary> {
    return this.getSessionRuntime(conversationId).rename(title)
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const session = this.getSessionRuntime(conversationId)
    await session.delete()
  }

  async send(input: RuntimeSendInput): Promise<RuntimeSendResult> {
    return this.getSessionRuntime(input.conversationId).send(input)
  }

  async retryLastUserMessage(input: RuntimeRetryLastInput): Promise<RuntimeSendResult> {
    return this.getSessionRuntime(input.conversationId).retryLastUserMessage(input)
  }

  async resumeRun(input: RuntimeResumeRunInput): Promise<RuntimeSendResult> {
    return this.getSessionRuntime(input.conversationId).resumeRun(input)
  }

  async stepRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult> {
    return this.getSessionRuntime(input.conversationId).stepRun(input)
  }

  async continueRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult> {
    return this.getSessionRuntime(input.conversationId).continueRun(input)
  }

  async abortRun(input: RuntimeRunControlInput): Promise<RunSnapshot> {
    return this.getSessionRuntime(input.conversationId).abortRun(input)
  }

  async forkRun(input: RuntimeForkRunInput): Promise<RunSnapshot> {
    return this.getSessionRuntime(input.conversationId).forkRun(input)
  }

  async steer(input: RuntimeQueueControlInput): Promise<string> {
    return this.getSessionRuntime(input.conversationId).steer(input)
  }

  async followUp(input: RuntimeQueueControlInput): Promise<string> {
    return this.getSessionRuntime(input.conversationId).followUp(input)
  }

  async nextTurn(input: RuntimeQueueControlInput): Promise<string> {
    return this.getSessionRuntime(input.conversationId).nextTurn(input)
  }

  getInputQueueState(conversationId: string): SessionInputQueueState {
    return this.getSessionRuntime(conversationId).getInputQueueState()
  }

  clearInputQueue(conversationId: string): SessionInputQueueState {
    return this.getSessionRuntime(conversationId).clearInputQueue()
  }

  setSteeringMode(conversationId: string, mode: SessionInputQueueMode): void {
    this.getSessionRuntime(conversationId).setSteeringMode(mode)
  }

  setFollowUpMode(conversationId: string, mode: SessionInputQueueMode): void {
    this.getSessionRuntime(conversationId).setFollowUpMode(mode)
  }

  async abort(conversationId: string): Promise<void> {
    await this.getSessionRuntime(conversationId).abort()
  }

  async abortAll(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.abortActive(reason)))
  }

  shutdown(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    this.shutdownStarted = true
    if (!this.shutdownPromise) {
      this.shutdownPromise = Promise.all(
        [...this.sessions.values()].map((session) => session.shutdown(reason)),
      ).then(() => undefined)
    }
    return this.shutdownPromise
  }

  listActiveTurns(): ActiveAssistantTurn[] {
    return [...this.sessions.values()].flatMap((session) => {
      const turn = session.getActiveTurn()
      return turn ? [turn] : []
    })
  }

  listActiveStreams(): ActiveAssistantTurn[] {
    return this.listActiveTurns()
  }

  async recoverInterruptedActivities(reason?: string): Promise<ConversationSummary[]> {
    const recovered = await this.catalog.recoverInterruptedActivities(reason)
    for (const session of this.sessions.values()) {
      sessionRuntimeEngines.get(session)?.resetRecoveredPhase()
    }
    for (const summary of recovered) this.getSessionRuntime(summary.id)
    return recovered
  }

  async executeTool(input: RuntimeExecuteToolInput): Promise<string> {
    if (!input.conversationId) return this.services.executeTool(input)
    return this.getSessionRuntime(input.conversationId).executeTool(input)
  }
}
