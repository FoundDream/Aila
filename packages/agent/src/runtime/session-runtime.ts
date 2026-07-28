import type {
  ConversationRecord,
  ConversationRuntimeReplayState,
  ConversationSummary,
  PersistedMessage,
  PersistedRunEvent,
} from '../conversation-core'
import type { RunPayload, RunSnapshot } from '../run-persistence'
import type { BlobGarbageCollectionResult, SessionPhase, SessionTree } from '../session-journal'
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
  RuntimeAppendSessionCustomInput,
  RuntimeAppendSessionCustomMessageInput,
  RuntimeAppendUserMessageInput,
  RuntimeCompactConversationInput,
  RuntimeCompactConversationResult,
  RuntimeExecuteToolInput,
  RuntimeForkRunInput,
  RuntimeForkSessionInput,
  RuntimeNavigateSessionInput,
  RuntimeQueueInput,
  RuntimeRecordRunEventInput,
  RuntimeResumeRunInput,
  RuntimeRetryLastInput,
  RuntimeRunControlInput,
  RuntimeRunInspection,
  RuntimeRunPayloadInput,
  RuntimeRunSummary,
  RuntimeSendInput,
  RuntimeSendResult,
} from './api-types'
import { cloneRuntimeValue } from './clone'
import type { WorkbenchStore } from './repositories'
import { WorkbenchServices } from './services'
import { SessionRuntimeEngine } from './session-engine'
import type { WorkbenchOptions } from './workbench-host'

/**
 * A complete runtime bound to exactly one durable conversation session.
 *
 * Unlike WorkbenchRuntime, callers never pass a conversation id to turn,
 * navigation, compaction, extension, or run-control methods. All mutable
 * execution state is therefore scoped to this one session.
 */
export interface SessionRuntimeOptions extends WorkbenchOptions {
  store: WorkbenchStore
}

export const SHARED_WORKBENCH_SERVICES = Symbol('shared-workbench-services')
export type InternalSessionRuntimeOptions = SessionRuntimeOptions & {
  [SHARED_WORKBENCH_SERVICES]?: WorkbenchServices
}
export const sessionRuntimeDeletedHandlers = new WeakMap<SessionRuntime, () => void>()
export const sessionRuntimeEngines = new WeakMap<SessionRuntime, SessionRuntimeEngine>()

export class SessionRuntime {
  readonly conversationId: string
  private readonly engine: SessionRuntimeEngine
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>()

  constructor(conversationId: string, options: SessionRuntimeOptions) {
    if (!conversationId.trim()) throw new Error('conversationId is required')
    this.conversationId = conversationId
    const services =
      (options as InternalSessionRuntimeOptions)[SHARED_WORKBENCH_SERVICES] ??
      new WorkbenchServices(options)
    const onEvent = (event: WorkbenchEvent): void => {
      const eventConversationId =
        event.type === 'conversations:updated' ? event.data.id : event.data.conversationId
      if (eventConversationId !== this.conversationId) return
      for (const listener of this.listeners) listener(cloneRuntimeValue(event))
    }
    this.engine = new SessionRuntimeEngine(conversationId, services, onEvent)
    sessionRuntimeEngines.set(this, this.engine)
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async getConversation(): Promise<ConversationRecord> {
    return this.engine.getConversation(this.conversationId)
  }

  async getSessionTree(): Promise<SessionTree> {
    return this.engine.getSessionTree(this.conversationId)
  }

  async getPhase(): Promise<SessionPhase> {
    return (await this.getSessionTree()).phase
  }

  getActiveTurn(): ActiveAssistantTurn | null {
    return (
      this.engine.listActiveTurns().find((turn) => turn.conversationId === this.conversationId) ??
      null
    )
  }

  async waitForIdle(): Promise<void> {
    await this.engine.waitForIdle(this.conversationId)
  }

  async steer(input: RuntimeQueueInput): Promise<string> {
    return this.engine.steer({ ...input, conversationId: this.conversationId })
  }

  async followUp(input: RuntimeQueueInput): Promise<string> {
    return this.engine.followUp({ ...input, conversationId: this.conversationId })
  }

  async nextTurn(input: RuntimeQueueInput): Promise<string> {
    return this.engine.nextTurn({ ...input, conversationId: this.conversationId })
  }

  getInputQueueState(): SessionInputQueueState {
    return this.engine.getInputQueueState()
  }

  clearInputQueue(): SessionInputQueueState {
    return this.engine.clearInputQueue()
  }

  setSteeringMode(mode: SessionInputQueueMode): void {
    this.engine.setSteeringMode(mode)
  }

  setFollowUpMode(mode: SessionInputQueueMode): void {
    this.engine.setFollowUpMode(mode)
  }

  async navigateSession(
    input: Omit<RuntimeNavigateSessionInput, 'conversationId'>,
  ): Promise<ConversationRecord> {
    return this.engine.navigateSession({ ...input, conversationId: this.conversationId })
  }

  async forkSession(
    input: Omit<RuntimeForkSessionInput, 'conversationId'> = {},
  ): Promise<ConversationSummary> {
    return this.engine.forkSession({ ...input, conversationId: this.conversationId })
  }

  async collectGarbage(): Promise<BlobGarbageCollectionResult> {
    return this.engine.collectSessionGarbage(this.conversationId)
  }

  async compact(
    input: Omit<RuntimeCompactConversationInput, 'conversationId'>,
  ): Promise<RuntimeCompactConversationResult> {
    return this.engine.compactConversation({ ...input, conversationId: this.conversationId })
  }

  async hydrate(): Promise<ConversationRuntimeHydration> {
    return this.engine.hydrateConversation(this.conversationId)
  }

  async getRuntimeState(): Promise<ConversationRuntimeReplayState> {
    return this.engine.getConversationRuntimeState(this.conversationId)
  }

  async listRunEvents(): Promise<PersistedRunEvent[]> {
    return this.engine.listRunEvents(this.conversationId)
  }

  async getRunSnapshot(runId: string): Promise<RunSnapshot | null> {
    return this.engine.getRunSnapshot(this.conversationId, runId)
  }

  async listRunSnapshots(): Promise<RunSnapshot[]> {
    return this.engine.listRunSnapshots(this.conversationId)
  }

  async listRunSummaries(): Promise<RuntimeRunSummary[]> {
    return this.engine.listRunSummaries(this.conversationId)
  }

  async inspectRun(
    input: Omit<RuntimeRunControlInput, 'conversationId'>,
  ): Promise<RuntimeRunInspection> {
    return this.engine.inspectRun({ ...input, conversationId: this.conversationId })
  }

  async getRunPayload(input: Omit<RuntimeRunPayloadInput, 'conversationId'>): Promise<RunPayload> {
    return this.engine.getRunPayload({ ...input, conversationId: this.conversationId })
  }

  async rename(title: string): Promise<ConversationSummary> {
    return this.engine.renameConversation(this.conversationId, title)
  }

  async appendUserMessage(
    input: Omit<RuntimeAppendUserMessageInput, 'conversationId'>,
  ): Promise<PersistedMessage> {
    return this.engine.appendUserMessage({ ...input, conversationId: this.conversationId })
  }

  async appendCustomEntry(
    input: Omit<RuntimeAppendSessionCustomInput, 'conversationId'>,
  ): Promise<string> {
    return this.engine.appendSessionCustomEntry({
      ...input,
      conversationId: this.conversationId,
    })
  }

  async appendCustomMessage(
    input: Omit<RuntimeAppendSessionCustomMessageInput, 'conversationId'>,
  ): Promise<string> {
    return this.engine.appendSessionCustomMessage({
      ...input,
      conversationId: this.conversationId,
    })
  }

  async recordRunEvent(
    event: Omit<RuntimeRecordRunEventInput, 'conversationId'>,
  ): Promise<boolean> {
    return this.engine.recordRunEvent({ ...event, conversationId: this.conversationId })
  }

  async getToolRegistry(record?: ConversationRecord): Promise<ToolRegistry> {
    return this.engine.getToolRegistry(
      record ? { conversationId: this.conversationId, record } : undefined,
    )
  }

  async getSkills(): Promise<LoadedSkill[]> {
    return this.engine.getSkills()
  }

  async reloadToolPacks(): Promise<ToolRegistry> {
    return this.engine.reloadToolPacks()
  }

  async executeTool(input: Omit<RuntimeExecuteToolInput, 'conversationId'>): Promise<string> {
    return this.engine.executeTool({ ...input, conversationId: this.conversationId })
  }

  async send(input: Omit<RuntimeSendInput, 'conversationId'>): Promise<RuntimeSendResult> {
    return this.engine.send({ ...input, conversationId: this.conversationId })
  }

  async retryLastUserMessage(
    input: Omit<RuntimeRetryLastInput, 'conversationId'>,
  ): Promise<RuntimeSendResult> {
    return this.engine.retryLastUserMessage({
      ...input,
      conversationId: this.conversationId,
    })
  }

  async resumeRun(
    input: Omit<RuntimeResumeRunInput, 'conversationId'>,
  ): Promise<RuntimeSendResult> {
    return this.engine.resumeRun({ ...input, conversationId: this.conversationId })
  }

  async stepRun(input: Omit<RuntimeRunControlInput, 'conversationId'>): Promise<RuntimeSendResult> {
    return this.engine.stepRun({ ...input, conversationId: this.conversationId })
  }

  async continueRun(
    input: Omit<RuntimeRunControlInput, 'conversationId'>,
  ): Promise<RuntimeSendResult> {
    return this.engine.continueRun({ ...input, conversationId: this.conversationId })
  }

  async abortRun(input: Omit<RuntimeRunControlInput, 'conversationId'>): Promise<RunSnapshot> {
    return this.engine.abortRun({ ...input, conversationId: this.conversationId })
  }

  async forkRun(input: Omit<RuntimeForkRunInput, 'conversationId'>): Promise<RunSnapshot> {
    return this.engine.forkRun({ ...input, conversationId: this.conversationId })
  }

  async abort(): Promise<void> {
    await this.engine.abort(this.conversationId)
  }

  async abortActive(reason: ConversationAbortReason = 'user'): Promise<void> {
    await this.engine.abortAll(reason)
  }

  async shutdown(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    await this.engine.shutdown(reason)
  }

  async delete(): Promise<void> {
    await this.engine.deleteConversation(this.conversationId)
    sessionRuntimeDeletedHandlers.get(this)?.()
  }
}
