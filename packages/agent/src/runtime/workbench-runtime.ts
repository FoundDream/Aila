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
import type {
  SessionInputQueueMode,
  SessionInputQueueState,
  WorkbenchEvent,
} from '../workbench-events'
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
  RuntimeSessionAvailability,
  RuntimeToolPackLoadInput,
} from './api-types'
import { ConversationCatalog } from './catalog'
import { cloneRuntimeValue } from './clone'
import { WorkbenchServices } from './services'
import { SessionRuntimeEngine } from './session-engine'
import type { Workbench, WorkbenchOptions } from './workbench-host'

/**
 * Multi-session process facade. Durable conversation execution is delegated to
 * one SessionRuntimeEngine instance per conversation.
 */
export class WorkbenchRuntime implements Workbench {
  private readonly services: WorkbenchServices
  private readonly catalog: ConversationCatalog
  private readonly engines = new Map<string, SessionRuntimeEngine>()
  private readonly sessionListeners = new Map<string, Set<(event: WorkbenchEvent) => void>>()
  private shutdownStarted = false
  private shutdownPromise: Promise<void> | null = null

  constructor(options: WorkbenchOptions = {}) {
    this.services = new WorkbenchServices(options)
    this.catalog = new ConversationCatalog(this.services)
  }

  private getEngine(conversationId: string): SessionRuntimeEngine {
    if (!conversationId.trim()) throw new Error('conversationId is required')
    const existing = this.engines.get(conversationId)
    if (existing) return existing
    const engine = new SessionRuntimeEngine(conversationId, this.services, (event) => {
      const eventConversationId =
        event.type === 'conversations:updated' ? event.data.id : event.data.conversationId
      if (eventConversationId !== conversationId) return
      const listeners = this.sessionListeners.get(conversationId)
      if (!listeners) return
      for (const listener of listeners) listener(cloneRuntimeValue(event))
    })
    this.engines.set(conversationId, engine)
    if (this.shutdownStarted) void engine.shutdown('shutdown')
    return engine
  }

  /** Per-session event subscription — the pre-hooks observation channel. */
  subscribeSession(conversationId: string, listener: (event: WorkbenchEvent) => void): () => void {
    this.getEngine(conversationId)
    const listeners = this.sessionListeners.get(conversationId) ?? new Set()
    listeners.add(listener)
    this.sessionListeners.set(conversationId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && this.sessionListeners.get(conversationId) === listeners) {
        this.sessionListeners.delete(conversationId)
      }
    }
  }

  async getToolRegistry(input?: RuntimeToolPackLoadInput): Promise<ToolRegistry> {
    if (!input?.conversationId) return this.services.getToolRegistry(input)
    const engine = this.getEngine(input.conversationId)
    const record = input.record ?? (await engine.getConversation(input.conversationId))
    return engine.getToolRegistry({ conversationId: input.conversationId, record })
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
    this.getEngine(summary.id)
    return summary
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return this.catalog.listConversations()
  }

  async getConversation(conversationId: string): Promise<ConversationRecord> {
    return this.getEngine(conversationId).getConversation(conversationId)
  }

  async getAvailability(conversationId: string): Promise<RuntimeSessionAvailability> {
    return this.getEngine(conversationId).getAvailability(conversationId)
  }

  async getSessionTree(conversationId: string): Promise<SessionTree> {
    return this.getEngine(conversationId).getSessionTree(conversationId)
  }

  async navigateSession(input: RuntimeNavigateSessionInput): Promise<ConversationRecord> {
    return this.getEngine(input.conversationId).navigateSession(input)
  }

  async forkSession(input: RuntimeForkSessionInput): Promise<ConversationSummary> {
    const summary = await this.getEngine(input.conversationId).forkSession(input)
    this.getEngine(summary.id)
    return summary
  }

  async collectSessionGarbage(conversationId: string): Promise<BlobGarbageCollectionResult> {
    return this.getEngine(conversationId).collectSessionGarbage(conversationId)
  }

  async compactConversation(
    input: RuntimeCompactConversationInput,
  ): Promise<RuntimeCompactConversationResult> {
    return this.getEngine(input.conversationId).compactConversation(input)
  }

  async resolveConversation(
    input: RuntimeResolveConversationInput = {},
  ): Promise<RuntimeResolveConversationResult> {
    const resolved = await this.catalog.resolveConversation(input)
    this.getEngine(resolved.conversationId)
    return resolved
  }

  async hydrateConversation(conversationId: string): Promise<ConversationRuntimeHydration> {
    return this.getEngine(conversationId).hydrateConversation(conversationId)
  }

  async getConversationRuntimeState(
    conversationId: string,
  ): Promise<ConversationRuntimeReplayState> {
    return this.getEngine(conversationId).getConversationRuntimeState(conversationId)
  }

  async listConversationRuntimeStates(): Promise<ConversationRuntimeStateSnapshot[]> {
    const conversations = await this.listConversations()
    return Promise.all(
      conversations.map(async ({ id }) => ({
        conversationId: id,
        state: await this.getEngine(id).getConversationRuntimeState(id),
      })),
    )
  }

  async listRunEvents(conversationId: string): Promise<PersistedRunEvent[]> {
    return this.getEngine(conversationId).listRunEvents(conversationId)
  }

  async getRunSnapshot(conversationId: string, runId: string): Promise<RunSnapshot | null> {
    return this.getEngine(conversationId).getRunSnapshot(conversationId, runId)
  }

  async listRunSnapshots(conversationId: string): Promise<RunSnapshot[]> {
    return this.getEngine(conversationId).listRunSnapshots(conversationId)
  }

  async listRunSummaries(conversationId: string): Promise<RuntimeRunSummary[]> {
    return this.getEngine(conversationId).listRunSummaries(conversationId)
  }

  async inspectRun(input: RuntimeRunControlInput): Promise<RuntimeRunInspection> {
    return this.getEngine(input.conversationId).inspectRun(input)
  }

  async getRunPayload(input: RuntimeRunPayloadInput): Promise<RunPayload> {
    return this.getEngine(input.conversationId).getRunPayload(input)
  }

  async appendUserMessage(input: RuntimeAppendUserMessageInput): Promise<PersistedMessage> {
    return this.getEngine(input.conversationId).appendUserMessage(input)
  }

  async appendSessionCustomEntry(input: RuntimeAppendSessionCustomInput): Promise<string> {
    return this.getEngine(input.conversationId).appendSessionCustomEntry(input)
  }

  async appendSessionCustomMessage(input: RuntimeAppendSessionCustomMessageInput): Promise<string> {
    return this.getEngine(input.conversationId).appendSessionCustomMessage(input)
  }

  async recordRunEvent(event: RuntimeRecordRunEventInput): Promise<boolean> {
    return this.getEngine(event.conversationId).recordRunEvent(event)
  }

  async renameConversation(conversationId: string, title: string): Promise<ConversationSummary> {
    return this.getEngine(conversationId).renameConversation(conversationId, title)
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const engine = this.getEngine(conversationId)
    await engine.deleteConversation(conversationId)
    if (this.engines.get(conversationId) === engine) this.engines.delete(conversationId)
    this.sessionListeners.delete(conversationId)
  }

  async send(input: RuntimeSendInput): Promise<RuntimeSendResult> {
    return this.getEngine(input.conversationId).send(input)
  }

  async retryLastUserMessage(input: RuntimeRetryLastInput): Promise<RuntimeSendResult> {
    return this.getEngine(input.conversationId).retryLastUserMessage(input)
  }

  async resumeRun(input: RuntimeResumeRunInput): Promise<RuntimeSendResult> {
    return this.getEngine(input.conversationId).resumeRun(input)
  }

  async stepRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult> {
    return this.getEngine(input.conversationId).stepRun(input)
  }

  async continueRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult> {
    return this.getEngine(input.conversationId).continueRun(input)
  }

  async abortRun(input: RuntimeRunControlInput): Promise<RunSnapshot> {
    return this.getEngine(input.conversationId).abortRun(input)
  }

  async forkRun(input: RuntimeForkRunInput): Promise<RunSnapshot> {
    return this.getEngine(input.conversationId).forkRun(input)
  }

  async steer(input: RuntimeQueueControlInput): Promise<string> {
    return this.getEngine(input.conversationId).steer(input)
  }

  async followUp(input: RuntimeQueueControlInput): Promise<string> {
    return this.getEngine(input.conversationId).followUp(input)
  }

  async nextTurn(input: RuntimeQueueControlInput): Promise<string> {
    return this.getEngine(input.conversationId).nextTurn(input)
  }

  getInputQueueState(conversationId: string): SessionInputQueueState {
    return this.getEngine(conversationId).getInputQueueState()
  }

  clearInputQueue(conversationId: string): SessionInputQueueState {
    return this.getEngine(conversationId).clearInputQueue()
  }

  setSteeringMode(conversationId: string, mode: SessionInputQueueMode): void {
    this.getEngine(conversationId).setSteeringMode(mode)
  }

  setFollowUpMode(conversationId: string, mode: SessionInputQueueMode): void {
    this.getEngine(conversationId).setFollowUpMode(mode)
  }

  async abort(conversationId: string): Promise<void> {
    await this.getEngine(conversationId).abort(conversationId)
  }

  async abortAll(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    await Promise.all([...this.engines.values()].map((engine) => engine.abortAll(reason)))
  }

  shutdown(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    this.shutdownStarted = true
    if (!this.shutdownPromise) {
      this.shutdownPromise = Promise.all(
        [...this.engines.values()].map((engine) => engine.shutdown(reason)),
      ).then(() => undefined)
    }
    return this.shutdownPromise
  }

  listActiveTurns(): ActiveAssistantTurn[] {
    return [...this.engines.values()].flatMap((engine) => engine.listActiveTurns())
  }

  async recoverInterruptedActivities(reason?: string): Promise<ConversationSummary[]> {
    const recovered = await this.catalog.recoverInterruptedActivities(reason)
    for (const engine of this.engines.values()) engine.resetRecoveredPhase()
    for (const summary of recovered) this.getEngine(summary.id)
    return recovered
  }

  async executeTool(input: RuntimeExecuteToolInput): Promise<string> {
    if (!input.conversationId) return this.services.executeTool(input)
    return this.getEngine(input.conversationId).executeTool(input)
  }
}
