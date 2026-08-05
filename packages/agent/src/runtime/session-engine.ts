import type { ChatMessage, ModelInfo, ModelSelection, UsageInfo } from '../agent-protocol'
import {
  type AgentContextPlan,
  type AgentContextRecommendedCheckpoint,
  type AgentContextTokenPreflight,
  applyAgentContextTokenPreflight,
  assembleAgentContext,
  recommendManualContextCheckpoint,
} from '../context'
import {
  AILA_CONTEXT_CHECKPOINT_SCHEMA_VERSION,
  AILA_CONTEXT_TURN_LEDGER_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  type ConversationCompactArtifact,
  type ConversationContextCheckpoint,
  type ConversationContextTurnLedgerEntry,
  type ConversationRecord,
  type ConversationRuntimeReplayState,
  type ConversationSummary,
  normalizeConversationCompactArtifact,
  type PersistedBlock,
  type PersistedMessage,
  type PersistedRunEvent,
  type RunEventAppendResult,
  replayConversationRuntimeState,
} from '../conversation-core'
import type { RunIdentity, RunNextAction } from '../run-machine'
import { prepareRunSnapshotForResume, type RunPayload, type RunSnapshot } from '../run-persistence'
import { listJournalRunIds, rebuildRunSnapshot } from '../run-replay'
import {
  type BlobGarbageCollectionResult,
  type BlobRef,
  projectConversation,
  type SessionEntryInput,
  type SessionPhase,
  type SessionTree,
  sessionRunEvents,
  sessionRunPayloads,
} from '../session-journal'
import type { LoadedSkill } from '../skills'
import type { ToolContext, ToolRegistry } from '../tools'
import {
  createWorkbenchEvent,
  type SessionInputQueueMode,
  type SessionInputQueueState,
  type WorkbenchEvent,
} from '../workbench-events'
import type {
  ActiveAssistantTurn,
  ChatAttachmentInput,
  ConversationAbortReason,
  ConversationRuntimeHydration,
  RuntimeAppendSessionCustomInput,
  RuntimeAppendSessionCustomMessageInput,
  RuntimeAppendUserMessageInput,
  RuntimeAttachmentBlock,
  RuntimeCompactConversationInput,
  RuntimeCompactConversationResult,
  RuntimeContextTokenCountInput,
  RuntimeExecuteToolInput,
  RuntimeForkRunInput,
  RuntimeForkSessionInput,
  RuntimeNavigateSessionInput,
  RuntimeQueueControlInput,
  RuntimeRecordRunEventInput,
  RuntimeResumeRunInput,
  RuntimeRetryLastInput,
  RuntimeRunControlInput,
  RuntimeRunInspection,
  RuntimeRunPayloadInput,
  RuntimeRunSummary,
  RuntimeSendInput,
  RuntimeSendResult,
  RuntimeSessionAvailability,
  RuntimeStableInstructionsInput,
  RuntimeToolLoadInput,
  RuntimeTransientContextInput,
} from './api-types'
import {
  assertRuntimeAttachmentBlock,
  cloneRuntimeChatMessages,
  cloneRuntimeConversationRecord,
  cloneRuntimeConversationSummary,
  cloneRuntimePersistedMessage,
  cloneRuntimePersistedRunEvents,
  cloneRuntimeSettings,
  cloneRuntimeValue,
  cloneRuntimeWorkspaceRoots,
  prepareRuntimeModelStepMessages,
} from './clone'
import type { WorkbenchStore } from './repositories'
import {
  DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS,
  errorMessage,
  FALLBACK_MODEL_CONTEXT,
  isRunContextBlobData,
  type RunContextBlobData,
  resolveRetryTurn,
  runPayloadDescriptor,
  runPayloadFromEntry,
  runtimeRunAllowedControls,
  withTurnSelection,
} from './run-helpers'
import type { LifecycleDispatcher, WorkbenchServices } from './services'
import {
  type CoordinatedTurn,
  SessionTurnCoordinator,
  type TurnStartLock,
} from './turn-coordinator'
import type { WorkbenchHost, WorkbenchOptions } from './workbench-host'

export interface StreamSlot extends CoordinatedTurn {
  controller: AbortController
  cleanup: Promise<void>
  assistantMessageId: string
  run: RunIdentity
  selection: ModelSelection
  abortRecorded: boolean
  cleanupInterruptedRecorded: boolean
  turnStartLock: TurnStartLock
}

export interface QueuedSessionInput {
  message: PersistedMessage
  chatMessage: ChatMessage
}

export interface RuntimeToolContextInput {
  conversationId?: string
  record?: ConversationRecord
  messageId?: string
  toolCallId?: string
  signal?: AbortSignal
}

export type RuntimeCompactArtifactSource = 'model' | 'heuristic'
export type RuntimeCompactArtifactFallbackReason =
  | 'missing_hook'
  | 'empty_result'
  | 'invalid_artifact'
  | 'error'

export interface RuntimeSemanticCompactArtifact {
  artifact: ConversationCompactArtifact
  summary: string
  source: RuntimeCompactArtifactSource
  fallbackReason?: RuntimeCompactArtifactFallbackReason
}

export type MaybePromise<T> = T | Promise<T>
export type RunEventInput = RuntimeRecordRunEventInput

export class SessionRuntimeEngine {
  private readonly turns: SessionTurnCoordinator<StreamSlot>
  private deleted = false
  private sessionPhase: SessionPhase | undefined
  private pendingSessionWrites: SessionEntryInput[] = []
  private steeringQueue: QueuedSessionInput[] = []
  private followUpQueue: QueuedSessionInput[] = []
  private nextTurnQueue: QueuedSessionInput[] = []
  private steeringQueueMode: SessionInputQueueMode = 'one-at-a-time'
  private followUpQueueMode: SessionInputQueueMode = 'one-at-a-time'
  private readonly host: WorkbenchHost
  private readonly store: WorkbenchStore
  private readonly logger: Pick<Console, 'error' | 'warn'>
  private readonly lifecycle: LifecycleDispatcher
  private readonly createId: () => string
  private readonly createRunId: () => string
  private readonly createEventId: () => string
  private readonly now: () => number
  private readonly options: WorkbenchOptions
  private shutdownPromise: Promise<void> | null = null
  private shutdownStarted = false
  private lastAvailabilityKey: string | null = null

  constructor(
    private readonly conversationId: string,
    private readonly services: WorkbenchServices,
    private readonly onSessionEvent?: (event: WorkbenchEvent) => void,
  ) {
    this.turns = new SessionTurnCoordinator(conversationId)
    this.host = services.host
    this.store = services.store
    this.logger = services.logger
    this.lifecycle = services.lifecycle
    this.createId = services.createId
    this.createRunId = services.createRunId
    this.createEventId = services.createEventId
    this.now = services.now
    this.options = services.options
  }

  async getToolRegistry(input?: RuntimeToolLoadInput): Promise<ToolRegistry> {
    return this.services.getToolRegistry(input)
  }

  async getSkills(): Promise<LoadedSkill[]> {
    return this.services.getSkills()
  }

  async reloadTools(): Promise<ToolRegistry> {
    return this.services.reloadTools()
  }

  async getConversation(conversationId: string): Promise<ConversationRecord> {
    return cloneRuntimeConversationRecord(
      projectConversation(await this.store.listSessionEntries(conversationId), {
        entryTransforms: this.host.sessionEntryTransforms,
        customEntryProjectors: this.host.sessionCustomEntryProjectors,
      }),
    )
  }

  async getSessionTree(conversationId: string): Promise<SessionTree> {
    return cloneRuntimeValue(await this.store.getSessionTree(conversationId))
  }

  async navigateSession(input: RuntimeNavigateSessionInput): Promise<ConversationRecord> {
    return this.turns.withStartLock(async () => {
      await this.assertAvailableStructural(
        input.conversationId,
        'cannot navigate session while an assistant turn is running',
      )
      const appended = await this.store.setSessionLeaf(input.conversationId, input.entryId)
      const record = await this.getConversation(input.conversationId)
      this.emit(createWorkbenchEvent('conversations:updated', appended.summary))
      this.lifecycle.dispatch('session', 'onNavigated', {
        conversationId: input.conversationId,
        entryId: input.entryId,
      })
      return record
    })
  }

  async forkSession(input: RuntimeForkSessionInput): Promise<ConversationSummary> {
    return this.turns.withStartLock(async () => {
      await this.assertAvailableStructural(
        input.conversationId,
        'cannot fork session while an assistant turn is running',
      )
      const summary = await this.store.forkConversation(
        input.conversationId,
        input.entryId,
        input.workspace,
      )
      const cloned = cloneRuntimeConversationSummary(summary)
      this.emit(createWorkbenchEvent('conversations:updated', cloned))
      this.lifecycle.dispatch('session', 'onForked', {
        sourceConversationId: input.conversationId,
        summary: cloned,
      })
      return cloned
    })
  }

  async collectSessionGarbage(conversationId: string): Promise<BlobGarbageCollectionResult> {
    await this.assertAvailableStructural(
      conversationId,
      'cannot collect session garbage while an assistant turn is running',
    )
    return cloneRuntimeValue(await this.store.collectGarbageBlobs(conversationId))
  }

  async listRunEvents(conversationId: string): Promise<PersistedRunEvent[]> {
    return cloneRuntimePersistedRunEvents(
      sessionRunEvents(await this.store.listSessionEntries(conversationId)),
    )
  }

  // Snapshots are computed views over the journal — never persisted.
  async getRunSnapshot(conversationId: string, runId: string): Promise<RunSnapshot | null> {
    const entries = await this.store.listSessionEntries(conversationId)
    return rebuildRunSnapshot({
      runId,
      entries,
      getBlob: (blobId) => this.store.getBlob(conversationId, blobId),
    })
  }

  async listRunSnapshots(conversationId: string): Promise<RunSnapshot[]> {
    const entries = await this.store.listSessionEntries(conversationId)
    const snapshots = await Promise.all(
      listJournalRunIds(entries).map((runId) =>
        rebuildRunSnapshot({
          runId,
          entries,
          getBlob: (blobId) => this.store.getBlob(conversationId, blobId),
        }),
      ),
    )
    return snapshots
      .filter((snapshot): snapshot is RunSnapshot => snapshot !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async listRunSummaries(conversationId: string): Promise<RuntimeRunSummary[]> {
    const activeRunIds = new Set(
      this.listActiveTurns()
        .filter((turn) => turn.conversationId === conversationId)
        .map((turn) => turn.runId),
    )
    return (await this.listRunSnapshots(conversationId)).map((snapshot) => {
      const active = activeRunIds.has(snapshot.identity.runId)
      return {
        identity: cloneRuntimeValue(snapshot.identity),
        status: snapshot.loop.state.status,
        mode: snapshot.loop.state.mode,
        ...(snapshot.loop.state.nextAction
          ? { nextAction: cloneRuntimeValue(snapshot.loop.state.nextAction) }
          : {}),
        ...(snapshot.loop.state.wait ? { wait: cloneRuntimeValue(snapshot.loop.state.wait) } : {}),
        recovery: cloneRuntimeValue(snapshot.recovery),
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        stepCount: snapshot.loop.state.steps.length,
        active,
        allowedControls: runtimeRunAllowedControls(snapshot, active),
      }
    })
  }

  async inspectRun(input: RuntimeRunControlInput): Promise<RuntimeRunInspection> {
    const snapshot = await this.getRunSnapshot(input.conversationId, input.runId)
    if (!snapshot) {
      throw new Error(`agent run snapshot not found: ${input.conversationId}/${input.runId}`)
    }
    const [events, entries] = await Promise.all([
      this.listRunEvents(input.conversationId),
      this.store.listSessionEntries(input.conversationId),
    ])
    const payloadEntries = sessionRunPayloads(entries, input.runId)
    const payloads = await Promise.all(
      payloadEntries.map(async (entry) => {
        const blob = entry.payloadRef
          ? await this.store.getBlob(input.conversationId, entry.payloadRef.blobId)
          : null
        return runPayloadFromEntry(entry, blob?.data ?? null)
      }),
    )
    const active = this.listActiveTurns().some((turn) => turn.runId === input.runId)
    return cloneRuntimeValue({
      snapshot,
      events: events.filter((event) => event.runId === input.runId),
      payloads: [...payloads].map(runPayloadDescriptor),
      active,
      allowedControls: runtimeRunAllowedControls(snapshot, active),
    })
  }

  async getRunPayload(input: RuntimeRunPayloadInput): Promise<RunPayload> {
    const entry = sessionRunPayloads(
      await this.store.listSessionEntries(input.conversationId),
      input.runId,
    ).find((candidate) => candidate.entryId === input.payloadId)
    if (!entry) {
      throw new Error(`agent run payload not found: ${input.payloadId}`)
    }
    const blob = entry.payloadRef
      ? await this.store.getBlob(input.conversationId, entry.payloadRef.blobId)
      : null
    return cloneRuntimeValue(runPayloadFromEntry(entry, blob?.data ?? null))
  }

  async getConversationRuntimeState(
    conversationId: string,
  ): Promise<ConversationRuntimeReplayState> {
    const events = await this.listRunEvents(conversationId)
    return cloneRuntimeValue(replayConversationRuntimeState(events))
  }

  async hydrateConversation(conversationId: string): Promise<ConversationRuntimeHydration> {
    const [record, events] = await Promise.all([
      this.getConversation(conversationId),
      this.listRunEvents(conversationId),
    ])
    const runtimeState = replayConversationRuntimeState(events)
    const activeTurn =
      this.listActiveTurns().find((turn) => turn.conversationId === conversationId) ?? null
    return cloneRuntimeValue({ record, events, runtimeState, activeTurn })
  }

  async renameConversation(conversationId: string, title: string): Promise<ConversationSummary> {
    const { summary: appended } = await this.store.appendSessionEntry(conversationId, {
      type: 'conversation.renamed',
      timestamp: this.now(),
      data: { title },
    })
    const summary = cloneRuntimeConversationSummary(appended)
    this.emit(createWorkbenchEvent('conversations:updated', summary))
    this.lifecycle.dispatch('session', 'onRenamed', { conversationId, title, summary })
    return summary
  }

  async appendUserMessage(input: RuntimeAppendUserMessageInput): Promise<PersistedMessage> {
    const { conversationId, text } = input
    this.assertCanStartTurn(conversationId)
    const message: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: this.createId(),
      role: 'user',
      blocks: [{ type: 'text', content: text }],
      status: 'done',
    }
    if (!(await this.persistAndAnnounce(conversationId, message))) {
      this.assertConversationOpen(conversationId)
      throw new Error('conversation was deleted')
    }
    return message
  }

  async steer(input: RuntimeQueueControlInput): Promise<string> {
    this.assertBoundConversation(input.conversationId)
    this.assertCanStartTurn(input.conversationId)
    if (!this.turns.has()) {
      throw new Error('cannot steer while the session is idle')
    }
    const queued = this.createQueuedSessionInput(input.text)
    this.steeringQueue.push(queued)
    this.emitQueueUpdate()
    return queued.message.id
  }

  async followUp(input: RuntimeQueueControlInput): Promise<string> {
    this.assertBoundConversation(input.conversationId)
    this.assertCanStartTurn(input.conversationId)
    if (!this.turns.has()) {
      throw new Error('cannot follow up while the session is idle')
    }
    const queued = this.createQueuedSessionInput(input.text)
    this.followUpQueue.push(queued)
    this.emitQueueUpdate()
    return queued.message.id
  }

  async nextTurn(input: RuntimeQueueControlInput): Promise<string> {
    this.assertBoundConversation(input.conversationId)
    this.assertCanStartTurn(input.conversationId)
    const queued = this.createQueuedSessionInput(input.text)
    this.nextTurnQueue.push(queued)
    this.emitQueueUpdate()
    return queued.message.id
  }

  getInputQueueState(): SessionInputQueueState {
    return {
      conversationId: this.conversationId,
      steering: this.steeringQueue.map((queued) => cloneRuntimePersistedMessage(queued.message)),
      followUp: this.followUpQueue.map((queued) => cloneRuntimePersistedMessage(queued.message)),
      nextTurn: this.nextTurnQueue.map((queued) => cloneRuntimePersistedMessage(queued.message)),
      steeringMode: this.steeringQueueMode,
      followUpMode: this.followUpQueueMode,
    }
  }

  clearInputQueue(): SessionInputQueueState {
    this.steeringQueue = []
    this.followUpQueue = []
    this.nextTurnQueue = []
    this.emitQueueUpdate()
    return this.getInputQueueState()
  }

  setSteeringMode(mode: SessionInputQueueMode): void {
    this.assertQueueMode(mode)
    this.steeringQueueMode = mode
    this.emitQueueUpdate()
  }

  setFollowUpMode(mode: SessionInputQueueMode): void {
    this.assertQueueMode(mode)
    this.followUpQueueMode = mode
    this.emitQueueUpdate()
  }

  async appendSessionCustomEntry(input: RuntimeAppendSessionCustomInput): Promise<string> {
    const entryId = this.createEventId()
    await this.appendOrQueueSessionWrite(input.conversationId, {
      type: 'extension.custom',
      entryId,
      timestamp: this.now(),
      data: {
        namespace: input.namespace,
        version: input.version,
        data: cloneRuntimeValue(input.data),
      },
    })
    return entryId
  }

  async appendSessionCustomMessage(input: RuntimeAppendSessionCustomMessageInput): Promise<string> {
    const entryId = this.createEventId()
    await this.appendOrQueueSessionWrite(input.conversationId, {
      type: 'extension.message',
      entryId,
      timestamp: this.now(),
      data: {
        namespace: input.namespace,
        version: input.version,
        message: cloneRuntimeValue(input.message),
      },
    })
    return entryId
  }

  async executeTool(input: RuntimeExecuteToolInput): Promise<string> {
    let record: ConversationRecord | undefined
    if (input.conversationId) {
      try {
        record = await this.getConversation(input.conversationId)
      } catch {
        record = undefined
      }
    }
    return this.services.executeTool(input, record)
  }

  async compactConversation(
    input: RuntimeCompactConversationInput,
  ): Promise<RuntimeCompactConversationResult> {
    return this.turns.withStartLock(async () => {
      const { conversationId, selection } = input
      await this.assertAvailableStructural(
        conversationId,
        'cannot compact while assistant turn is running',
      )
      await this.setSessionPhase(conversationId, 'compaction')
      try {
        const record = await this.getConversation(conversationId)
        const contextInput = {
          conversationId,
          record,
          selection,
          source: 'send' as const,
        }
        const [resolvedStableInstructions, hostTransientContext] = await Promise.all([
          this.resolveStableInstructions(contextInput),
          this.resolveTransientContext(contextInput),
        ])
        const context = assembleAgentContext({
          stableInstructions: resolvedStableInstructions,
          messages: cloneRuntimeValue(record.messages),
          modelInfo: await this.resolveModelInfo(selection),
          providerId: selection.providerId,
          dynamicContext: hostTransientContext,
          compactionCheckpoint: record.meta.context?.checkpoint,
        })
        const manualMessageId = context.plan.compaction.recommendedCheckpoint?.boundaryMessageId
        const contextPlan = await this.applyContextTokenPreflight({
          conversationId,
          assistantMessageId: manualMessageId ?? `compact:${this.createId()}`,
          selection,
          messages: context.messages,
          contextPlan: context.plan,
        })
        const recommended =
          contextPlan.compaction.recommendedCheckpoint ??
          recommendManualContextCheckpoint({
            stableInstructions: resolvedStableInstructions,
            messages: cloneRuntimeValue(record.messages),
            modelInfo: await this.resolveModelInfo(selection),
            providerId: selection.providerId,
            dynamicContext: hostTransientContext,
            compactionCheckpoint: record.meta.context?.checkpoint,
          })
        if (!recommended) {
          return {
            compacted: false,
            reason: 'nothing_to_compact',
            summary: cloneRuntimeConversationSummary(record.meta),
          }
        }

        const checkpoint = await this.persistContextCheckpoint({
          conversationId,
          messageId: recommended.boundaryMessageId,
          record,
          selection,
          contextPlan,
          recommended,
          reason: contextPlan.compaction.reason ?? 'manual',
          trigger: 'manual',
        })
        if (!checkpoint) {
          return {
            compacted: false,
            reason: 'nothing_to_compact',
            summary: cloneRuntimeConversationSummary(record.meta),
          }
        }
        const nextRecord = await this.getConversation(conversationId)
        return {
          compacted: true,
          summary: cloneRuntimeConversationSummary(nextRecord.meta),
          checkpoint: cloneRuntimeValue(checkpoint),
        }
      } finally {
        await this.flushPendingSessionWrites(conversationId)
        await this.setSessionPhase(conversationId, 'idle')
      }
    })
  }

  async send(input: RuntimeSendInput): Promise<RuntimeSendResult> {
    return this.turns.withStartLock(async (turnStartLock) => {
      const { conversationId, userText, selection, attachments, transientContext } = input
      this.assertCanStartTurn(conversationId)

      // Wait for any prior stream on this conversation to finish its persistence
      // side-effects before appending the next user message.
      const previous = this.turns.get()
      if (previous) await this.waitForPriorStreamBeforeNextTurn(conversationId, previous)
      this.assertCanStartTurn(conversationId)
      await this.drainQueuedInputs('nextTurn')
      this.assertCanStartTurn(conversationId)

      const blocks: PersistedBlock[] = [
        { type: 'text', content: userText },
        ...(await this.persistAttachments(conversationId, attachments ?? [])),
      ]

      const userMessage: PersistedMessage = {
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: this.createId(),
        role: 'user',
        blocks,
        status: 'done',
      }
      if (!(await this.persistAndAnnounce(conversationId, userMessage))) {
        this.assertConversationOpen(conversationId)
        throw new Error('conversation was deleted')
      }
      this.assertCanStartTurn(conversationId)

      const record = await this.getConversation(conversationId)
      this.assertCanStartTurn(conversationId)
      return this.startAssistantTurn({
        conversationId,
        userMessage,
        record,
        selection,
        loopMode: input.loopMode ?? 'continuous',
        transientContext,
        source: 'send',
        turnStartLock,
      })
    })
  }

  async retryLastUserMessage(input: RuntimeRetryLastInput): Promise<RuntimeSendResult> {
    return this.turns.withStartLock(async (turnStartLock) => {
      const { conversationId, selection, transientContext } = input
      this.assertCanStartTurn(conversationId)
      const previous = this.turns.get()
      if (previous) await this.waitForPriorStreamBeforeNextTurn(conversationId, previous)
      this.assertCanStartTurn(conversationId)

      const record = await this.getConversation(conversationId)
      this.assertCanStartTurn(conversationId)
      const retry = resolveRetryTurn(record)

      const hasRetryableContent = retry.userMessage.blocks.some((block) =>
        block.type === 'text'
          ? block.content.trim().length > 0
          : block.type === 'image' || block.type === 'file',
      )
      if (!hasRetryableContent) {
        throw new Error('cannot retry: last persisted user message has no content')
      }

      return this.startAssistantTurn({
        conversationId,
        userMessage: retry.userMessage,
        record: retry.record,
        selection,
        loopMode: input.loopMode ?? 'continuous',
        transientContext,
        source: 'retry',
        turnStartLock,
      })
    })
  }

  async stepRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult> {
    return this.resumeRun({ ...input, loopMode: 'step' })
  }

  async continueRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult> {
    return this.resumeRun({ ...input, loopMode: 'continuous' })
  }

  // Deliberately exempt from availability gating: aborting must work while a
  // turn is active and during shutdown.
  async abortRun(input: RuntimeRunControlInput): Promise<RunSnapshot> {
    this.assertBoundConversation(input.conversationId)
    const active = this.turns.get()
    if (active) {
      if (active.run.runId !== input.runId) {
        throw new Error(`another run is active: ${active.run.runId}`)
      }
      await this.abort(input.conversationId)
    }
    const loaded = await this.getRunSnapshot(input.conversationId, input.runId)
    if (!loaded) {
      throw new Error(`agent run not found in journal: ${input.conversationId}/${input.runId}`)
    }
    if (
      loaded.loop.state.status === 'completed' ||
      loaded.loop.state.status === 'failed' ||
      loaded.loop.state.status === 'cancelled'
    ) {
      return cloneRuntimeValue(loaded)
    }

    const timestamp = this.now()
    await this.recordRunEvent({
      timestamp,
      conversationId: input.conversationId,
      messageId: loaded.assistantMessageId,
      turnId: loaded.identity.turnId,
      runId: loaded.identity.runId,
      type: 'run.cancelled',
      data: { reason: 'user' },
    })
    const saved = await this.getRunSnapshot(input.conversationId, input.runId)
    if (!saved) {
      throw new Error(`agent run not found in journal: ${input.conversationId}/${input.runId}`)
    }
    const record = await this.getConversation(input.conversationId)
    const currentAssistant = record.messages.find(
      (message) => message.id === saved.assistantMessageId && message.role === 'assistant',
    )
    await this.persistAndAnnounce(input.conversationId, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: saved.assistantMessageId,
      role: 'assistant',
      blocks: cloneRuntimeValue(currentAssistant?.blocks ?? []),
      status: 'error',
      error: 'Aborted',
      model: cloneRuntimeValue(saved.selection),
    })
    return saved
  }

  async forkRun(input: RuntimeForkRunInput): Promise<RunSnapshot> {
    await this.assertAvailableStructural(
      input.conversationId,
      'cannot fork a run while an assistant turn is running',
    )
    const sessionTree = await this.store.getSessionTree(input.conversationId)
    const source = await this.getRunSnapshot(input.conversationId, input.runId)
    if (!source) {
      throw new Error(`agent run not found in journal: ${input.conversationId}/${input.runId}`)
    }
    if (source.loop.state.currentStep?.status === 'running') {
      throw new Error('cannot fork while a step is running')
    }
    const timestamp = this.now()
    const runId = this.createRunId()
    const assistantMessageId = this.createId()
    const originStepId =
      input.originStepId ?? source.loop.state.steps[source.loop.state.steps.length - 1]?.stepId
    const identity: RunIdentity = {
      conversationId: input.conversationId,
      turnId: source.identity.turnId,
      runId,
      parentRunId: source.identity.runId,
      ...(originStepId ? { originStepId } : {}),
    }
    const nextAction: RunNextAction = cloneRuntimeValue(
      source.loop.state.nextAction ?? { type: 'model', reason: 'resume' as const },
    )
    const identityData = {
      parentRunId: source.identity.runId,
      ...(originStepId ? { originStepId } : {}),
    }
    // The fork's own events carry the full snapshot metadata so the run
    // rebuilds from the journal without consulting its parent's leaf.
    await this.recordRunEvent({
      timestamp,
      conversationId: input.conversationId,
      messageId: assistantMessageId,
      turnId: identity.turnId,
      runId,
      type: 'run.started',
      data: {
        ...identityData,
        mode: source.loop.state.mode,
        providerId: source.selection.providerId,
        modelId: source.selection.modelId,
        maxToolSteps: source.maxToolSteps,
        sessionLeafId: sessionTree.leafId,
      },
    })
    await this.recordRunEvent({
      timestamp,
      conversationId: input.conversationId,
      messageId: assistantMessageId,
      turnId: identity.turnId,
      runId,
      type: 'run.paused',
      data: {
        ...identityData,
        nextAction,
        wait: { reason: 'operator', detail: 'forked run is ready for inspection' },
      },
    })
    const saved = await this.getRunSnapshot(input.conversationId, runId)
    if (!saved) {
      throw new Error(`forked run not found in journal: ${input.conversationId}/${runId}`)
    }
    return saved
  }

  async resumeRun(input: RuntimeResumeRunInput): Promise<RuntimeSendResult> {
    return this.turns.withStartLock(async (turnStartLock) => {
      this.assertCanStartTurn(input.conversationId)
      const previous = this.turns.get()
      if (previous) {
        await this.waitForPriorStreamBeforeNextTurn(input.conversationId, previous)
      }
      this.assertCanStartTurn(input.conversationId)
      const loaded = await this.getRunSnapshot(input.conversationId, input.runId)
      if (!loaded) {
        throw new Error(`agent run not found in journal: ${input.conversationId}/${input.runId}`)
      }
      const snapshot = cloneRuntimeValue(loaded)
      const sessionTree = await this.store.getSessionTree(input.conversationId)
      if (sessionTree.leafId !== snapshot.sessionLeafId) {
        throw new Error(
          `run belongs to session leaf ${snapshot.sessionLeafId}; current leaf is ${sessionTree.leafId}`,
        )
      }
      const interruptedStep = snapshot.loop.state.currentStep
      const recoveryTimestamp = Math.max(
        snapshot.updatedAt + 1,
        (interruptedStep?.startedAt ?? snapshot.updatedAt) + 1,
      )
      const resumed = prepareRunSnapshotForResume(snapshot, recoveryTimestamp)
      if (interruptedStep?.status === 'running') {
        await this.recordRunEvent({
          timestamp: recoveryTimestamp,
          conversationId: input.conversationId,
          messageId: snapshot.assistantMessageId,
          turnId: snapshot.identity.turnId,
          runId: snapshot.identity.runId,
          stepId: interruptedStep.stepId,
          type: 'step.cancelled',
          data: {
            kind: interruptedStep.kind,
            index: interruptedStep.index,
            attempt: interruptedStep.attempt,
            reason: 'interrupted_before_resume',
          },
        })
        await this.recordRunEvent({
          timestamp: recoveryTimestamp,
          conversationId: input.conversationId,
          messageId: snapshot.assistantMessageId,
          turnId: snapshot.identity.turnId,
          runId: snapshot.identity.runId,
          type: 'run.paused',
          data: {
            nextAction: cloneRuntimeValue(resumed.loop.state.nextAction),
            wait: cloneRuntimeValue(resumed.loop.state.wait),
          },
        })
      }
      const savedCheckpoint = cloneRuntimeValue(resumed)
      const record = await this.getConversation(input.conversationId)
      const userMessage = record.messages.find(
        (message) => message.id === savedCheckpoint.identity.turnId,
      )
      if (!userMessage || userMessage.role !== 'user') {
        throw new Error(`run user message not found: ${savedCheckpoint.identity.turnId}`)
      }
      const resumeState = await this.loadRunResumeState(savedCheckpoint)

      const assistantMessageId = savedCheckpoint.assistantMessageId
      const toolRegistry = await this.getToolRegistry({
        conversationId: input.conversationId,
        record,
      })
      const toolContext = await this.buildToolContext({
        conversationId: input.conversationId,
        record,
        messageId: assistantMessageId,
      })

      const controller = new AbortController()
      let resolveCleanup: () => void = () => {}
      const cleanup = new Promise<void>((resolve) => {
        resolveCleanup = resolve
      })
      await this.setSessionPhase(input.conversationId, 'turn')
      this.activateTurn({
        controller,
        cleanup,
        assistantMessageId,
        run: cloneRuntimeValue(savedCheckpoint.identity),
        selection: cloneRuntimeValue(savedCheckpoint.selection),
        abortRecorded: false,
        cleanupInterruptedRecorded: false,
        turnStartLock,
      })

      void this.runStream({
        conversationId: input.conversationId,
        assistantMessageId,
        run: cloneRuntimeValue(savedCheckpoint.identity),
        selection: cloneRuntimeValue(savedCheckpoint.selection),
        controller,
        resolveCleanup,
        messages: cloneRuntimeChatMessages(resumeState.messages) ?? [],
        contextPlan: cloneRuntimeValue(resumeState.contextPlan),
        toolContext,
        toolRegistry,
        loopMode: input.loopMode ?? 'continuous',
        runSnapshot: savedCheckpoint,
        sessionLeafId: savedCheckpoint.sessionLeafId,
        runContextRef: cloneRuntimeValue(savedCheckpoint.contextRef),
        resumeState,
      })

      return {
        userMessage: cloneRuntimeValue(userMessage),
        assistantMessageId,
        turnId: savedCheckpoint.identity.turnId,
        runId: savedCheckpoint.identity.runId,
      }
    })
  }

  private async loadRunResumeState(snapshot: RunSnapshot): Promise<{
    messages: ChatMessage[]
    contextPlan: AgentContextPlan
    assistantMessage?: PersistedMessage
    modelStepOutputs: Record<string, string>
  }> {
    const contextBlob = await this.store.getBlob(
      snapshot.identity.conversationId,
      snapshot.contextRef.blobId,
    )
    if (!contextBlob || !isRunContextBlobData(contextBlob.data)) {
      throw new Error(`run context blob not found: ${snapshot.contextRef.blobId}`)
    }

    const entries = await this.store.listSessionEntries(snapshot.identity.conversationId)
    const sourceRunId = snapshot.identity.parentRunId ?? snapshot.identity.runId
    let sourcePayloads = sessionRunPayloads(entries, sourceRunId)
    if (snapshot.identity.originStepId) {
      const boundarySeq = sourcePayloads
        .filter((entry) => entry.stepId === snapshot.identity.originStepId)
        .reduce((maximum, entry) => Math.max(maximum, entry.seq), 0)
      if (boundarySeq > 0)
        sourcePayloads = sourcePayloads.filter((entry) => entry.seq <= boundarySeq)
    }
    const ownPayloads =
      sourceRunId === snapshot.identity.runId
        ? []
        : sessionRunPayloads(entries, snapshot.identity.runId)
    const payloads = [...sourcePayloads, ...ownPayloads].sort((left, right) => left.seq - right.seq)
    const messages = cloneRuntimeChatMessages(contextBlob.data.messages) ?? []
    const modelStepOutputs: Record<string, string> = {}
    let assistantMessage: PersistedMessage | undefined

    for (const payload of payloads) {
      if (payload.data.modelMessages && payload.data.modelMessages.length > 0) {
        messages.push(...cloneRuntimeValue(payload.data.modelMessages))
      } else if (payload.data.modelMessage) {
        messages.push(cloneRuntimeValue(payload.data.modelMessage))
      }
      if (payload.data.assistantMessage) {
        assistantMessage = {
          ...cloneRuntimeValue(payload.data.assistantMessage),
          id: snapshot.assistantMessageId,
          status: 'streaming',
          error: undefined,
        }
      }
      if (payload.data.kind !== 'model_response' || !payload.payloadRef) {
        continue
      }
      const blob = await this.store.getBlob(
        snapshot.identity.conversationId,
        payload.payloadRef.blobId,
      )
      if (!blob?.data || typeof blob.data !== 'object') continue
      const data = blob.data as Record<string, unknown>
      if (typeof data.modelStepIndex === 'number' && typeof data.text === 'string') {
        modelStepOutputs[String(data.modelStepIndex)] = data.text
      }
    }

    return {
      messages,
      contextPlan: cloneRuntimeValue(contextBlob.data.contextPlan),
      ...(assistantMessage ? { assistantMessage } : {}),
      modelStepOutputs,
    }
  }

  private async startAssistantTurn(input: {
    conversationId: string
    userMessage: PersistedMessage
    record: ConversationRecord
    selection: ModelSelection
    loopMode?: 'continuous' | 'step'
    transientContext?: ChatMessage[]
    source: RuntimeTransientContextInput['source']
    turnStartLock: TurnStartLock
  }): Promise<RuntimeSendResult> {
    const {
      conversationId,
      userMessage,
      record,
      loopMode = 'continuous',
      transientContext,
      source,
      turnStartLock,
    } = input
    const selection = cloneRuntimeValue(input.selection)
    const assistantMessageId = this.createId()
    const run: RunIdentity = {
      conversationId,
      turnId: userMessage.id,
      runId: this.createRunId(),
    }
    this.assertCanStartTurn(conversationId)
    this.lifecycle.dispatch('turn', 'onStarting', {
      conversationId,
      turnId: run.turnId,
      runId: run.runId,
      assistantMessageId,
      source,
    })
    await this.setSessionPhase(conversationId, source === 'retry' ? 'retry' : 'turn')

    const controller = new AbortController()
    let resolveCleanup: () => void = () => {}
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve
    })
    this.activateTurn({
      controller,
      cleanup,
      assistantMessageId,
      run,
      selection,
      abortRecorded: false,
      cleanupInterruptedRecorded: false,
      turnStartLock,
    })

    let streamStarted = false
    let messages: ChatMessage[]
    let contextPlan: AgentContextPlan
    let runContextRef: BlobRef
    let sessionLeafId: string
    let toolContext: ToolContext
    let toolRegistry: ToolRegistry
    try {
      if (!this.host.runAgent) throw new Error('runtime host cannot execute agent runs')
      const contextInput = {
        conversationId,
        record,
        selection,
        source,
      }
      const inputTransientContext = cloneRuntimeChatMessages(transientContext)
      const [resolvedStableInstructions, hostTransientContext] = await Promise.all([
        this.resolveStableInstructions(contextInput),
        inputTransientContext === undefined
          ? this.resolveTransientContext(contextInput)
          : Promise.resolve(undefined),
      ])
      const resolvedDynamicContext = inputTransientContext ?? hostTransientContext
      const context = assembleAgentContext({
        stableInstructions: resolvedStableInstructions,
        messages: cloneRuntimeValue(record.messages),
        modelInfo: await this.resolveModelInfo(selection),
        providerId: selection.providerId,
        dynamicContext: resolvedDynamicContext,
        compactionCheckpoint: record.meta.context?.checkpoint,
      })
      messages = context.messages
      contextPlan = await this.applyContextTokenPreflight({
        conversationId,
        assistantMessageId,
        selection,
        messages,
        contextPlan: context.plan,
      })
      this.lifecycle.dispatch('context', 'onAssembled', {
        conversationId,
        runId: run.runId,
        plan: contextPlan,
      })
      await this.persistRecommendedContextCheckpoint({
        conversationId,
        assistantMessageId,
        record,
        selection,
        contextPlan,
      })
      sessionLeafId = (await this.store.getSessionTree(conversationId)).leafId
      runContextRef = await this.store.putBlob(conversationId, {
        blobId: `run-context:${run.runId}`,
        contentType: 'application/json',
        data: {
          messages: cloneRuntimeChatMessages(messages) ?? [],
          contextPlan: cloneRuntimeValue(contextPlan),
        } satisfies RunContextBlobData,
      })
      toolRegistry = await this.getToolRegistry({ conversationId, record })
      toolContext = await this.buildToolContext({
        conversationId,
        record,
        messageId: assistantMessageId,
      })
      if (!this.acceptsStreamEvents(conversationId, controller)) {
        return { userMessage, assistantMessageId, turnId: run.turnId, runId: run.runId }
      }
      if (controller.signal.aborted) {
        await this.persistSetupCancellation(conversationId, assistantMessageId, run, selection)
        return { userMessage, assistantMessageId, turnId: run.turnId, runId: run.runId }
      }
      this.assertCanStartTurn(conversationId)
      streamStarted = true
    } catch (error) {
      if (controller.signal.aborted) {
        await this.persistSetupCancellation(conversationId, assistantMessageId, run, selection)
      } else {
        await this.persistSetupFailure(
          conversationId,
          assistantMessageId,
          run,
          selection,
          errorMessage(error),
        )
      }
      this.assertConversationOpen(conversationId)
      return { userMessage, assistantMessageId, turnId: run.turnId, runId: run.runId }
    } finally {
      if (!streamStarted) {
        await this.flushPendingSessionWrites(conversationId).catch((error) => {
          this.logger.warn('[runtime] pending session write flush failed:', error)
        })
        await this.setSessionPhase(conversationId, 'idle').catch((error) => {
          this.logger.warn('[runtime] idle phase persistence failed:', error)
        })
        this.deactivateTurnWhere((turn) => turn.controller === controller)
        resolveCleanup()
      }
    }

    void this.runStream({
      conversationId,
      assistantMessageId,
      run,
      selection,
      controller,
      resolveCleanup,
      messages,
      contextPlan,
      toolContext,
      toolRegistry,
      loopMode,
      sessionLeafId,
      runContextRef,
    })

    return { userMessage, assistantMessageId, turnId: run.turnId, runId: run.runId }
  }

  // Deliberately exempt from availability gating (see abortRun).
  async abort(conversationId: string): Promise<void> {
    this.assertBoundConversation(conversationId)
    this.clearActiveInputQueues()
    const slot = this.turns.get()
    if (!slot) return
    slot.controller.abort()
    const abortCleanup = this.notifyConversationAbort(conversationId, 'user')
    await this.recordCancellationRequest(conversationId, slot, 'user')
    await abortCleanup
    try {
      await this.waitForAbortedStreamCleanup(conversationId, slot, 'user cleanup timed out')
    } catch (err) {
      this.logger.warn('[runtime] interrupted abort activity append failed:', err)
    }
  }

  resetRecoveredPhase(): void {
    this.sessionPhase = undefined
  }

  /**
   * Pure availability derivation from the engine's three live sources:
   * shutdown flag, deleted flag and the turn coordinator, given a phase.
   * Advisory for clients; the assert* guards remain authoritative.
   */
  private computeAvailability(phase: SessionPhase): RuntimeSessionAvailability {
    const activeTurn = this.listActiveTurns()[0] ?? null
    const blocked = this.shutdownStarted
      ? 'shutdown'
      : this.deleted
        ? 'deleted'
        : activeTurn
          ? 'turn_active'
          : phase !== 'idle'
            ? 'phase_busy'
            : null
    const open = !this.shutdownStarted && !this.deleted
    const idle = blocked === null
    return {
      conversationId: this.conversationId,
      phase,
      activeTurn,
      blocked,
      allows: {
        startTurn: idle,
        mutateSession: idle,
        resumeRun: idle,
        steer: open && activeTurn !== null,
        followUp: open && activeTurn !== null,
        nextTurn: open,
        abort: activeTurn !== null,
      },
    }
  }

  async getAvailability(conversationId: string): Promise<RuntimeSessionAvailability> {
    this.assertBoundConversation(conversationId)
    const phase = this.sessionPhase ?? (await this.store.getSessionTree(this.conversationId)).phase
    return this.computeAvailability(phase)
  }

  /** Emits session:availability only when the snapshot materially changed. */
  private emitAvailability(phase?: SessionPhase): void {
    const snapshot = this.computeAvailability(phase ?? this.sessionPhase ?? 'idle')
    const key = [
      snapshot.phase,
      snapshot.activeTurn?.runId ?? '',
      snapshot.blocked ?? '',
      Object.values(snapshot.allows)
        .map((allowed) => (allowed ? '1' : '0'))
        .join(''),
    ].join('|')
    if (key === this.lastAvailabilityKey) return
    this.lastAvailabilityKey = key
    this.emit(createWorkbenchEvent('session:availability', snapshot))
  }

  private activateTurn(slot: StreamSlot): void {
    this.turns.set(slot)
    this.emitAvailability()
  }

  private deactivateTurnWhere(predicate: (turn: StreamSlot) => boolean): boolean {
    const removed = this.turns.deleteWhere(predicate)
    if (removed) this.emitAvailability()
    return removed
  }

  private clearTimedOutTurn(slot: StreamSlot): void {
    this.turns.clearTimedOut(slot)
    this.emitAvailability()
  }

  async waitForIdle(conversationId: string): Promise<void> {
    this.assertBoundConversation(conversationId)
    await this.turns.get()?.cleanup
  }

  listActiveTurns(): ActiveAssistantTurn[] {
    return this.turns.entries().map(([conversationId, slot]) => ({
      conversationId,
      assistantMessageId: slot.assistantMessageId,
      turnId: slot.run.turnId,
      runId: slot.run.runId,
      selection: cloneRuntimeValue(slot.selection),
    }))
  }

  async abortAll(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    this.clearActiveInputQueues()
    const cleanupTimeoutMs =
      this.options.abortAllCleanupTimeoutMs ?? DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS
    await Promise.all(
      this.turns.entries().map(async ([conversationId, slot]) => {
        slot.controller.abort()
        const abortCleanup = this.notifyConversationAbort(conversationId, reason)
        await this.recordCancellationRequest(conversationId, slot, reason)
        await abortCleanup
        try {
          await this.waitForAbortedStreamCleanup(
            conversationId,
            slot,
            `${reason} cleanup timed out`,
            cleanupTimeoutMs,
          )
        } catch (err) {
          this.logger.warn('[runtime] interrupted shutdown activity append failed:', err)
        }
      }),
    )
  }

  shutdown(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    this.shutdownStarted = true
    this.emitAvailability()
    if (!this.shutdownPromise) this.shutdownPromise = this.abortAll(reason)
    return this.shutdownPromise
  }

  // Deliberately exempt from availability gating: deletion tears down any
  // active turn itself.
  async deleteConversation(conversationId: string): Promise<void> {
    this.assertBoundConversation(conversationId)
    this.deleted = true
    this.clearActiveInputQueues()
    let removed = false
    const slot = this.turns.get()
    let streamCleanupTimedOut = false
    try {
      if (slot) {
        slot.controller.abort()
        await this.notifyConversationAbort(conversationId, 'delete')
        const cleanedUp = await this.waitForStreamCleanup(
          slot,
          this.options.abortAllCleanupTimeoutMs ?? DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS,
        )
        streamCleanupTimedOut = !cleanedUp
        if (!cleanedUp) {
          this.clearTimedOutTurn(slot)
        }
      } else {
        await this.notifyConversationAbort(conversationId, 'delete')
      }

      await this.cleanupConversationAssets(conversationId)

      await this.store.deleteConversation(conversationId)
      this.sessionPhase = undefined
      this.pendingSessionWrites = []
      this.nextTurnQueue = []
      this.emitQueueUpdate()
      removed = true
      this.lifecycle.dispatch('session', 'onDeleted', { conversationId })
    } catch (error) {
      this.deleted = false
      if (slot) {
        try {
          await this.recordCancellationRequest(conversationId, slot, 'delete')
          if (streamCleanupTimedOut) {
            await this.recordInterruptedStreamCleanup(
              conversationId,
              slot,
              'delete cleanup timed out',
            )
          }
        } catch (err) {
          this.logger.warn('[runtime] delete failure activity append failed:', err)
        }
      }
      throw error
    } finally {
      if (!removed) this.deleted = false
      this.emitAvailability()
    }
  }

  private async persistAndAnnounce(
    conversationId: string,
    message: PersistedMessage,
  ): Promise<boolean> {
    if (this.deleted) return false
    const appended = await this.store.appendSessionEntry(conversationId, {
      type: 'message.committed',
      timestamp: this.now(),
      data: { message: cloneRuntimePersistedMessage(message) },
    })
    const summary = cloneRuntimeConversationSummary(appended.summary)
    if (this.deleted) return false
    this.emit(createWorkbenchEvent('conversations:updated', summary))
    this.lifecycle.dispatch('turn', 'onCommitted', { conversationId, message })
    return true
  }

  private async persistAttachments(
    conversationId: string,
    attachments: readonly ChatAttachmentInput[],
  ): Promise<RuntimeAttachmentBlock[]> {
    const blocks: RuntimeAttachmentBlock[] = []
    for (const attachment of attachments) {
      const input = cloneRuntimeValue({ ...attachment, conversationId })
      if (this.host.persistAttachment) {
        blocks.push(
          assertRuntimeAttachmentBlock(cloneRuntimeValue(await this.host.persistAttachment(input))),
        )
      } else if (input.kind === 'text') {
        blocks.push({ type: 'file', name: input.name, content: input.data })
      } else {
        throw new Error('runtime host cannot persist image attachments')
      }
    }
    return blocks
  }

  private async persistSetupFailure(
    conversationId: string,
    assistantMessageId: string,
    run: RunIdentity,
    selection: ModelSelection,
    message: string,
  ): Promise<void> {
    const errored: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: assistantMessageId,
      role: 'assistant',
      blocks: [],
      status: 'error',
      error: message,
      model: selection,
    }
    const persisted = await this.persistAndAnnounce(conversationId, errored)
    if (!persisted) return
    try {
      await this.recordRunEvent(
        withTurnSelection(
          {
            timestamp: this.now(),
            conversationId,
            messageId: assistantMessageId,
            turnId: run.turnId,
            runId: run.runId,
            eventId: this.createEventId(),
            type: 'turn.failed',
            data: { phase: 'setup', error: message },
          },
          selection,
        ),
      )
    } catch (error) {
      this.logger.warn('[runtime] setup failure activity append failed:', error)
    }
    if (this.deleted) return
    this.emit(
      createWorkbenchEvent('chat:error', {
        conversationId,
        messageId: assistantMessageId,
        error: message,
        message: errored,
      }),
    )
  }

  private async persistSetupCancellation(
    conversationId: string,
    assistantMessageId: string,
    run: RunIdentity,
    selection: ModelSelection,
  ): Promise<void> {
    const errored: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: assistantMessageId,
      role: 'assistant',
      blocks: [],
      status: 'error',
      error: 'Aborted',
      model: selection,
    }
    const persisted = await this.persistAndAnnounce(conversationId, errored)
    if (!persisted) return
    try {
      await this.recordRunEvent(
        withTurnSelection(
          {
            timestamp: this.now(),
            conversationId,
            messageId: assistantMessageId,
            turnId: run.turnId,
            runId: run.runId,
            eventId: this.createEventId(),
            type: 'turn.cancelled',
            data: { phase: 'completed', reason: 'abort_signal' },
          },
          selection,
        ),
      )
    } catch (error) {
      this.logger.warn('[runtime] setup cancellation activity append failed:', error)
    }
    if (this.deleted) return
    this.emit(
      createWorkbenchEvent('chat:error', {
        conversationId,
        messageId: assistantMessageId,
        error: 'Aborted',
        message: errored,
      }),
    )
  }

  private emit(event: WorkbenchEvent): void {
    this.services.emit(event)
    this.onSessionEvent?.(cloneRuntimeValue(event))
  }

  private emitStreamEvent(
    conversationId: string,
    controller: AbortController,
    event: WorkbenchEvent,
  ): void {
    if (!this.acceptsStreamEvents(conversationId, controller)) return
    this.emit(event)
  }

  async recordRunEvent(event: RuntimeRecordRunEventInput): Promise<boolean> {
    return (await this.recordRunEventWithResult(event)) !== null
  }

  private async recordRunEventWithResult(
    event: RuntimeRecordRunEventInput,
  ): Promise<RunEventAppendResult | null> {
    if (this.deleted) return null
    const appended = await this.store.appendSessionEntry(event.conversationId, {
      type: 'run.event',
      timestamp: event.timestamp,
      entryId: event.eventId,
      turnId: event.turnId,
      runId: event.runId,
      stepId: event.stepId,
      data: { event: cloneRuntimeValue(event) },
    })
    if (appended.entry.type !== 'run.event') throw new Error('invalid run event journal append')
    const result: RunEventAppendResult = {
      event: cloneRuntimeValue(appended.entry.data.event) as PersistedRunEvent,
      summary: cloneRuntimeConversationSummary(appended.summary),
    }
    if (this.deleted) return null
    const { event: persisted, summary } = result
    this.emit(createWorkbenchEvent('run:event', persisted))
    if (summary) this.emit(createWorkbenchEvent('conversations:updated', summary))
    this.lifecycle.dispatchFromRunEvent(event.conversationId, persisted)
    return result
  }

  private async resolveModelInfo(selection: ModelSelection): Promise<ModelInfo> {
    const resolved = await this.host.getModelInfo?.(cloneRuntimeValue(selection))
    // Only scalars are read off the host's result; no defensive copy needed.
    const modelInfo = resolved ?? { ...FALLBACK_MODEL_CONTEXT, model: selection.modelId }
    return {
      model: typeof modelInfo.model === 'string' ? modelInfo.model : selection.modelId,
      contextLength:
        typeof modelInfo.contextLength === 'number' && modelInfo.contextLength > 0
          ? modelInfo.contextLength
          : null,
    }
  }

  private async buildToolContext(input: RuntimeToolContextInput): Promise<ToolContext> {
    return this.services.buildToolContext(input)
  }

  private async resolveTransientContext(
    input: RuntimeTransientContextInput,
  ): Promise<ChatMessage[] | undefined> {
    if (!this.host.loadTransientContext) return undefined
    return cloneRuntimeChatMessages(
      await this.host.loadTransientContext({
        ...input,
        record: cloneRuntimeConversationRecord(input.record),
        selection: cloneRuntimeValue(input.selection),
      }),
    )
  }

  private async resolveStableInstructions(
    input: RuntimeStableInstructionsInput,
  ): Promise<ChatMessage[] | undefined> {
    if (!this.host.loadStableInstructions) return undefined
    return cloneRuntimeChatMessages(
      await this.host.loadStableInstructions({
        ...input,
        record: cloneRuntimeConversationRecord(input.record),
        selection: cloneRuntimeValue(input.selection),
      }),
    )
  }

  private cleanupTimeoutMs(): number {
    return this.options.abortAllCleanupTimeoutMs ?? DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS
  }

  private assertBoundConversation(conversationId: string): void {
    if (conversationId !== this.conversationId) {
      throw new Error(
        `session runtime is bound to ${this.conversationId}, received ${conversationId}`,
      )
    }
  }

  private assertQueueMode(mode: SessionInputQueueMode): void {
    if (mode !== 'one-at-a-time' && mode !== 'all') {
      throw new Error(`invalid session input queue mode: ${String(mode)}`)
    }
  }

  private createQueuedSessionInput(text: string): QueuedSessionInput {
    if (!text.trim()) throw new Error('queued input text is required')
    const message: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: this.createId(),
      role: 'user',
      blocks: [{ type: 'text', content: text }],
      status: 'done',
    }
    return {
      message,
      chatMessage: { role: 'user', content: text },
    }
  }

  private emitQueueUpdate(): void {
    this.emit(createWorkbenchEvent('session:queue-updated', this.getInputQueueState()))
  }

  private clearActiveInputQueues(): void {
    if (this.steeringQueue.length === 0 && this.followUpQueue.length === 0) return
    this.steeringQueue = []
    this.followUpQueue = []
    this.emitQueueUpdate()
  }

  private async drainQueuedInputs(
    kind: 'steering' | 'followUp' | 'nextTurn',
    onPersisted?: (input: { lastSeq: number; sessionLeafId: string }) => void,
  ): Promise<ChatMessage[]> {
    const queue =
      kind === 'steering'
        ? this.steeringQueue
        : kind === 'followUp'
          ? this.followUpQueue
          : this.nextTurnQueue
    const mode =
      kind === 'steering'
        ? this.steeringQueueMode
        : kind === 'followUp'
          ? this.followUpQueueMode
          : 'all'
    const count = mode === 'all' ? queue.length : Math.min(1, queue.length)
    if (count === 0) return []
    const drained = queue.splice(0, count)
    try {
      let lastSeq = 0
      for (const queued of drained) {
        const appended = await this.store.appendSessionEntry(this.conversationId, {
          type: 'message.committed',
          entryId: `queued-message:${queued.message.id}`,
          timestamp: this.now(),
          data: { message: cloneRuntimePersistedMessage(queued.message) },
        })
        lastSeq = Math.max(lastSeq, appended.entry.seq)
        this.emit(
          createWorkbenchEvent(
            'conversations:updated',
            cloneRuntimeConversationSummary(appended.summary),
          ),
        )
      }
      const sessionLeafId = (await this.store.getSessionTree(this.conversationId)).leafId
      onPersisted?.({ lastSeq, sessionLeafId })
      this.emitQueueUpdate()
      return drained.map((queued) => cloneRuntimeValue(queued.chatMessage))
    } catch (error) {
      queue.unshift(...drained)
      this.emitQueueUpdate()
      throw error
    }
  }

  private assertConversationOpen(conversationId: string): void {
    this.assertBoundConversation(conversationId)
    if (this.deleted) {
      throw new Error('conversation was deleted')
    }
  }

  private assertCanStartTurn(conversationId: string): void {
    if (this.shutdownStarted) throw new Error('runtime is shut down')
    this.assertConversationOpen(conversationId)
  }

  private async setSessionPhase(conversationId: string, phase: SessionPhase): Promise<number> {
    const previous = this.sessionPhase
    this.sessionPhase = phase
    try {
      const appended = await this.store.appendSessionEntry(conversationId, {
        type: 'session.phase.changed',
        timestamp: this.now(),
        data: { phase },
      })
      this.emitAvailability(phase)
      this.lifecycle.dispatch('session', 'onPhaseChanged', {
        conversationId,
        phase,
        previous: previous ?? null,
      })
      return appended.entry.seq
    } catch (error) {
      this.sessionPhase = previous
      throw error
    }
  }

  private async requireIdleSession(conversationId: string): Promise<void> {
    const tree = await this.store.getSessionTree(conversationId)
    if (tree.phase !== 'idle') {
      throw new Error(
        `session structural operation requires idle phase; current phase is ${tree.phase}`,
      )
    }
  }

  /**
   * Structural-operation guard: the availability sources (shutdown/deleted,
   * active turn, journal phase) checked in one place. busyMessage keeps each
   * call site's historical error string.
   */
  private async assertAvailableStructural(
    conversationId: string,
    busyMessage: string,
  ): Promise<void> {
    this.assertCanStartTurn(conversationId)
    if (this.turns.has()) {
      throw new Error(busyMessage)
    }
    await this.requireIdleSession(conversationId)
  }

  private async appendOrQueueSessionWrite(
    conversationId: string,
    entry: SessionEntryInput,
  ): Promise<void> {
    this.assertCanStartTurn(conversationId)
    const phase = this.sessionPhase ?? (await this.store.getSessionTree(conversationId)).phase
    if (phase === 'idle') {
      // Store boundary clones on prepare; no engine-side copy needed.
      await this.store.appendSessionEntry(conversationId, entry)
      return
    }
    // Clone once at enqueue: the caller keeps its object, the queue owns this one.
    this.pendingSessionWrites.push(cloneRuntimeValue(entry))
  }

  private async flushPendingSessionWrites(conversationId: string): Promise<number | null> {
    const pending = this.pendingSessionWrites
    if (pending.length === 0) return null
    this.pendingSessionWrites = []
    let lastSeq: number | null = null
    for (let index = 0; index < pending.length; index += 1) {
      try {
        const appended = await this.store.appendSessionEntry(
          conversationId,
          pending[index] as SessionEntryInput,
        )
        lastSeq = appended.entry.seq
      } catch (error) {
        this.pendingSessionWrites = pending.slice(index)
        throw error
      }
    }
    return lastSeq
  }

  private async waitForPriorStreamBeforeNextTurn(
    conversationId: string,
    slot: StreamSlot,
  ): Promise<void> {
    if (!slot.controller.signal.aborted) {
      await slot.cleanup.catch(() => {})
      return
    }

    const cleanedUp = await this.waitForStreamCleanup(slot, this.cleanupTimeoutMs())
    if (cleanedUp) return

    this.clearTimedOutTurn(slot)
    await this.recordInterruptedStreamCleanup(conversationId, slot, 'aborted cleanup timed out')
  }

  private async waitForAbortedStreamCleanup(
    conversationId: string,
    slot: StreamSlot,
    interruptedReason: string,
    timeoutMs = this.cleanupTimeoutMs(),
  ): Promise<void> {
    const cleanedUp = await this.waitForStreamCleanup(slot, timeoutMs)
    if (cleanedUp) return

    this.clearTimedOutTurn(slot)
    await this.recordInterruptedStreamCleanup(conversationId, slot, interruptedReason)
  }

  private async recordCancellationRequest(
    conversationId: string,
    slot: StreamSlot,
    reason: ConversationAbortReason,
  ): Promise<void> {
    if (slot.abortRecorded) return
    slot.abortRecorded = true
    try {
      await this.recordRunEvent(
        withTurnSelection(
          {
            timestamp: this.now(),
            conversationId,
            messageId: slot.assistantMessageId,
            turnId: slot.run.turnId,
            runId: slot.run.runId,
            eventId: this.createEventId(),
            type: 'turn.cancelled',
            data: { phase: 'requested', reason },
          },
          slot.selection,
        ),
      )
    } catch (err) {
      this.logger.warn('[runtime] cancellation activity append failed:', err)
    }
  }

  private async recordInterruptedStreamCleanup(
    conversationId: string,
    slot: StreamSlot,
    reason: string,
  ): Promise<void> {
    if (slot.cleanupInterruptedRecorded) return
    slot.cleanupInterruptedRecorded = true
    await this.recordRunEvent(
      withTurnSelection(
        {
          timestamp: this.now(),
          conversationId,
          messageId: slot.assistantMessageId,
          turnId: slot.run.turnId,
          runId: slot.run.runId,
          eventId: this.createEventId(),
          type: 'turn.interrupted',
          data: {
            reason,
            previousState: 'cancelled',
            previousEventType: 'turn.cancelled',
            previousTitle: 'Stop requested',
          },
        },
        slot.selection,
      ),
    )
  }

  private acceptsStreamEvents(_conversationId: string, controller: AbortController): boolean {
    if (this.deleted) return false
    return this.turns.get()?.controller === controller
  }

  private async notifyConversationAbort(
    conversationId: string,
    reason: ConversationAbortReason,
  ): Promise<void> {
    try {
      await this.host.onConversationAbort?.(conversationId, reason)
    } catch (error) {
      this.logger.warn('[runtime] conversation abort cleanup failed:', error)
    }
  }

  private async cleanupConversationAssets(conversationId: string): Promise<void> {
    if (!this.host.cleanupConversationAssets) return
    try {
      const record = await this.store.getConversation(conversationId)
      await this.host.cleanupConversationAssets(cloneRuntimeConversationRecord(record))
    } catch (err) {
      this.logger.warn('[runtime] conversation asset cleanup failed:', err)
    }
  }

  private async waitForStreamCleanup(slot: StreamSlot, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        slot.cleanup.catch(() => {}).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async applyContextTokenPreflight(
    input: RuntimeContextTokenCountInput,
  ): Promise<AgentContextPlan> {
    if (!this.host.countContextTokens) return input.contextPlan
    try {
      const counted = await this.host.countContextTokens({
        ...input,
        selection: cloneRuntimeValue(input.selection),
        messages: cloneRuntimeChatMessages(input.messages) ?? [],
        contextPlan: cloneRuntimeValue(input.contextPlan),
      })
      if (!counted || typeof counted.inputTokens !== 'number' || counted.inputTokens < 0) {
        return input.contextPlan
      }
      const preflight: AgentContextTokenPreflight = {
        inputTokens: counted.inputTokens,
        method: counted.method ?? 'provider_preflight',
        providerId: counted.providerId ?? input.selection.providerId,
        model: counted.model ?? input.selection.modelId,
        countedAt: this.now(),
      }
      return applyAgentContextTokenPreflight(input.contextPlan, preflight)
    } catch (error) {
      this.logger.warn('[runtime] context token preflight failed:', error)
      return input.contextPlan
    }
  }

  private async resolveSemanticCompactArtifact(input: {
    conversationId: string
    record: ConversationRecord
    selection: ModelSelection
    recommended: AgentContextRecommendedCheckpoint
  }): Promise<RuntimeSemanticCompactArtifact> {
    const heuristic = (
      fallbackReason: RuntimeCompactArtifactFallbackReason,
    ): RuntimeSemanticCompactArtifact => ({
      artifact: cloneRuntimeValue(input.recommended.artifact),
      summary: input.recommended.summary,
      source: 'heuristic',
      fallbackReason,
    })

    if (!this.host.generateContextCompactArtifact) {
      return heuristic('missing_hook')
    }
    try {
      const sourceIdSet = new Set(input.recommended.sourceMessageIds)
      const generated = await this.host.generateContextCompactArtifact({
        conversationId: input.conversationId,
        selection: cloneRuntimeValue(input.selection),
        activeCheckpoint: cloneRuntimeValue(input.record.meta.context?.checkpoint),
        recommendedCheckpoint: cloneRuntimeValue(input.recommended),
        sourceMessages: cloneRuntimeValue(
          input.record.messages.filter((message) => sourceIdSet.has(message.id)),
        ),
      })
      if (!generated) return heuristic('empty_result')
      const artifact = normalizeConversationCompactArtifact(generated?.artifact)
      if (!artifact) {
        return heuristic('invalid_artifact')
      }
      const summary =
        typeof generated?.summary === 'string' && generated.summary.trim().length > 0
          ? generated.summary.trim()
          : artifact.summary || input.recommended.summary
      return { artifact, summary, source: 'model' }
    } catch (error) {
      this.logger.warn('[runtime] semantic context compact artifact generation failed:', error)
      return heuristic('error')
    }
  }

  private async persistRecommendedContextCheckpoint(input: {
    conversationId: string
    assistantMessageId: string
    record: ConversationRecord
    selection: ModelSelection
    contextPlan: AgentContextPlan
  }): Promise<void> {
    const { conversationId, assistantMessageId, record, selection, contextPlan } = input
    const recommended = contextPlan.compaction.recommendedCheckpoint
    if (!recommended) return
    await this.persistContextCheckpoint({
      conversationId,
      messageId: assistantMessageId,
      record,
      selection,
      contextPlan,
      recommended,
    })
  }

  private async persistContextCheckpoint(input: {
    conversationId: string
    messageId: string
    record: ConversationRecord
    selection: ModelSelection
    contextPlan: AgentContextPlan
    recommended: AgentContextRecommendedCheckpoint
    reason?: string | null
    trigger?: 'auto' | 'manual'
  }): Promise<ConversationContextCheckpoint | null> {
    const { conversationId, messageId, record, selection, contextPlan, recommended } = input
    this.lifecycle.dispatch('context', 'onCompacting', {
      conversationId,
      trigger: input.trigger ?? 'auto',
    })
    await this.recordContextCompactionEvent({
      conversationId,
      messageId,
      selection,
      type: 'context.compacting',
      contextPlan,
      recommended,
      reason: input.reason ?? contextPlan.compaction.reason,
      trigger: input.trigger ?? 'auto',
    })
    const semantic = await this.resolveSemanticCompactArtifact({
      conversationId,
      record,
      selection,
      recommended,
    })
    const checkpoint: ConversationContextCheckpoint = {
      schemaVersion: AILA_CONTEXT_CHECKPOINT_SCHEMA_VERSION,
      id: recommended.id,
      createdAt: this.now(),
      boundaryMessageId: recommended.boundaryMessageId,
      sourceMessageIds: cloneRuntimeValue(recommended.sourceMessageIds),
      omittedRoundCount: recommended.omittedRoundCount,
      summary: semantic.summary,
      charCost: JSON.stringify([{ role: 'system', content: semantic.summary }]).length,
      artifact: cloneRuntimeValue(semantic.artifact),
    }
    try {
      const appended = await this.store.appendSessionEntry(conversationId, {
        type: 'context.compacted',
        timestamp: checkpoint.createdAt,
        data: { checkpoint: cloneRuntimeValue(checkpoint) },
      })
      const summary = cloneRuntimeConversationSummary(appended.summary)
      this.emit(createWorkbenchEvent('conversations:updated', summary))
      await this.recordContextCompactionEvent({
        conversationId,
        messageId,
        selection,
        type: 'context.compacted',
        contextPlan,
        recommended,
        checkpoint,
        semantic,
        reason: input.reason ?? contextPlan.compaction.reason,
        trigger: input.trigger ?? 'auto',
      })
      this.lifecycle.dispatch('context', 'onCompacted', {
        conversationId,
        trigger: input.trigger ?? 'auto',
        checkpoint,
      })
      return checkpoint
    } catch (error) {
      this.logger.warn('[runtime] context checkpoint persistence failed:', error)
      return null
    }
  }

  private async recordContextCompactionEvent(input: {
    conversationId: string
    messageId: string
    selection: ModelSelection
    type: 'context.compacting' | 'context.compacted'
    contextPlan: AgentContextPlan
    recommended: AgentContextRecommendedCheckpoint
    checkpoint?: ConversationContextCheckpoint
    semantic?: RuntimeSemanticCompactArtifact
    reason?: string | null
    trigger?: 'auto' | 'manual'
  }): Promise<void> {
    const { conversationId, messageId, selection, type, contextPlan, recommended } = input
    const charsPerToken =
      contextPlan.ledger.estimator.charsPerToken > 0
        ? contextPlan.ledger.estimator.charsPerToken
        : 4
    const checkpointCharCost = input.checkpoint?.charCost ?? recommended.charCost
    const checkpointEstimatedTokens = Math.max(0, Math.ceil(checkpointCharCost / charsPerToken))
    const estimatedSavedTokens = Math.max(
      0,
      recommended.sourceEstimatedTokens - checkpointEstimatedTokens,
    )
    try {
      await this.recordRunEvent({
        timestamp: this.now(),
        conversationId,
        messageId,
        type,
        data: {
          providerId: selection.providerId,
          modelId: selection.modelId,
          checkpointId: recommended.id,
          activeCheckpointId: contextPlan.compaction.activeCheckpointId,
          boundaryMessageId: recommended.boundaryMessageId,
          reason: input.reason ?? contextPlan.compaction.reason,
          trigger: input.trigger ?? 'auto',
          omittedRoundCount: recommended.omittedRoundCount,
          sourceMessageCount: recommended.sourceMessageIds.length,
          selectedRoundCount: contextPlan.compaction.selectedRoundCount,
          sourceCharCost: recommended.sourceCharCost,
          sourceEstimatedTokens: recommended.sourceEstimatedTokens,
          checkpointCharCost,
          checkpointEstimatedTokens,
          estimatedSavedTokens,
          estimatedInputTokens: contextPlan.ledger.totalEstimatedTokens,
          inputBudgetTokens: contextPlan.ledger.inputBudgetTokens,
          remainingInputTokens:
            contextPlan.budget.remainingPreflightInputTokens ??
            contextPlan.ledger.remainingInputTokens,
          ...(contextPlan.ledger.preflight
            ? { preflightInputTokens: contextPlan.ledger.preflight.inputTokens }
            : {}),
          ...(input.checkpoint
            ? {
                compactArtifactSource: input.semantic?.source ?? 'heuristic',
                ...(input.semantic?.fallbackReason
                  ? { compactArtifactFallbackReason: input.semantic.fallbackReason }
                  : {}),
                summaryChars: input.checkpoint.summary.length,
                artifactFileCount: input.checkpoint.artifact?.files.length ?? 0,
                artifactToolResultCount: input.checkpoint.artifact?.toolResults.length ?? 0,
              }
            : {}),
        },
      })
    } catch (error) {
      this.logger.warn('[runtime] context compaction activity append failed:', error)
    }
  }

  private createContextTurnLedgerEntry(input: {
    assistantMessageId: string
    selection: ModelSelection
    contextPlan: AgentContextPlan
    usage?: UsageInfo
  }): ConversationContextTurnLedgerEntry {
    const { assistantMessageId, selection, contextPlan, usage } = input
    return {
      schemaVersion: AILA_CONTEXT_TURN_LEDGER_SCHEMA_VERSION,
      messageId: assistantMessageId,
      createdAt: this.now(),
      providerId: selection.providerId,
      modelId: selection.modelId,
      estimatedInputTokens: contextPlan.ledger.totalEstimatedTokens,
      inputBudgetTokens: contextPlan.ledger.inputBudgetTokens,
      remainingInputTokens:
        contextPlan.budget.remainingPreflightInputTokens ?? contextPlan.ledger.remainingInputTokens,
      sectionCount: contextPlan.ledger.entries.length,
      sections: contextPlan.ledger.entries.map((entry) => ({
        kind: entry.kind,
        messageCount: entry.messageCount,
        charCost: entry.charCost,
        estimatedTokens: entry.estimatedTokens,
      })),
      ...(contextPlan.ledger.preflight
        ? { preflight: cloneRuntimeValue(contextPlan.ledger.preflight) }
        : {}),
      ...(usage ? { usage: cloneRuntimeValue(usage) } : {}),
      compaction: {
        activeCheckpointId: contextPlan.compaction.activeCheckpointId,
        recommendedCheckpointId: contextPlan.compaction.recommendedCheckpoint?.id ?? null,
        omittedRoundCount: contextPlan.compaction.omittedRoundCount,
        shouldAutoCompact: contextPlan.compaction.shouldAutoCompact,
      },
    }
  }

  private async persistContextTurnLedger(input: {
    conversationId: string
    assistantMessageId: string
    selection: ModelSelection
    contextPlan: AgentContextPlan
    usage?: UsageInfo
  }): Promise<void> {
    try {
      const entry = this.createContextTurnLedgerEntry(input)
      const appended = await this.store.appendSessionEntry(input.conversationId, {
        type: 'context.turn.recorded',
        timestamp: entry.createdAt,
        data: { entry },
      })
      const summary = cloneRuntimeConversationSummary(appended.summary)
      this.emit(createWorkbenchEvent('conversations:updated', summary))
    } catch (error) {
      this.logger.warn('[runtime] context turn ledger persistence failed:', error)
    }
  }

  private async runStream(input: {
    conversationId: string
    assistantMessageId: string
    run: RunIdentity
    selection: ModelSelection
    controller: AbortController
    resolveCleanup: () => void
    messages: ChatMessage[]
    contextPlan: AgentContextPlan
    toolContext: ToolContext
    toolRegistry: ToolRegistry
    loopMode: 'continuous' | 'step'
    runContextRef: BlobRef
    sessionLeafId: string
    runSnapshot?: RunSnapshot
    resumeState?: {
      messages: ChatMessage[]
      contextPlan: AgentContextPlan
      assistantMessage?: PersistedMessage
      modelStepOutputs?: Record<string, string>
    }
  }): Promise<void> {
    const {
      conversationId,
      assistantMessageId,
      run,
      selection,
      controller,
      resolveCleanup,
      messages,
      contextPlan,
      toolContext,
      toolRegistry,
      loopMode,
      runContextRef,
      sessionLeafId,
      runSnapshot,
      resumeState,
    } = input
    let eventLogChain = Promise.resolve()
    let eventLogFailure: unknown
    let terminalRunEventQueued = false
    const queueRunEvent = (event: RunEventInput): Promise<void> => {
      const eventWithSelection = withTurnSelection(
        {
          // Fresh envelope via spread; the store boundary clones on record.
          ...event,
          turnId: event.turnId ?? run.turnId,
          runId: event.runId ?? run.runId,
          eventId: event.eventId ?? this.createEventId(),
        },
        selection,
      )
      if (
        eventWithSelection.type === 'turn.completed' ||
        eventWithSelection.type === 'turn.failed' ||
        (eventWithSelection.type === 'turn.cancelled' &&
          eventWithSelection.data?.phase === 'completed')
      ) {
        terminalRunEventQueued = true
      }
      if (!this.acceptsStreamEvents(conversationId, controller)) return Promise.resolve()
      eventLogChain = eventLogChain
        .then(async () => {
          if (eventLogFailure) return
          await this.recordRunEventWithResult(eventWithSelection)
        })
        .catch((error) => {
          eventLogFailure ??= error
        })
      return eventLogChain
    }

    try {
      const runAgent = this.host.runAgent
      if (!runAgent) throw new Error('runtime host cannot execute agent runs')
      await runAgent(
        {
          conversationId,
          assistantMessageId,
          // The executor clones what it retains; these are not re-read here.
          run,
          loopMode,
          runContextRef,
          sessionLeafId,
          ...(runSnapshot ? { runSnapshot } : {}),
          ...(resumeState ? { resumeState } : {}),
          messages: messages ?? [],
          // Re-read after the run by persistContextTurnLedger — must stay owned.
          contextPlan: cloneRuntimeValue(contextPlan),
          prepareModelStep: ({ messages: currentMessages, contextPlan: currentPlan }) => ({
            messages: prepareRuntimeModelStepMessages(currentMessages, currentPlan),
          }),
          getSteeringMessages: () => this.drainQueuedInputs('steering'),
          getFollowUpMessages: () => this.drainQueuedInputs('followUp'),
          // Hosts may mutate the request object; the engine's selection must
          // stay isolated (contract-verified).
          selection: cloneRuntimeValue(selection),
          signal: controller.signal,
          workspaceRoots: cloneRuntimeWorkspaceRoots(toolContext.workspaceRoots),
          shellCwd: toolContext.shellCwd,
          path: toolContext.path,
          settings: cloneRuntimeSettings(toolContext.settings),
          webSearch: toolContext.webSearch,
          generateImage: toolContext.generateImage,
          saveImage: toolContext.saveImage,
          runShell: toolContext.runShell,
          fileSystem: toolContext.fileSystem,
          onToolPolicy: toolContext.onToolPolicy,
          onToolApproval: toolContext.onToolApproval,
          onRunEvent: queueRunEvent,
          onSavePoint: async (reason) => {
            await eventLogChain
            if (eventLogFailure) throw eventLogFailure
            await this.flushPendingSessionWrites(conversationId)
            this.lifecycle.dispatch('run', 'onSavePoint', {
              conversationId,
              runId: run.runId,
              reason,
            })
          },
          appendSessionEntry: async (entry: SessionEntryInput) => {
            await eventLogChain
            if (eventLogFailure) throw eventLogFailure
            const appended = await this.store.appendSessionEntry(conversationId, entry)
            return appended.entry
          },
          putBlob: (blob) => this.store.putBlob(conversationId, blob),
          toolRegistry,
        },
        {
          onTextDelta: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:text-delta', event),
            ),
          onReasoningDelta: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:reasoning-delta', event),
            ),
          onToolCallStart: (event) => {
            this.lifecycle.dispatch('tool', 'onExecutionStarted', { conversationId, event })
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:tool-call-start', event),
            )
          },
          onToolCallArgsDelta: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:tool-call-args-delta', event),
            ),
          onToolCallResult: (event) => {
            this.lifecycle.dispatch('tool', 'onExecutionCompleted', { conversationId, event })
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:tool-call-result', event),
            )
          },
          onImageBlock: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createWorkbenchEvent('chat:image-block', event),
            ),
          onDone: async (event) => {
            const doneEvent = cloneRuntimeValue(event)
            if (!this.acceptsStreamEvents(conversationId, controller)) return
            const persisted = await this.persistAndAnnounce(conversationId, doneEvent.message)
            if (!persisted || !this.acceptsStreamEvents(conversationId, controller)) return
            this.emit(createWorkbenchEvent('chat:done', doneEvent))
            if (doneEvent.usage) {
              try {
                const appended = await this.store.appendSessionEntry(conversationId, {
                  type: 'usage.recorded',
                  timestamp: this.now(),
                  data: { usage: cloneRuntimeValue(doneEvent.usage) },
                })
                const summary = cloneRuntimeConversationSummary(appended.summary)
                this.emit(createWorkbenchEvent('conversations:updated', summary))
              } catch (err) {
                this.logger.warn('[runtime] usage persistence failed:', err)
              }
            }
            await this.persistContextTurnLedger({
              conversationId,
              assistantMessageId,
              selection,
              contextPlan,
              usage: doneEvent.usage,
            })
          },
          onError: async (event) => {
            const errorEvent = cloneRuntimeValue(event)
            if (!this.acceptsStreamEvents(conversationId, controller)) return
            const persisted = await this.persistAndAnnounce(conversationId, errorEvent.message)
            if (!persisted || !this.acceptsStreamEvents(conversationId, controller)) return
            this.emit(createWorkbenchEvent('chat:error', errorEvent))
          },
        },
      )
      await eventLogChain
      if (eventLogFailure) throw eventLogFailure
    } catch (err) {
      const isAbort = controller.signal.aborted
      const message = isAbort ? 'Aborted' : err instanceof Error ? err.message : String(err)
      if (!isAbort) this.logger.error('[runtime] unexpected stream error:', message)
      if (this.acceptsStreamEvents(conversationId, controller)) {
        const errored: PersistedMessage = {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: assistantMessageId,
          role: 'assistant',
          blocks: [],
          status: 'error',
          error: message,
          model: selection,
        }
        const persisted = await this.persistAndAnnounce(conversationId, errored).catch(() => false)
        if (persisted && this.acceptsStreamEvents(conversationId, controller)) {
          this.emit(
            createWorkbenchEvent('chat:error', {
              conversationId,
              messageId: assistantMessageId,
              error: message,
              message: errored,
            }),
          )
        }
        if (!terminalRunEventQueued) {
          queueRunEvent({
            timestamp: this.now(),
            conversationId,
            messageId: assistantMessageId,
            type: isAbort ? 'turn.cancelled' : 'turn.failed',
            data: isAbort ? { phase: 'completed', reason: 'abort_signal' } : { error: message },
          })
        }
      }
    } finally {
      try {
        await eventLogChain
        if (eventLogFailure) {
          this.logger.error('[runtime] durable journal append failed:', eventLogFailure)
        }
      } finally {
        await this.flushPendingSessionWrites(conversationId).catch((error) => {
          this.logger.warn('[runtime] pending session write flush failed:', error)
        })
        if (!this.deleted) {
          await this.setSessionPhase(conversationId, 'idle').catch((error) => {
            this.logger.warn('[runtime] idle phase persistence failed:', error)
          })
        }
        this.deactivateTurnWhere((turn) => turn.controller === controller)
        resolveCleanup()
      }
    }
  }
}
