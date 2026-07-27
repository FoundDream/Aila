import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runtimeSdk from '@aila/agent'
import * as runtimeCoreSdk from '@aila/agent'
import {
  type AgentContextPlan,
  WorkbenchRuntime as AgentWorkbenchRuntime,
  AILA_EXECUTION_MODES,
  AILA_SKILL_FILE,
  AILA_WORKBENCH_EVENT_SCHEMA_VERSION,
  AILA_WORKBENCH_EVENT_TYPES,
  type ChatMessage,
  createExecutionModeToolPolicy,
  createInMemoryRuntimeStore,
  createInterruptedConversationRecoveryEvent,
  createWorkbenchEvent,
  evaluateExecutionModeToolPolicy,
  isReadOnlyToolMetadata,
  isWorkbenchEventType,
  parseSkillDocument,
  type RunEvent,
  type RuntimeAttachmentBlock,
  type RuntimePersistAttachmentInput,
  type RuntimeRecordRunEventInput,
  replayConversationActivity,
  replayConversationRuntimeState,
  requestToolApprovalWithActivity,
  type Settings,
  SKILL_TOOL_NAME,
  type ToolApprovalRequest,
  type ToolFileSystem,
  type ToolPack,
  type ToolShellRequest,
  type ToolWebSearchRequest,
  type WorkbenchEvent,
  type WorkbenchHost,
  type WorkbenchStore,
} from '@aila/agent'
import * as runtimePackageNodeSdk from '@aila/agent-node'
import * as runtimeNodeSdk from '@aila/agent-node/app'
import {
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  AILA_RUN_EVENT_SCHEMA_VERSION,
  appendMessage,
  appendRunEvent,
  appendRunEventAndTouchConversation,
  type ConversationRecord,
  type ConversationSummary,
  configureDataDir,
  createConversation,
  createPersistedRuntimeStore,
  deleteConversation,
  getConversation,
  getConversationsDir,
  getExtensionReport,
  getImagesDir,
  getSkillsDir,
  listConversations,
  listRunEvents,
  loadSkillFromDir,
  loadSkillsFromDir,
  type PersistedMessage,
  type PersistedRunEvent,
  recoverInterruptedConversationActivities,
  setConversationUsage,
  upsertMessage,
} from '@aila/agent-node/app'
import * as runtimeInternalSdk from '../packages/agent/src/internal'
import {
  advanceRun,
  createDefaultToolRegistry,
  createRunCursor,
  executeTool,
  getToolDefinitions,
  type RunTransition,
  replayRunState,
  runDurableRun,
  summarizeToolTarget,
} from '../packages/agent/src/internal'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

interface LegacyWorkbenchStoreFixture {
  createConversation?: WorkbenchStore['createConversation']
  getConversation: WorkbenchStore['getConversation']
  listConversations?: WorkbenchStore['listConversations']
  renameConversation?: (conversationId: string, title: string) => Promise<ConversationSummary>
  saveMessage?: (conversationId: string, message: PersistedMessage) => Promise<ConversationSummary>
  recordRunEvent?: (
    conversationId: string,
    event: RunEvent,
  ) => Promise<{ event: RunEvent; summary: ConversationSummary }>
  listRunEvents?: (conversationId: string) => Promise<RunEvent[]>
  recordUsage?: (
    conversationId: string,
    usage: runtimeSdk.UsageInfo,
  ) => Promise<ConversationSummary>
  deleteConversation?: WorkbenchStore['deleteConversation']
  recoverInterruptedActivities?: WorkbenchStore['recoverInterruptedActivities']
}

function normalizeFixtureStore(
  store: WorkbenchStore | LegacyWorkbenchStoreFixture | undefined,
): WorkbenchStore | undefined {
  if (!store || 'appendSessionEntry' in store) return store as WorkbenchStore | undefined

  const entries = new Map<string, runtimeSdk.SessionEntry[]>()
  const snapshots = new Map<string, runtimeSdk.RunSnapshot>()
  const blobs = new Map<string, runtimeSdk.StoredBlob>()
  let generatedId = 0
  const nextId = () => `fixture-${++generatedId}`
  const runKey = (conversationId: string, runId: string) => `${conversationId}:${runId}`
  const blobKey = (conversationId: string, blobId: string) => `${conversationId}:${blobId}`

  const adapted: WorkbenchStore = {
    createConversation:
      store.createConversation ??
      (async () => {
        throw new Error('fixture store does not support conversation creation')
      }),
    getConversation: store.getConversation,
    listConversations: store.listConversations ?? (async () => []),
    async appendSessionEntry(conversationId, input) {
      let summary: ConversationSummary | undefined
      if (input.type === 'conversation.renamed' && store.renameConversation) {
        summary = await store.renameConversation(conversationId, input.data.title)
      } else if (input.type === 'message.committed' && store.saveMessage) {
        summary = await store.saveMessage(conversationId, input.data.message)
      } else if (input.type === 'run.event' && store.recordRunEvent) {
        summary = (await store.recordRunEvent(conversationId, input.data.event)).summary
      } else if (input.type === 'usage.recorded' && store.recordUsage) {
        summary = await store.recordUsage(conversationId, input.data.usage)
      }
      summary ??= (await store.getConversation(conversationId)).meta
      const journal = entries.get(conversationId) ?? []
      const prepared = runtimeSdk.prepareSessionEntry(conversationId, journal, input, nextId)
      if (!prepared.duplicate) journal.push(prepared.entry)
      entries.set(conversationId, journal)
      return {
        entry: prepared.entry,
        summary,
        ...(prepared.duplicate ? { duplicate: true } : {}),
      }
    },
    async listSessionEntries(conversationId) {
      const journal = entries.get(conversationId) ?? []
      if (!journal.some((entry) => entry.type === 'run.event') && store.listRunEvents) {
        const legacyEvents = await store.listRunEvents(conversationId)
        const projected = [...journal]
        for (const [index, event] of legacyEvents.entries()) {
          const prepared = runtimeSdk.prepareSessionEntry(
            conversationId,
            projected,
            {
              type: 'run.event',
              entryId: event.eventId ?? `fixture-event-${index}`,
              timestamp: event.timestamp,
              turnId: event.turnId,
              runId: event.runId,
              stepId: event.stepId,
              data: { event },
            },
            nextId,
          )
          if (!prepared.duplicate) projected.push(prepared.entry)
        }
        return runtimeSdk.orderedSessionEntries(projected)
      }
      return runtimeSdk.orderedSessionEntries(journal)
    },
    deleteConversation: store.deleteConversation ?? (async () => {}),
    recoverInterruptedActivities: store.recoverInterruptedActivities,
    async saveRunSnapshot(snapshot) {
      const key = runKey(snapshot.identity.conversationId, snapshot.identity.runId)
      const saved = runtimeSdk.prepareRunSnapshot(snapshot, snapshots.get(key))
      snapshots.set(key, saved)
      return structuredClone(saved)
    },
    async getRunSnapshot(conversationId, runId) {
      const snapshot = snapshots.get(runKey(conversationId, runId))
      return snapshot ? structuredClone(snapshot) : null
    },
    async listRunSnapshots(conversationId) {
      return [...snapshots.values()]
        .filter((snapshot) => snapshot.identity.conversationId === conversationId)
        .map((snapshot) => structuredClone(snapshot))
    },
    async putBlob(conversationId, input) {
      const data = structuredClone(input.data)
      const sizeBytes = new TextEncoder().encode(
        typeof data === 'string' ? data : JSON.stringify(data),
      ).byteLength
      const stored: runtimeSdk.StoredBlob = {
        ref: {
          schemaVersion: runtimeSdk.AILA_BLOB_SCHEMA_VERSION,
          blobId: input.blobId ?? nextId(),
          contentType: input.contentType,
          sizeBytes,
          ...(input.preview ? { preview: input.preview } : {}),
        },
        data,
      }
      const key = blobKey(conversationId, stored.ref.blobId)
      const current = blobs.get(key)
      if (current && JSON.stringify(current) !== JSON.stringify(stored)) {
        throw new Error(`blob is immutable: ${stored.ref.blobId}`)
      }
      blobs.set(key, stored)
      return structuredClone(stored.ref)
    },
    async getBlob(conversationId, blobId) {
      const blob = blobs.get(blobKey(conversationId, blobId))
      return blob ? structuredClone(blob) : null
    },
  }
  return adapted
}

type WorkbenchOptions = ConstructorParameters<typeof AgentWorkbenchRuntime>[0]

class WorkbenchRuntime extends AgentWorkbenchRuntime {
  constructor(options: WorkbenchOptions = {}) {
    super({
      ...options,
      store: normalizeFixtureStore(
        options.store as WorkbenchStore | LegacyWorkbenchStoreFixture | undefined,
      ),
    })
  }
}

async function withTempDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'aila-runtime-contract-'))
  try {
    configureDataDir(dir)
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function assertSessionJournalMissing(conversationId: string, message: string): Promise<void> {
  try {
    await listRunEvents(conversationId)
    throw new Error(`${message}: deleted journal unexpectedly remained readable`)
  } catch (error) {
    assert(error instanceof Error && 'code' in error && error.code === 'ENOENT', message)
  }
}

async function testRunMachineStepModePausesBeforeToolStep(): Promise<void> {
  const transitions: RunTransition[] = []
  let modelStepCount = 0
  let toolStepCount = 0

  const result = await runDurableRun<{ id: string }>({
    identity: {
      conversationId: 'loop-step-conversation',
      turnId: 'loop-step-turn',
      runId: 'loop-step-run',
    },
    signal: new AbortController().signal,
    maxToolSteps: 2,
    policy: { mode: 'step' },
    executeModelStep: async () => {
      modelStepCount += 1
      return { outcome: 'completed', toolCalls: [{ id: 'pending-tool' }] }
    },
    executeToolStep: async () => {
      toolStepCount += 1
      return { outcome: 'completed' }
    },
    onTransition: (transition) => {
      transitions.push(transition)
    },
  })

  assertEqual(result.state.status, 'paused', 'step mode should pause after one model step')
  assertEqual(modelStepCount, 1, 'step mode should execute exactly one model step')
  assertEqual(toolStepCount, 0, 'step mode should pause before executing the tool step')
  assertEqual(result.state.steps.length, 1, 'step mode should record the completed model step')
  assertEqual(result.state.steps[0]?.kind, 'model', 'step mode should identify the model step')
  assertEqual(
    result.pendingToolCallIds?.[0],
    'pending-tool',
    'step mode should expose the pending tool call',
  )
  assertEqual(
    transitions.map((transition) => transition.type).join(','),
    'run.started,step.started,step.completed,run.paused',
    'step mode should emit replayable run and step boundaries',
  )
}

async function testRunCursorResumesOneActionAtATime(): Promise<void> {
  const identity = {
    conversationId: 'loop-resume-conversation',
    turnId: 'loop-resume-turn',
    runId: 'loop-resume-run',
  }
  const transitions: RunTransition[] = []
  let modelCalls = 0
  let toolSteps = 0
  const executeModelStep = async () => {
    modelCalls += 1
    return modelCalls === 1
      ? { outcome: 'completed' as const, toolCalls: [{ id: 'resume-tool' }] }
      : { outcome: 'completed' as const, toolCalls: [] }
  }
  const executeToolStep = async () => {
    toolSteps += 1
    return { outcome: 'completed' as const }
  }
  const common = {
    identity,
    signal: new AbortController().signal,
    maxToolSteps: 2,
    policy: { mode: 'step' as const },
    executeModelStep,
    executeToolStep,
    onTransition: (transition: RunTransition) => {
      transitions.push(transition)
    },
  }

  const first = await advanceRun(common)
  assertEqual(first.state.status, 'paused', 'first action should pause after the model')
  assertEqual(modelCalls, 1, 'first advance should execute one model action')
  assertEqual(toolSteps, 0, 'first advance should not execute pending tools')

  const second = await advanceRun({ ...common, snapshot: first.snapshot })
  assertEqual(second.state.status, 'paused', 'second action should pause after tools')
  assertEqual(modelCalls, 1, 'second advance should not call the model')
  assertEqual(toolSteps, 1, 'second advance should execute one tool step')

  const third = await advanceRun({ ...common, snapshot: second.snapshot })
  assertEqual(third.state.status, 'completed', 'third action should complete the run')
  assertEqual(modelCalls, 2, 'third advance should execute the final model action')
  assertEqual(toolSteps, 1, 'third advance should not replay tools')
  assertEqual(
    third.snapshot.state.steps.map((step) => step.kind).join(','),
    'model,tool,model',
    'resumed snapshot should preserve the full step history',
  )
  assertEqual(
    transitions.filter((transition) => transition.type === 'run.resumed').length,
    2,
    'each resumed action should emit a replayable run.resumed boundary',
  )
}

async function testRunCheckpointAndArtifactStoreContract(): Promise<void> {
  const store = createInMemoryRuntimeStore({
    createId: () => 'run-store-conversation',
  })
  const conversation = await store.createConversation?.()
  assert(conversation, 'run persistence store should create a conversation')
  const identity = {
    conversationId: conversation.id,
    turnId: 'run-store-turn',
    runId: 'run-store-run',
  }
  const contextRef = await store.putBlob(conversation.id, {
    blobId: 'run-store-context',
    contentType: 'application/json',
    data: { messages: [{ role: 'user', content: 'persist this run' }], contextPlan: {} },
  })
  const checkpoint: runtimeSdk.RunSnapshot = {
    schemaVersion: runtimeSdk.AILA_RUN_SNAPSHOT_SCHEMA_VERSION,
    identity,
    assistantMessageId: 'run-store-assistant',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    executionMode: 'agent',
    maxToolSteps: 2,
    loop: createRunCursor(identity, 'step'),
    contextRef,
    recovery: { strategy: 'automatic' },
    revision: 1,
    createdAt: 10,
    updatedAt: 10,
    throughSeq: 1,
  }
  const first = await store.saveRunSnapshot(checkpoint)
  const second = await store.saveRunSnapshot({ ...first, updatedAt: 20 })
  assertEqual(first.revision, 1, 'first checkpoint revision')
  assertEqual(second.revision, 2, 'checkpoint revisions should increase monotonically')
  const loaded = await store.getRunSnapshot(conversation.id, identity.runId)
  assertEqual(loaded?.updatedAt, 20, 'checkpoint should load the latest cursor')

  const payloadRef = await store.putBlob(conversation.id, {
    blobId: 'run-store-payload',
    contentType: 'application/json',
    data: { value: 1 },
  })
  const payloadEntry: runtimeSdk.SessionEntryInput<'run.payload'> = {
    type: 'run.payload',
    entryId: 'run-store-entry',
    timestamp: 30,
    turnId: identity.turnId,
    runId: identity.runId,
    stepId: 'run-store-step',
    payloadRef,
    data: { kind: 'inspection', label: 'Inspection' },
  }
  await store.appendSessionEntry(conversation.id, payloadEntry)
  await store.appendSessionEntry(conversation.id, payloadEntry)
  const entries = await store.listSessionEntries(conversation.id)
  assertEqual(
    runtimeSdk.sessionRunPayloads(entries, identity.runId).length,
    1,
    'identical journal writes should be idempotent',
  )
  let immutableError = ''
  try {
    await store.putBlob(conversation.id, {
      blobId: payloadRef.blobId,
      contentType: 'application/json',
      data: { value: 2 },
    })
  } catch (error) {
    immutableError = error instanceof Error ? error.message : String(error)
  }
  assert(immutableError.includes('immutable'), 'blob ids should reject conflicting overwrites')
}

async function testRuntimeRunInspectionForkAndAbortContract(): Promise<void> {
  const store = createInMemoryRuntimeStore({
    createId: () => 'run-control-conversation',
  })
  let generatedId = 0
  let timestamp = 100
  const runtime = new WorkbenchRuntime({
    store,
    createId: () => (generatedId++ === 0 ? 'run-control-turn' : 'run-control-fork-assistant'),
    createRunId: () => 'run-control-fork',
    createEventId: () => `run-control-event-${generatedId++}`,
    now: () => timestamp++,
    logger: { warn() {}, error() {} },
  })
  const conversation = await runtime.createConversation()
  const userMessage = await runtime.appendUserMessage({
    conversationId: conversation.id,
    text: 'inspect and fork this run',
  })
  const source = createRunCheckpointFixture(conversation.id, 'run-control-source')
  source.identity.turnId = userMessage.id
  source.loop.state.identity.turnId = userMessage.id
  source.loop.state.status = 'paused'
  source.loop.state.nextAction = { type: 'model', reason: 'resume' }
  source.loop.state.wait = { reason: 'operator' }
  source.assistantMessageId = 'run-control-source-assistant'
  source.contextRef = await store.putBlob(conversation.id, {
    blobId: 'run-control-context',
    contentType: 'application/json',
    data: { messages: [], contextPlan: {} },
  })
  await store.saveRunSnapshot(source)
  const payloadRef = await store.putBlob(conversation.id, {
    blobId: 'run-control-payload',
    contentType: 'application/json',
    data: { inspected: true },
  })
  await store.appendSessionEntry(conversation.id, {
    type: 'run.payload',
    entryId: 'run-control-source-payload',
    timestamp: timestamp++,
    turnId: userMessage.id,
    runId: source.identity.runId,
    stepId: 'run-control-source-step',
    payloadRef,
    data: { kind: 'inspection', label: 'Inspection' },
  })
  await runtime.recordRunEvent({
    timestamp: timestamp++,
    conversationId: conversation.id,
    messageId: source.assistantMessageId,
    turnId: userMessage.id,
    runId: source.identity.runId,
    type: 'run.paused',
    data: { nextAction: source.loop.state.nextAction },
  })

  const inspection = await runtime.inspectRun({
    conversationId: conversation.id,
    runId: source.identity.runId,
  })
  assertEqual(inspection.active, false, 'persisted run inspection should report inactive state')
  assertEqual(inspection.events.length, 1, 'run inspection should filter events by run id')
  assertEqual(inspection.artifacts.length, 1, 'run inspection should include immutable artifacts')

  const forked = await runtime.forkRun({
    conversationId: conversation.id,
    runId: source.identity.runId,
    originStepId: 'run-control-source-step',
  })
  assertEqual(forked.identity.runId, 'run-control-fork', 'fork should allocate a new run id')
  assertEqual(
    forked.identity.parentRunId,
    source.identity.runId,
    'fork should preserve parent run identity',
  )
  assertEqual(
    forked.identity.originStepId,
    'run-control-source-step',
    'fork should preserve the selected origin step',
  )
  assertEqual(forked.identity.turnId, userMessage.id, 'fork should preserve the logical turn')

  const aborted = await runtime.abortRun({
    conversationId: conversation.id,
    runId: forked.identity.runId,
  })
  assertEqual(aborted.loop.state.status, 'cancelled', 'abort should terminalize a paused run')
  const forkInspection = await runtime.inspectRun({
    conversationId: conversation.id,
    runId: forked.identity.runId,
  })
  assertEqual(
    forkInspection.events.map((event) => event.type).join(','),
    'run.started,run.paused,run.cancelled',
    'fork and abort boundaries should remain replayable',
  )
}

function testRunCheckpointRecoverySafetyContract(): void {
  const toolCheckpoint = createRunCheckpointFixture('recovery-conversation', 'recovery-tool-run')
  const toolStep = {
    stepId: 'recovery-tool-step',
    index: 1,
    attempt: 1,
    kind: 'tool' as const,
    toolCallId: 'unsafe-call',
    status: 'running' as const,
    startedAt: 20,
  }
  toolCheckpoint.loop.state.status = 'running'
  toolCheckpoint.loop.state.currentStep = toolStep
  toolCheckpoint.loop.state.steps = [toolStep]
  toolCheckpoint.loop.state.nextAction = { type: 'tools', toolCallIds: ['unsafe-call'] }
  const preparedTool = runtimeSdk.prepareRunCheckpoint(toolCheckpoint)
  assertEqual(
    preparedTool.recovery.strategy,
    'manual_review',
    'interrupted tool calls should never be marked for automatic replay',
  )
  let manualReviewError = ''
  try {
    runtimeSdk.prepareRunCheckpointForResume(preparedTool, 30)
  } catch (error) {
    manualReviewError = error instanceof Error ? error.message : String(error)
  }
  assert(
    manualReviewError.includes('side effects may have occurred'),
    'automatic resume should refuse an interrupted tool call',
  )

  const modelCheckpoint = createRunCheckpointFixture('recovery-conversation', 'recovery-model-run')
  const modelStep = {
    stepId: 'recovery-model-step',
    index: 0,
    attempt: 1,
    kind: 'model' as const,
    status: 'running' as const,
    startedAt: 20,
  }
  modelCheckpoint.loop.state.status = 'running'
  modelCheckpoint.loop.state.currentStep = modelStep
  modelCheckpoint.loop.state.steps = [modelStep]
  modelCheckpoint.loop.state.nextAction = { type: 'model', reason: 'user' }
  const resumed = runtimeSdk.prepareRunCheckpointForResume(modelCheckpoint, 30)
  assertEqual(
    resumed.loop.state.status,
    'paused',
    'interrupted model calls should become resumable',
  )
  assertEqual(
    resumed.loop.state.nextAction?.type,
    'model',
    'interrupted model calls should retry only the model action',
  )
  assertEqual(
    resumed.loop.state.steps[0]?.status,
    'cancelled',
    'recovery should close the interrupted model step before retry',
  )
}

function testRunCheckpointV1MigrationContract(): void {
  const legacy = structuredClone(
    createRunCheckpointFixture('migration-conversation', 'migration-run'),
  ) as unknown as {
    schemaVersion: number
    loop: {
      state: {
        status: string
        nextAction?: unknown
        wait?: unknown
      }
    }
  }
  legacy.schemaVersion = 2
  legacy.loop.state.status = 'paused'
  legacy.loop.state.nextAction = { type: 'tools', toolCallIds: ['legacy-tool'] }
  delete legacy.loop.state.wait

  let error = ''
  try {
    runtimeSdk.normalizeRunSnapshot(legacy)
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  assert(
    error.includes('unsupported agent run snapshot schema'),
    'legacy snapshots must be rejected',
  )
}

async function testProviderModelCallExecutesExactlyOneRequest(): Promise<void> {
  let streamCount = 0
  const streamedEvents: string[] = []
  const executor = runtimePackageNodeSdk.createProviderModelCallExecutor({
    modelStreamClient: {
      async *stream() {
        streamCount += 1
        yield { type: 'text-delta', text: 'inspect ' }
        yield {
          type: 'tool-call',
          toolCallId: 'model-call-tool',
          toolName: 'read',
          input: { path: '/workspace/file.ts' },
        }
        yield {
          type: 'finish-step',
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        }
      },
    },
  })

  const result = await executor.execute(
    {
      descriptor: {
        provider: 'openrouter',
        modelId: 'contract/model-call',
        api: 'openai-chat-completions',
      },
      apiKey: 'contract-key',
      conversationId: 'model-call-conversation',
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [
        {
          name: 'read',
          description: 'Read a file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      signal: new AbortController().signal,
    },
    (event) => {
      streamedEvents.push(event.type)
    },
  )

  assertEqual(
    streamCount,
    1,
    'one ModelCallExecutor invocation should perform one provider request',
  )
  assertEqual(result.outcome, 'completed', 'one model call should complete')
  assertEqual(result.text, 'inspect ', 'one model call should aggregate text')
  assertEqual(
    result.toolCalls.length,
    1,
    'one model call should return tool calls without running them',
  )
  assertEqual(result.stepUsage[0]?.totalTokens, 6, 'one model call should return provider usage')
  assertEqual(
    streamedEvents.join(','),
    'text-delta,tool-call,finish-step',
    'one model call should preserve provider stream order',
  )
}

async function testProviderStreamStepCheckpointResumeContract(): Promise<void> {
  let modelRequestCount = 0
  let toolRunCount = 0
  let checkpoint: runtimeSdk.RunSnapshot | undefined
  const entries: runtimeSdk.SessionEntry[] = []
  const blobs = new Map<string, runtimeSdk.StoredBlob>()
  const events: RunEvent[] = []
  const doneMessages: PersistedMessage[] = []
  const modelStreamClient: runtimePackageNodeSdk.ModelStreamClient = {
    async *stream(input) {
      modelRequestCount += 1
      if (modelRequestCount === 1) {
        yield { type: 'text-delta', text: 'first' }
        yield {
          type: 'tool-call',
          toolCallId: 'step-resume-tool',
          toolName: 'step_resume_echo',
          input: { value: 'ok' },
        }
        yield {
          type: 'finish-step',
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        }
        return
      }
      assert(
        input.messages.some(
          (message) =>
            message.role === 'tool' &&
            message.tool_call_id === 'step-resume-tool' &&
            message.content === 'echo:ok',
        ),
        'resumed provider stream should restore and forward persisted tool results',
      )
      yield { type: 'text-delta', text: 'final' }
      yield {
        type: 'finish-step',
        usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      }
    },
  }
  const toolPack: ToolPack = {
    id: 'step-resume-pack',
    name: 'Step Resume Pack',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'step_resume_echo',
            description: 'Echo a value.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
          metadata: {
            name: 'step_resume_echo',
            readOnly: true,
            destructive: false,
            requiresApproval: false,
            access: ['read'],
            scope: ['workspace'],
          },
        },
        run(args) {
          toolRunCount += 1
          return `echo:${String(args.value ?? '')}`
        },
      },
    ],
  }
  const runAgent = runtimePackageNodeSdk.createDurableRunExecutor({
    modelStreamClient,
    settings: { apiKeys: { openrouter: 'contract-key' }, defaultModel: null },
  })
  const saveRunSnapshot = (input: runtimeSdk.RunSnapshot) => {
    checkpoint = runtimeSdk.prepareRunSnapshot(
      { ...input, throughSeq: entries.at(-1)?.seq ?? 0 },
      checkpoint,
    )
    return structuredClone(checkpoint)
  }
  const appendSessionEntry = (input: runtimeSdk.SessionEntryInput) => {
    const prepared = runtimeSdk.prepareSessionEntry(
      'step-resume-conversation',
      entries,
      input,
      () => `entry-${entries.length + 1}`,
    )
    if (!prepared.duplicate) entries.push(prepared.entry)
    return structuredClone(prepared.entry)
  }
  const putBlob = (input: {
    contentType: string
    data: unknown
    preview?: string
    blobId?: string
  }) => {
    const blobId = input.blobId ?? `blob-${blobs.size + 1}`
    const ref: runtimeSdk.BlobRef = {
      schemaVersion: runtimeSdk.AILA_BLOB_SCHEMA_VERSION,
      blobId,
      contentType: input.contentType,
      sizeBytes: JSON.stringify(input.data).length,
      ...(input.preview ? { preview: input.preview } : {}),
    }
    blobs.set(blobId, { ref, data: structuredClone(input.data) })
    return structuredClone(ref)
  }
  const handlers = {
    onTextDelta() {},
    onReasoningDelta() {},
    onToolCallStart() {},
    onToolCallArgsDelta() {},
    onToolCallResult() {},
    onImageBlock() {},
    onDone(event: { message: PersistedMessage }) {
      doneMessages.push(event.message)
    },
    onError(event: { error: string }) {
      throw new Error(event.error)
    },
  }
  const baseRequest = {
    conversationId: 'step-resume-conversation',
    assistantMessageId: 'step-resume-assistant',
    run: {
      conversationId: 'step-resume-conversation',
      turnId: 'step-resume-turn',
      runId: 'step-resume-run',
    },
    runContextRef: {
      schemaVersion: runtimeSdk.AILA_BLOB_SCHEMA_VERSION,
      blobId: 'step-resume-context',
      contentType: 'application/json',
      sizeBytes: 0,
    },
    messages: [{ role: 'user' as const, content: 'start' }],
    selection: { providerId: 'openrouter' as const, modelId: 'contract/mock' },
    signal: new AbortController().signal,
    onRunEvent: (event: RunEvent) => events.push(event),
    saveRunSnapshot,
    appendSessionEntry,
    putBlob,
    toolRegistry: createDefaultToolRegistry([toolPack]),
  }

  await runAgent({ ...baseRequest, loopMode: 'step' }, handlers)
  assert(checkpoint, 'step stream should persist a checkpoint')
  assertEqual(checkpoint.loop.state.status, 'paused', 'step stream should pause after one action')
  assertEqual(
    checkpoint.loop.state.nextAction?.type,
    'tools',
    'step checkpoint should persist pending tools',
  )
  assertEqual(toolRunCount, 0, 'paused model action should not execute tools')
  assertEqual(doneMessages.length, 0, 'paused stream should not finalize the assistant message')
  const pausedEvents = events.map(
    (event): PersistedRunEvent => ({
      ...event,
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
    }),
  )
  const pausedReplay = replayConversationRuntimeState(pausedEvents)
  assertEqual(pausedReplay.phase, 'paused', 'run.paused should survive runtime replay')
  assertEqual(pausedReplay.active, false, 'paused runs should not replay as active work')
  assertEqual(
    replayConversationActivity(pausedEvents)?.state,
    'paused',
    'run.paused should replace stale running activity',
  )
  assertEqual(
    createInterruptedConversationRecoveryEvent(pausedEvents),
    null,
    'paused runs should not be mistaken for interrupted work after restart',
  )

  await runAgent(
    {
      ...baseRequest,
      loopMode: 'continuous',
      runSnapshot: structuredClone(checkpoint),
      resumeState: {
        messages: [
          ...structuredClone(baseRequest.messages),
          ...entries.flatMap((entry) =>
            entry.type === 'run.payload' && entry.data.modelMessage
              ? [structuredClone(entry.data.modelMessage)]
              : [],
          ),
        ],
        contextPlan: {} as AgentContextPlan,
        assistantMessage: entries
          .filter(
            (entry): entry is runtimeSdk.SessionEntry<'run.payload'> =>
              entry.type === 'run.payload',
          )
          .at(-1)?.data.assistantMessage,
        modelStepOutputs: { '0': 'first' },
      },
    },
    handlers,
  )
  assertEqual(toolRunCount, 1, 'resumed stream should execute the pending tool exactly once')
  assertEqual(modelRequestCount, 2, 'resumed stream should make only the remaining model request')
  assertEqual(doneMessages.length, 1, 'continued stream should finalize once')
  assertEqual(checkpoint.loop.state.status, 'completed', 'continued checkpoint should be terminal')
  assertEqual(
    runtimeSdk.sessionRunPayloads(entries).length,
    7,
    'run should journal every provider and tool payload boundary',
  )
  assertEqual(
    runtimeSdk
      .sessionRunPayloads(entries)
      .map((entry) => entry.data.kind)
      .sort()
      .join(','),
    'provider_request,provider_request,provider_response,provider_response,tool_batch,tool_request,tool_result',
    'journal payload entries should expose every provider and tool boundary',
  )
  assert(
    !JSON.stringify([...blobs.values()]).includes('contract-key'),
    'payload blobs must never persist provider credentials',
  )
  const toolResultEntry = runtimeSdk
    .sessionRunPayloads(entries)
    .find((entry) => entry.data.kind === 'tool_result')
  assert(
    JSON.stringify(
      toolResultEntry?.payloadRef && blobs.get(toolResultEntry.payloadRef.blobId)?.data,
    ).includes('echo:ok'),
    'tool result payload should preserve inspectable output in its blob',
  )
  assert(
    events.some((event) => event.type === 'run.resumed'),
    'continued stream should emit run.resumed',
  )
}

async function testProviderStreamPreflightFailureCheckpointContract(): Promise<void> {
  let modelRequestCount = 0
  let checkpoint: runtimeSdk.RunSnapshot | undefined
  const events: RunEvent[] = []
  const errors: string[] = []
  const runAgent = runtimePackageNodeSdk.createDurableRunExecutor({
    settings: { apiKeys: {}, defaultModel: null },
    modelStreamClient: {
      async *stream() {
        modelRequestCount += 1
        yield { type: 'text-delta' as const, text: 'unexpected' }
      },
    },
  })

  await runAgent(
    {
      conversationId: 'preflight-failure-conversation',
      assistantMessageId: 'preflight-failure-assistant',
      run: {
        conversationId: 'preflight-failure-conversation',
        turnId: 'preflight-failure-turn',
        runId: 'preflight-failure-run',
      },
      runContextRef: {
        schemaVersion: runtimeSdk.AILA_BLOB_SCHEMA_VERSION,
        blobId: 'preflight-context',
        contentType: 'application/json',
        sizeBytes: 0,
      },
      messages: [{ role: 'user', content: 'start' }],
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      signal: new AbortController().signal,
      onRunEvent: (event) => events.push(event),
      saveRunSnapshot(input) {
        checkpoint = runtimeSdk.prepareRunSnapshot(input, checkpoint)
        return structuredClone(checkpoint)
      },
    },
    {
      onTextDelta() {},
      onReasoningDelta() {},
      onToolCallStart() {},
      onToolCallArgsDelta() {},
      onToolCallResult() {},
      onImageBlock() {},
      onDone() {
        throw new Error('preflight failure must not complete')
      },
      onError(event) {
        errors.push(event.error)
      },
    },
  )

  assertEqual(modelRequestCount, 0, 'missing credentials must fail before the provider request')
  assert(checkpoint, 'preflight failure should persist a run checkpoint')
  assertEqual(checkpoint.loop.state.status, 'failed', 'preflight checkpoint should be terminal')
  assertEqual(
    checkpoint.identity.runId,
    'preflight-failure-run',
    'preflight checkpoint should preserve run identity',
  )
  assert(
    errors[0]?.includes('No API key for openrouter'),
    'preflight failure should explain the missing provider credential',
  )
  assertEqual(
    events
      .filter((event) => event.type.startsWith('run.'))
      .map((event) => event.type)
      .join(','),
    'run.started,run.failed',
    'preflight failure should preserve replayable run boundaries',
  )
  assert(
    events.every((event) => event.eventId && event.turnId && event.runId),
    'preflight events should carry durable event and run identities',
  )
}

async function testSettingsInfersOpenRouterVisionDefault(): Promise<void> {
  await withTempDataDir(async (dir) => {
    const settingsPath = join(dir, 'settings.json')
    await writeFile(
      settingsPath,
      `${JSON.stringify({ apiKeys: { openrouter: 'contract-key' }, defaultModel: null })}\n`,
    )

    const desktopSettings = runtimeNodeSdk.loadSettings()
    assertEqual(
      desktopSettings.defaultVisionModel?.providerId,
      'openrouter',
      'desktop settings should infer OpenRouter vision provider for legacy settings',
    )
    assertEqual(
      desktopSettings.defaultVisionModel?.modelId,
      'openrouter/free',
      'desktop settings should infer a default OpenRouter vision model for legacy settings',
    )

    const nodeSettings = runtimePackageNodeSdk.loadNodeSettings({ dataDir: dir })
    assertEqual(
      nodeSettings.defaultVisionModel?.modelId,
      'openrouter/free',
      'node settings should infer the same OpenRouter vision default',
    )

    await writeFile(
      settingsPath,
      `${JSON.stringify({
        apiKeys: { openrouter: 'contract-key' },
        defaultModel: null,
        defaultVisionModel: null,
      })}\n`,
    )
    assertEqual(
      runtimeNodeSdk.loadSettings().defaultVisionModel,
      null,
      'desktop settings should preserve an explicit empty vision model',
    )
    assertEqual(
      runtimePackageNodeSdk.loadNodeSettings({ dataDir: dir }).defaultVisionModel,
      null,
      'node settings should preserve an explicit empty vision model',
    )
  })
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function testRuntimeEventContract(): Promise<void> {
  assertEqual(AILA_WORKBENCH_EVENT_SCHEMA_VERSION, 1, 'runtime event schema version changed')
  assertEqual(
    new Set(AILA_WORKBENCH_EVENT_TYPES).size,
    AILA_WORKBENCH_EVENT_TYPES.length,
    'runtime event types must be unique',
  )
  for (const type of AILA_WORKBENCH_EVENT_TYPES) {
    assert(isWorkbenchEventType(type), `runtime event type should decode: ${type}`)
  }
  assert(!isWorkbenchEventType('chat:unknown'), 'unknown runtime event type should be rejected')

  const event = createWorkbenchEvent('chat:text-delta', {
    conversationId: 'conversation',
    messageId: 'message',
    delta: 'hello',
  })
  assertEqual(event.schemaVersion, AILA_WORKBENCH_EVENT_SCHEMA_VERSION, 'event version')
  assertEqual(event.type, 'chat:text-delta', 'event type')
  assertEqual(event.data.delta, 'hello', 'event data')
}

async function testRuntimeEmitsVersionedEvents(): Promise<void> {
  await withTempDataDir(async () => {
    const events: WorkbenchEvent[] = []
    const runtime = new WorkbenchRuntime({
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
    })
    const conversation = await runtime.createConversation()

    await runtime.send({
      conversationId: conversation.id,
      userText: 'runtime contract smoke',
      selection: { providerId: 'openrouter', modelId: 'minimax/minimax-m3' },
    })

    await waitFor(
      () => events.some((event) => event.type === 'chat:error'),
      'runtime did not emit expected hostless stream error event',
    )
    await runtime.abortAll()

    assert(events.length >= 2, 'runtime should emit persistence and error events')
    for (const event of events) {
      assertEqual(event.schemaVersion, AILA_WORKBENCH_EVENT_SCHEMA_VERSION, 'runtime event version')
      assert(isWorkbenchEventType(event.type), `runtime emitted unknown event type: ${event.type}`)
    }
  })
}

async function testRuntimeWithoutStreamHostFailsAtSetupBoundary(): Promise<void> {
  await withTempDataDir(async () => {
    const events: WorkbenchEvent[] = []
    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
    })
    const conversation = await createConversation()

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'stream host missing',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'hostless setup failure should settle',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.messages.length, 2, 'hostless runtime should persist user and assistant')
    assertEqual(record.messages[0]?.role, 'user', 'hostless setup user role')
    assertEqual(record.messages[1]?.id, result.assistantMessageId, 'hostless setup assistant id')
    assertEqual(record.messages[1]?.status, 'error', 'hostless setup assistant status')
    assertEqual(
      record.messages[1]?.error,
      'runtime host cannot execute agent runs',
      'hostless setup assistant error',
    )
    assert(
      events.some(
        (event) =>
          event.type === 'run:event' &&
          event.data.type === 'turn.failed' &&
          event.data.data?.phase === 'setup' &&
          event.data.data.error === 'runtime host cannot execute agent runs',
      ),
      'hostless runtime should record a setup failure activity',
    )
    assert(
      events.some(
        (event) =>
          event.type === 'chat:error' &&
          event.data.messageId === result.assistantMessageId &&
          event.data.error === 'runtime host cannot execute agent runs',
      ),
      'hostless runtime should emit a setup chat:error',
    )
  })
}

async function testRuntimeHostBoundaryContract(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: WorkbenchEvent[] = []
    let streamStarted = false
    let policyRequested = false
    let approvalRequested = false
    let approvalResult = false
    let abortConversationId: string | null = null
    let abortReason: string | null = null
    let workspaceRootPath: string | null = null
    let workspaceRootLabel: string | null = null
    let fileSystemPassed = false
    let shellCwdPath: string | null = null
    let shellRunnerPassed = false
    let settingsLoaded = false
    let streamSettingsKey: string | null = null
    let activeSelectionModelIdDuringStream: string | null = null
    let runtime: WorkbenchRuntime | undefined
    const runShell: WorkbenchHost['runShell'] = async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
    const fileSystem: ToolFileSystem = {
      readTextFile: async () => '',
      writeTextFile: async () => {},
    }

    const host: WorkbenchHost = {
      onEvent: (event) => events.push(event),
      onToolPolicy: async (request) => {
        policyRequested = request.name === 'write_file'
        return { action: 'ask', reason: 'host policy fixture' }
      },
      onToolApproval: async (request) => {
        approvalRequested = request.name === 'write_file'
        return true
      },
      onConversationAbort: (conversationId, reason) => {
        abortConversationId = conversationId
        abortReason = reason
      },
      loadSettings: () => {
        settingsLoaded = true
        return { apiKeys: { openrouter: 'host-openrouter-key' }, defaultModel: null }
      },
      workspaceRoots: () => [{ path: '/host/workspace', label: 'host-root' }],
      fileSystem,
      shellCwd: () => '/host/shell',
      runShell,
      runAgent: async (req, handlers) => {
        fileSystemPassed = req.fileSystem === fileSystem
        shellCwdPath = req.shellCwd ?? null
        shellRunnerPassed = req.runShell === runShell
        streamSettingsKey = req.settings?.apiKeys.openrouter ?? null
        req.selection.modelId = 'host-mutated-model'
        activeSelectionModelIdDuringStream =
          runtime?.listActiveStreams()[0]?.selection.modelId ?? null
        const [root] = req.workspaceRoots ?? []
        if (root && typeof root !== 'string') {
          workspaceRootPath = root.path
          workspaceRootLabel = root.label ?? null
        }
        const policyDecision = await req.onToolPolicy?.({
          name: 'write_file',
          args: { path: '/host/workspace/file.md', content: 'approved' },
          metadata: {
            name: 'write_file',
            readOnly: false,
            destructive: true,
            requiresApproval: true,
            access: ['write'],
            scope: ['workspace'],
          },
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          toolCallId: 'host-tool-call',
        })
        approvalResult =
          policyDecision?.action === 'ask' &&
          (await req.onToolApproval?.({
            name: 'write_file',
            args: { path: '/host/workspace/file.md', content: 'approved' },
            metadata: {
              name: 'write_file',
              readOnly: false,
              destructive: true,
              requiresApproval: true,
              access: ['write'],
              scope: ['workspace'],
            },
            conversationId: req.conversationId,
            messageId: req.assistantMessageId,
            toolCallId: 'host-tool-call',
          })) === true
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: {},
        })
        streamStarted = true
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve()
            return
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
      },
      logger: { warn() {}, error() {} },
    }
    runtime = new WorkbenchRuntime({ store: createPersistedRuntimeStore(), host })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'exercise host boundary',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await waitFor(() => streamStarted, 'host runAgent should start')
    await runtime.abort(conversation.id)

    assertEqual(settingsLoaded, true, 'host settings loader should be called')
    assertEqual(
      streamSettingsKey,
      'host-openrouter-key',
      'host settings should be passed to runAgent',
    )
    assertEqual(workspaceRootPath, '/host/workspace', 'host workspace root path')
    assertEqual(workspaceRootLabel, 'host-root', 'host workspace root label')
    assertEqual(fileSystemPassed, true, 'host filesystem should pass to runAgent')
    assertEqual(shellCwdPath, '/host/shell', 'host shell cwd should pass to runAgent')
    assertEqual(shellRunnerPassed, true, 'host shell runner should pass to runAgent')
    assertEqual(
      activeSelectionModelIdDuringStream,
      'contract/mock',
      'host stream request mutation should not affect active stream selection',
    )
    assertEqual(policyRequested, true, 'host tool policy should receive tool request')
    assertEqual(approvalRequested, true, 'host tool approval should receive tool request')
    assertEqual(approvalResult, true, 'host tool approval should resolve request')
    assertEqual(abortConversationId, conversation.id, 'host abort cleanup conversation id')
    assertEqual(abortReason, 'user', 'host abort cleanup reason')
    assert(
      events.some((event) => event.type === 'run:event' && event.data.type === 'turn.cancelled'),
      'host onEvent should receive runtime events',
    )
    assert(
      events.some(
        (event) =>
          event.type === 'run:event' &&
          event.data.type === 'turn.started' &&
          event.data.data?.modelId === 'contract/mock',
      ),
      'runtime should fill turn selection from its own snapshot',
    )
    assertEqual(runtime.listActiveStreams().length, 0, 'host aborted stream should settle')
  })
}

async function testRuntimeSettingsFallbackIsHostAgnostic(): Promise<void> {
  await withTempDataDir(async () => {
    const previousOpenRouterKey = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'env-key-must-not-leak-into-runtime'
    try {
      const conversation = await createConversation()
      let streamStarted = false
      let streamSettingsKey: string | null | undefined
      let streamDefaultModel: Settings['defaultModel'] | undefined
      const runtime = new WorkbenchRuntime({
        store: createPersistedRuntimeStore(),
        runAgent: async (req, handlers) => {
          streamSettingsKey = req.settings?.apiKeys.openrouter
          streamDefaultModel = req.settings?.defaultModel
          streamStarted = true
          await handlers.onError({
            conversationId: req.conversationId,
            messageId: req.assistantMessageId,
            error: 'settings fallback contract',
            message: {
              schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
              id: req.assistantMessageId,
              role: 'assistant',
              blocks: [],
              status: 'error',
              error: 'settings fallback contract',
              model: req.selection,
            },
          })
        },
        logger: { warn() {}, error() {} },
      })

      await runtime.send({
        conversationId: conversation.id,
        userText: 'exercise runtime settings fallback',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      })
      await waitFor(() => streamStarted, 'runtime settings fallback stream should start')

      assertEqual(
        streamSettingsKey,
        undefined,
        'runtime without host settings must not read provider keys from env',
      )
      assertEqual(streamDefaultModel, null, 'runtime fallback settings should be empty')
    } finally {
      if (previousOpenRouterKey === undefined) {
        delete process.env.OPENROUTER_API_KEY
      } else {
        process.env.OPENROUTER_API_KEY = previousOpenRouterKey
      }
    }
  })
}

async function testRuntimeStreamAndModelInfoUseHostBoundary(): Promise<void> {
  const conversationId = 'stream-model-info-host-boundary'
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'stream model info host boundary',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let modelInfoSelectionModel: string | null = null
  let streamSelectionModel: string | null = null
  let streamReached = false

  const runtime = new WorkbenchRuntime({
    store: {
      getConversation: async () => record,
      saveMessage: async (_id, message) => {
        const index = record.messages.findIndex((current) => current.id === message.id)
        record =
          index >= 0
            ? {
                ...record,
                messages: record.messages.map((current, currentIndex) =>
                  currentIndex === index ? message : current,
                ),
              }
            : { ...record, messages: [...record.messages, message] }
        return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
      },
      recordRunEvent: async (_id, event) => ({
        event: {
          ...event,
          schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
        },
        summary: { ...summary, updatedAt: summary.updatedAt + record.messages.length + 1 },
      }),
      recordUsage: async () => {
        throw new Error('stream model-info host boundary should not persist usage')
      },
      deleteConversation: async () => {
        throw new Error('stream model-info host boundary should not delete conversation')
      },
    },
    getModelInfo: (selection) => {
      modelInfoSelectionModel = selection.modelId
      selection.modelId = 'host-mutated-model-info-selection'
      return { model: 'Host Model Fixture', contextLength: 8_000 }
    },
    runAgent: async (req, handlers) => {
      streamReached = true
      streamSelectionModel = req.selection.modelId
      req.selection.modelId = 'host-mutated-stream-selection'
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'streamed through injected host boundary' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
    logger: { warn() {}, error() {} },
  })

  const result = await runtime.send({
    conversationId,
    userText: 'use host stream and model info',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await waitFor(() => runtime.listActiveStreams().length === 0, 'host stream should settle')

  assertEqual(streamReached, true, 'runtime should use injected host runAgent')
  assertEqual(
    modelInfoSelectionModel,
    'contract/mock',
    'runtime should resolve model info through host',
  )
  assertEqual(
    streamSelectionModel,
    'contract/mock',
    'host model-info mutation must not affect stream selection',
  )
  assertEqual(
    runtime.listActiveStreams().length,
    0,
    'host stream mutation must not leave active streams behind',
  )
  const assistant = record.messages.find((message) => message.id === result.assistantMessageId)
  assertEqual(assistant?.status, 'done', 'host stream should persist assistant completion')
  assertEqual(
    result.userMessage.blocks[0]?.type === 'text' ? result.userMessage.blocks[0].content : '',
    'use host stream and model info',
    'runtime should return a user message snapshot',
  )
}

async function testRuntimeAttachmentPersistenceUsesHostBoundary(): Promise<void> {
  const conversationId = 'attachment-host-boundary'
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'attachment host boundary',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let streamedUserContent: unknown = null
  const persistedInputs: RuntimePersistAttachmentInput[] = []
  const attachments = [
    {
      kind: 'text' as const,
      name: 'notes.txt',
      mime: 'text/plain',
      data: 'hello from the text attachment',
    },
    {
      kind: 'image' as const,
      name: 'screen.png',
      mime: 'image/png',
      data: Buffer.from('host-boundary-image').toString('base64'),
    },
  ]

  const store: WorkbenchStore = {
    getConversation: async (id) => {
      if (id !== conversationId) throw new Error(`unexpected conversation: ${id}`)
      return record
    },
    saveMessage: async (_id, message) => {
      const index = record.messages.findIndex((current) => current.id === message.id)
      record =
        index >= 0
          ? {
              ...record,
              messages: record.messages.map((current, currentIndex) =>
                currentIndex === index ? message : current,
              ),
            }
          : { ...record, messages: [...record.messages, message] }
      return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
    },
    recordRunEvent: async (_id, event) => ({
      event: {
        ...event,
        schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      },
      summary: { ...summary, updatedAt: summary.updatedAt + record.messages.length + 1 },
    }),
    recordUsage: async () => {
      throw new Error('attachment host boundary should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('attachment host boundary should not delete conversation')
    },
  }

  const runtime = new WorkbenchRuntime({
    store,
    persistAttachment: async (input) => {
      persistedInputs.push({ ...input })
      input.name = 'host-mutated-name'
      if (input.kind === 'image') {
        return {
          type: 'image',
          url: `aila-image://i/host-${input.conversationId}.png`,
          mime: input.mime,
        }
      }
      return { type: 'file', name: 'host-notes.txt', content: `${input.data}\nfrom host` }
    },
    runAgent: async (req, handlers) => {
      for (const message of req.messages) {
        if (message.role === 'user') streamedUserContent = message.content
      }
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'attachment host boundary done' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
    logger: { warn() {}, error() {} },
  })

  await runtime.send({
    conversationId,
    userText: 'send attachments through host',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    attachments,
  })
  await waitFor(() => runtime.listActiveStreams().length === 0, 'attachment stream should settle')

  assertEqual(
    attachments[0]?.name,
    'notes.txt',
    'runtime should isolate caller attachments from host mutation',
  )
  assertEqual(persistedInputs.length, 2, 'host should receive every attachment')
  assertEqual(
    persistedInputs.map((input) => `${input.conversationId}:${input.kind}`).join(','),
    `${conversationId}:text,${conversationId}:image`,
    'host attachment inputs should include conversation id and preserve order',
  )

  const userMessage = record.messages.find((message) => message.role === 'user')
  assert(userMessage, 'runtime should persist the user message with attachments')
  assertEqual(userMessage.blocks.length, 3, 'persisted user should include text and attachments')
  assertEqual(userMessage.blocks[1]?.type, 'file', 'text attachment becomes file block')
  assertEqual(
    userMessage.blocks[1]?.type === 'file' ? userMessage.blocks[1].name : '',
    'host-notes.txt',
    'runtime should persist the host-returned file block',
  )
  assertEqual(userMessage.blocks[2]?.type, 'image', 'image attachment becomes image block')
  assertEqual(
    userMessage.blocks[2]?.type === 'image' ? userMessage.blocks[2].url : '',
    `aila-image://i/host-${conversationId}.png`,
    'runtime should persist the host-returned image block',
  )

  assert(Array.isArray(streamedUserContent), 'image attachments should produce multimodal content')
  const streamedJson = JSON.stringify(streamedUserContent)
  assert(
    streamedJson.includes('hello from the text attachment') &&
      streamedJson.includes(`aila-image://i/host-${conversationId}.png`),
    'streamed context should include host-persisted file text and image url',
  )
}

async function testRuntimeTextAttachmentFallbackIsHostAgnostic(): Promise<void> {
  const conversationId = 'text-attachment-fallback'
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'text attachment fallback',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let streamedUserContent = ''

  const store: WorkbenchStore = {
    getConversation: async () => record,
    saveMessage: async (_id, message) => {
      record = { ...record, messages: [...record.messages, message] }
      return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
    },
    recordRunEvent: async (_id, event) => ({
      event: { ...event, schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION },
      summary,
    }),
    recordUsage: async () => {
      throw new Error('text attachment fallback should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('text attachment fallback should not delete conversation')
    },
  }

  const runtime = new WorkbenchRuntime({
    store,
    runAgent: async (req, handlers) => {
      const user = req.messages.find(
        (message): message is { role: 'user'; content: string } =>
          message.role === 'user' && typeof message.content === 'string',
      )
      streamedUserContent = user?.content ?? ''
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'text fallback done' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
    logger: { warn() {}, error() {} },
  })

  await runtime.send({
    conversationId,
    userText: 'plain text with attachment',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    attachments: [
      { kind: 'text', name: 'plain.txt', mime: 'text/plain', data: 'fallback attachment content' },
    ],
  })
  await waitFor(
    () => runtime.listActiveStreams().length === 0,
    'text fallback attachment stream should settle',
  )

  const userMessage = record.messages.find((message) => message.role === 'user')
  assert(userMessage, 'runtime should persist text attachment fallback user message')
  assertEqual(userMessage.blocks[1]?.type, 'file', 'text attachments should not require a host')
  assertEqual(
    userMessage.blocks[1]?.type === 'file' ? userMessage.blocks[1].content : '',
    'fallback attachment content',
    'text attachment fallback should persist file content',
  )
  assert(
    streamedUserContent.includes('fallback attachment content'),
    'text attachment fallback should be present in streamed context',
  )
}

async function testRuntimeImageAttachmentRequiresHostBoundary(): Promise<void> {
  const conversationId = 'image-attachment-requires-host'
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'image attachment requires host',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let streamReached = false

  const runtime = new WorkbenchRuntime({
    store: {
      getConversation: async () => record,
      saveMessage: async (_id, message) => {
        record = { ...record, messages: [...record.messages, message] }
        return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
      },
      recordRunEvent: async (_id, event) => ({
        event: { ...event, schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION },
        summary,
      }),
      recordUsage: async () => {
        throw new Error('image attachment boundary should not persist usage')
      },
      deleteConversation: async () => {
        throw new Error('image attachment boundary should not delete conversation')
      },
    },
    runAgent: async () => {
      streamReached = true
    },
    logger: { warn() {}, error() {} },
  })

  try {
    await runtime.send({
      conversationId,
      userText: 'image without host',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      attachments: [
        {
          kind: 'image',
          name: 'missing-host.png',
          mime: 'image/png',
          data: Buffer.from('missing-host').toString('base64'),
        },
      ],
    })
    throw new Error('image attachment without host unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('runtime host cannot persist image'),
      'runtime should reject image attachments when no host persistence boundary exists',
    )
  }

  assertEqual(streamReached, false, 'image attachment rejection should not start runAgent')
  assertEqual(record.messages.length, 0, 'image attachment rejection should not persist user input')
}

async function testRuntimeRejectsInvalidHostAttachmentBlocks(): Promise<void> {
  const conversationId = 'invalid-host-attachment-block'
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'invalid host attachment block',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }

  const runtime = new WorkbenchRuntime({
    store: {
      getConversation: async () => record,
      saveMessage: async (_id, message) => {
        record = { ...record, messages: [...record.messages, message] }
        return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
      },
      recordRunEvent: async (_id, event) => ({
        event: { ...event, schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION },
        summary,
      }),
      recordUsage: async () => {
        throw new Error('invalid attachment block should not persist usage')
      },
      deleteConversation: async () => {
        throw new Error('invalid attachment block should not delete conversation')
      },
    },
    persistAttachment: async () =>
      ({ type: 'tool_call', id: 'bad-block' }) as unknown as RuntimeAttachmentBlock,
    logger: { warn() {}, error() {} },
  })

  try {
    await runtime.send({
      conversationId,
      userText: 'invalid host block',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      attachments: [{ kind: 'text', name: 'bad.txt', mime: 'text/plain', data: 'bad block' }],
    })
    throw new Error('invalid host attachment block unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('unsupported attachment block'),
      'runtime should reject unsupported host attachment block types',
    )
  }

  assertEqual(record.messages.length, 0, 'invalid host block should not persist user input')
}

async function testRuntimeHostStaticExtensionContract(): Promise<void> {
  const topLevelPack: ToolPack = {
    id: 'top-level-static-pack',
    name: 'Top Level Static Pack',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'top_level_static_tool',
            description: 'Top-level fixture tool.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          metadata: {
            name: 'top_level_static_tool',
            readOnly: true,
            destructive: false,
            requiresApproval: false,
            access: ['read'],
            scope: ['workspace'],
          },
        },
        async run() {
          return 'top-level'
        },
      },
    ],
  }
  const hostPack: ToolPack = {
    id: 'host-static-pack',
    name: 'Host Static Pack',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'host_static_tool',
            description: 'Host fixture tool.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          metadata: {
            name: 'host_static_tool',
            readOnly: true,
            destructive: false,
            requiresApproval: false,
            access: ['read'],
            scope: ['workspace'],
          },
        },
        async run() {
          return 'host'
        },
      },
    ],
  }
  const topLevelToolPacks = [topLevelPack]
  const hostToolPacks = [hostPack]

  const runtime = new WorkbenchRuntime({
    toolPacks: topLevelToolPacks,
    host: {
      toolPacks: hostToolPacks,
    },
  })
  hostPack.tools[0] = {
    ...hostPack.tools[0],
    spec: {
      ...hostPack.tools[0].spec,
      metadata: {
        ...hostPack.tools[0].spec.metadata,
      },
    },
  }
  hostToolPacks.push(topLevelPack)

  const registry = await runtime.getToolRegistry()
  assert(
    registry.specsByName.has('host_static_tool'),
    'host static tool packs should be part of the runtime host boundary',
  )
  assert(
    getToolDefinitions(registry).some(
      (definition) => definition.function.name === 'host_static_tool',
    ),
    'host static tool packs should be snapped at runtime construction',
  )
  assert(
    !registry.specsByName.has('top_level_static_tool'),
    'host static tool packs should take precedence over top-level compatibility tool packs',
  )
  registry.specsByName.delete('host_static_tool')
  registry.specs.length = 0
  const registryAgain = await runtime.getToolRegistry()
  assert(
    getToolDefinitions(registryAgain).some(
      (definition) => definition.function.name === 'host_static_tool',
    ),
    'runtime should return tool registry snapshots to callers',
  )
}

async function testRuntimeDynamicExtensionLoaderSnapshots(): Promise<void> {
  const loadedPack: ToolPack = {
    id: 'dynamic-snapshot-pack',
    name: 'Dynamic Snapshot Pack',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'dynamic_snapshot_tool',
            description: 'Loaded tool snapshot fixture.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          metadata: {
            name: 'dynamic_snapshot_tool',
            readOnly: true,
            destructive: false,
            requiresApproval: false,
            access: ['read'],
            scope: ['workspace'],
          },
        },
        async run() {
          return 'dynamic'
        },
      },
    ],
  }
  const runtime = new WorkbenchRuntime({
    loadToolPacks: async () => [loadedPack],
    logger: { warn() {}, error() {} },
  })

  const registry = await runtime.getToolRegistry()
  registry.specsByName.delete('dynamic_snapshot_tool')
  registry.specs.length = 0

  loadedPack.tools[0] = {
    ...loadedPack.tools[0],
    spec: {
      ...loadedPack.tools[0].spec,
      metadata: {
        ...loadedPack.tools[0].spec.metadata,
      },
    },
  }

  assert(
    getToolDefinitions(await runtime.getToolRegistry()).some(
      (definition) => definition.function.name === 'dynamic_snapshot_tool',
    ),
    'dynamic loaded tool packs should be snapped when loaded and returned as caller snapshots',
  )
}

async function testRuntimeInjectableStoreContract(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const calls: string[] = []
    const store: WorkbenchStore = {
      getConversation: async (conversationId) => {
        calls.push(`get:${conversationId}`)
        return getConversation(conversationId)
      },
      saveMessage: async (conversationId, message) => {
        calls.push(`upsert:${message.role}:${message.id}`)
        return upsertMessage(conversationId, message)
      },
      recordRunEvent: async (conversationId, event) => {
        calls.push(`event:${event.type}`)
        return appendRunEventAndTouchConversation(conversationId, event)
      },
      recordUsage: async (conversationId, usage) => {
        calls.push(`usage:${usage.totalTokens}`)
        return setConversationUsage(conversationId, usage)
      },
      deleteConversation: async (conversationId) => {
        calls.push(`delete:${conversationId}`)
        return deleteConversation(conversationId)
      },
    }
    const runtime = new WorkbenchRuntime({
      store,
      logger: { warn() {}, error() {} },
      runAgent: async (req, handlers) => {
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
          data: { outputBlockCount: 1 },
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'stored through injected runtime store' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'use injectable store',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'injected store stream should settle',
    )

    assert(
      calls.some((call) => call.startsWith('upsert:user:')),
      'runtime should persist user through injected store',
    )
    assert(
      calls.some((call) => call.startsWith('upsert:assistant:')),
      'runtime should persist assistant through injected store',
    )
    assert(calls.includes('event:turn.started'), 'runtime should append start event through store')
    assert(
      calls.includes('event:turn.completed'),
      'runtime should append terminal event through store',
    )
    assertEqual(calls.includes('usage:8'), true, 'runtime should persist usage through store')

    const record = await getConversation(conversation.id)
    assertEqual(record.messages.length, 2, 'injected store should preserve persisted messages')
    assertEqual(record.meta.usage?.totalTokens, 8, 'injected store should preserve usage')

    await runtime.deleteConversation(conversation.id)
    assert(
      calls.includes(`delete:${conversation.id}`),
      'runtime should delete conversation through injected store',
    )
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'injected store delete should remove persisted conversation',
    )
  })
}

async function testConversationUsageAccumulatorContract(): Promise<void> {
  const store = runtimeSdk.createInMemoryRuntimeStore()
  const conversation = await store.createConversation?.()
  assert(conversation, 'in-memory store should create a conversation for usage accumulation')
  await store.appendSessionEntry(conversation.id, {
    type: 'usage.recorded',
    timestamp: 1,
    data: {
      usage: {
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
        modelCallCount: 2,
        maxInputTokens: 7,
        lastInputTokens: 3,
        lastOutputTokens: 2,
        lastCacheReadTokens: 1,
        lastCacheMissTokens: 2,
      },
    },
  })
  await store.appendSessionEntry(conversation.id, {
    type: 'usage.recorded',
    timestamp: 2,
    data: {
      usage: {
        promptTokens: 2,
        completionTokens: 4,
        totalTokens: 6,
        modelCallCount: 1,
        maxInputTokens: 2,
        lastInputTokens: 2,
        lastOutputTokens: 4,
        lastCacheReadTokens: 1,
        lastCacheMissTokens: 1,
      },
    },
  })
  const record = await store.getConversation(conversation.id)
  assertEqual(record.meta.usage?.totalTokens, 6, 'usage snapshot should keep the latest turn total')
  assertEqual(record.meta.usage?.turnCount, 2, 'usage snapshot should count recorded turns')
  assertEqual(
    record.meta.usage?.cumulativeTotalTokens,
    14,
    'usage snapshot should accumulate total tokens across turns',
  )
  assertEqual(
    record.meta.usage?.cumulativePromptTokens,
    5,
    'usage snapshot should accumulate prompt tokens across turns',
  )
  assertEqual(record.meta.usage?.modelCallCount, 1, 'usage snapshot should keep latest call count')
  assertEqual(
    record.meta.usage?.maxInputTokens,
    2,
    'usage snapshot should keep latest max input tokens',
  )
  assertEqual(
    record.meta.usage?.lastInputTokens,
    2,
    'usage snapshot should keep latest last input tokens',
  )
  assertEqual(
    record.meta.usage?.lastOutputTokens,
    4,
    'usage snapshot should keep latest last output tokens',
  )
  assertEqual(
    record.meta.usage?.lastCacheReadTokens,
    1,
    'usage snapshot should keep latest last cache read tokens',
  )
  assertEqual(
    record.meta.usage?.lastCacheMissTokens,
    1,
    'usage snapshot should keep latest last cache miss tokens',
  )
  assertEqual(
    record.meta.usage?.cumulativeModelCallCount,
    3,
    'usage snapshot should accumulate model calls across turns',
  )
}

function createRunCheckpointFixture(conversationId: string, runId: string): runtimeSdk.RunSnapshot {
  const identity = {
    conversationId,
    turnId: `${runId}-turn`,
    runId,
  }
  return {
    schemaVersion: runtimeSdk.AILA_RUN_SNAPSHOT_SCHEMA_VERSION,
    identity,
    assistantMessageId: `${runId}-assistant`,
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    executionMode: 'agent',
    maxToolSteps: 3,
    loop: createRunCursor(identity, 'step'),
    contextRef: {
      schemaVersion: runtimeSdk.AILA_BLOB_SCHEMA_VERSION,
      blobId: `${runId}-context`,
      contentType: 'application/json',
      sizeBytes: 0,
    },
    recovery: { strategy: 'automatic' },
    revision: 1,
    createdAt: 10,
    updatedAt: 10,
    throughSeq: 1,
  }
}

async function testFileRunPersistenceSurvivesRestart(): Promise<void> {
  await withTempDataDir(async (dir) => {
    const store = runtimePackageNodeSdk.createFileRuntimeStore({
      dataDir: dir,
      createId: () => 'run-file-conversation',
    })
    const conversation = await store.createConversation?.()
    assert(conversation, 'file run store should create a conversation')
    const checkpoint = createRunCheckpointFixture(conversation.id, 'run-file-id')
    checkpoint.contextRef = await store.putBlob(conversation.id, {
      blobId: checkpoint.contextRef.blobId,
      contentType: 'application/json',
      data: { messages: [], contextPlan: {} },
    })
    await store.saveRunSnapshot(checkpoint)
    const payloadRef = await store.putBlob(conversation.id, {
      blobId: 'run-file-payload',
      contentType: 'application/json',
      data: { persisted: true },
    })
    await store.appendSessionEntry(conversation.id, {
      type: 'run.payload',
      entryId: 'run-file-payload-entry',
      timestamp: 11,
      turnId: checkpoint.identity.turnId,
      runId: checkpoint.identity.runId,
      stepId: 'run-file-step',
      payloadRef,
      data: { kind: 'inspection', label: 'Inspection' },
    })

    const reopened = runtimePackageNodeSdk.createFileRuntimeStore({ dataDir: dir })
    const loaded = await reopened.getRunSnapshot(conversation.id, checkpoint.identity.runId)
    assert(loaded, 'reopened file run store should load its checkpoint')
    assertEqual(loaded.revision, 1, 'reopened checkpoint revision')
    assertEqual(
      runtimeSdk.sessionRunPayloads(
        await reopened.listSessionEntries(conversation.id),
        checkpoint.identity.runId,
      ).length,
      1,
      'reopened file run store should load payload entries',
    )
    const concurrent = await Promise.all([
      reopened.saveRunSnapshot({ ...loaded, updatedAt: 20 }),
      reopened.saveRunSnapshot({ ...loaded, updatedAt: 21 }),
    ])
    assertEqual(
      concurrent.map((entry) => entry.revision).join(','),
      '2,3',
      'concurrent file checkpoint writes should serialize monotonic revisions',
    )
    await reopened.deleteConversation(conversation.id)
    try {
      await reopened.listRunSnapshots(conversation.id)
      throw new Error('deleted file-backed run snapshots unexpectedly remained readable')
    } catch (error) {
      assert(
        error instanceof Error && 'code' in error && error.code === 'ENOENT',
        'conversation deletion should remove file-backed runs',
      )
    }
  })
}

async function testDesktopRunPersistenceSurvivesRestart(): Promise<void> {
  await withTempDataDir(async () => {
    const store = createPersistedRuntimeStore()
    const conversation = await store.createConversation?.()
    assert(conversation, 'desktop run store should create a conversation')
    const checkpoint = createRunCheckpointFixture(conversation.id, 'run-desktop-id')
    checkpoint.contextRef = await store.putBlob(conversation.id, {
      blobId: checkpoint.contextRef.blobId,
      contentType: 'application/json',
      data: { messages: [], contextPlan: {} },
    })
    await store.saveRunSnapshot(checkpoint)
    const payloadRef = await store.putBlob(conversation.id, {
      blobId: 'run-desktop-payload',
      contentType: 'application/json',
      data: { persisted: true },
    })
    await store.appendSessionEntry(conversation.id, {
      type: 'run.payload',
      entryId: 'run-desktop-payload-entry',
      timestamp: 11,
      turnId: checkpoint.identity.turnId,
      runId: checkpoint.identity.runId,
      stepId: 'run-desktop-step',
      payloadRef,
      data: { kind: 'inspection', label: 'Inspection' },
    })

    const reopened = createPersistedRuntimeStore()
    assertEqual(
      (await reopened.getRunSnapshot(conversation.id, checkpoint.identity.runId))?.identity.runId,
      checkpoint.identity.runId,
      'desktop run checkpoint should survive a store restart',
    )
    assertEqual(
      runtimeSdk.sessionRunPayloads(
        await reopened.listSessionEntries(conversation.id),
        checkpoint.identity.runId,
      ).length,
      1,
      'desktop run artifacts should survive a store restart',
    )
    await reopened.deleteConversation(conversation.id)
  })
}

async function testRuntimeHostTransientContextUsesInjectedRecord(): Promise<void> {
  const conversationId = 'transient-context-contract'
  const calls: string[] = []
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'transient context',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let streamedContext: string | null = null
  let streamedUserMessages: string[] = []

  const store: WorkbenchStore = {
    getConversation: async (id) => {
      calls.push(`get:${id}`)
      if (id !== conversationId) throw new Error(`unexpected conversation: ${id}`)
      return record
    },
    saveMessage: async (_id, message) => {
      calls.push(`upsert:${message.role}`)
      record = { ...record, messages: [...record.messages, message] }
      return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
    },
    recordRunEvent: async (_id, event) => {
      calls.push(`event:${event.type}`)
      return {
        event: {
          ...event,
          schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
        },
        summary: { ...summary, updatedAt: summary.updatedAt + record.messages.length + 1 },
      }
    },
    recordUsage: async () => {
      throw new Error('transient context contract should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('transient context contract should not delete conversation')
    },
  }

  const runtime = new WorkbenchRuntime({
    store,
    loadTransientContext: ({ record: inputRecord, source }) => {
      const messageCount = inputRecord.messages.length
      calls.push(`context:${source}:${messageCount}`)
      inputRecord.messages.push({
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: 'host-mutated-record-message',
        role: 'user',
        blocks: [{ type: 'text', content: 'host mutated record' }],
        status: 'done',
      })
      return [
        {
          role: 'system',
          content: `host context for ${inputRecord.meta.id} with ${messageCount} messages`,
        },
      ]
    },
    runAgent: async (req, handlers) => {
      streamedContext =
        req.messages.find(
          (message): message is { role: 'system'; content: string } =>
            message.role === 'system' && message.content.includes('host context for'),
        )?.content ?? null
      streamedUserMessages = req.messages
        .filter((message): message is { role: 'user'; content: string } => message.role === 'user')
        .map((message) => message.content)
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'used host transient context' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
    logger: { warn() {}, error() {} },
  })

  await runtime.send({
    conversationId,
    userText: 'use host transient context',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await waitFor(
    () => runtime.listActiveStreams().length === 0,
    'transient context stream should settle',
  )

  assert(calls.includes(`get:${conversationId}`), 'runtime should load record through store')
  assert(
    calls.includes('context:send:1'),
    'host transient context should receive the post-user-message record',
  )
  assertEqual(
    streamedContext,
    `host context for ${conversationId} with 1 messages`,
    'host transient context should be passed to runAgent',
  )
  assert(
    !streamedUserMessages.includes('host mutated record'),
    'host transient context should not mutate streamed persisted messages through input record',
  )
  assertEqual(record.messages.length, 2, 'host transient context should not mutate store record')
}

async function testRuntimeHostStableInstructionsUsesInjectedRecord(): Promise<void> {
  const conversationId = 'stable-instructions-contract'
  const calls: string[] = []
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'stable instructions',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let streamedMessages: ChatMessage[] = []
  let streamedContextPlan: AgentContextPlan | undefined
  let stableLoaderMessageCount = 0
  let transientLoaderMessageCount = 0

  const store: WorkbenchStore = {
    getConversation: async (id) => {
      calls.push(`get:${id}`)
      if (id !== conversationId) throw new Error(`unexpected conversation: ${id}`)
      return record
    },
    saveMessage: async (_id, message) => {
      calls.push(`upsert:${message.role}`)
      record = { ...record, messages: [...record.messages, message] }
      return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
    },
    recordRunEvent: async (_id, event) => {
      calls.push(`event:${event.type}`)
      return {
        event: {
          ...event,
          schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
        },
        summary: { ...summary, updatedAt: summary.updatedAt + record.messages.length + 1 },
      }
    },
    recordUsage: async () => {
      throw new Error('stable instructions contract should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('stable instructions contract should not delete conversation')
    },
  }

  const runtime = new WorkbenchRuntime({
    store,
    loadStableInstructions: ({ record: inputRecord, source }) => {
      stableLoaderMessageCount = inputRecord.messages.length
      calls.push(`stable:${source}:${stableLoaderMessageCount}`)
      inputRecord.messages.push({
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: 'host-mutated-stable-record-message',
        role: 'user',
        blocks: [{ type: 'text', content: 'host mutated stable record' }],
        status: 'done',
      })
      return [
        {
          role: 'system',
          content: `stable instructions for ${inputRecord.meta.id}`,
        },
      ]
    },
    loadTransientContext: ({ record: inputRecord, source }) => {
      transientLoaderMessageCount = inputRecord.messages.length
      calls.push(`dynamic:${source}:${transientLoaderMessageCount}`)
      return [
        {
          role: 'system',
          content: `dynamic context for ${inputRecord.meta.id}`,
        },
      ]
    },
    runAgent: async (req, handlers) => {
      streamedMessages = req.messages
      streamedContextPlan = req.contextPlan
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'used stable instructions' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
    logger: { warn() {}, error() {} },
  })

  await runtime.send({
    conversationId,
    userText: 'use stable instructions',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await waitFor(
    () => runtime.listActiveStreams().length === 0,
    'stable instructions stream should settle',
  )

  assert(calls.includes(`get:${conversationId}`), 'runtime should load record through store')
  assert(
    calls.includes('stable:send:1'),
    'host stable instructions should receive the post-user-message record',
  )
  assert(
    calls.includes('dynamic:send:1'),
    'host transient context should receive a record isolated from stable instructions mutation',
  )
  assertEqual(
    stableLoaderMessageCount,
    1,
    'stable instructions loader should see the post-user-message record',
  )
  assertEqual(
    transientLoaderMessageCount,
    1,
    'transient context loader should not see stable instructions host mutations',
  )
  assertEqual(
    streamedMessages.map((message) => message.content).join('|'),
    `stable instructions for ${conversationId}|dynamic context for ${conversationId}|use stable instructions`,
    'runtime should place stable instructions before dynamic context and current user message',
  )
  assertEqual(
    streamedContextPlan?.sections.map((section) => section.kind).join(','),
    'stable_instructions,dynamic_context,current_user_message',
    'runtime should pass context plan sections to stream host',
  )
  assertEqual(
    streamedContextPlan?.totalMessages,
    streamedMessages.length,
    'runtime context plan should match streamed prompt message count',
  )
  assertEqual(
    streamedContextPlan?.sections.at(0)?.messageStartIndex,
    0,
    'runtime context plan should expose section message ranges',
  )
  assertEqual(
    streamedContextPlan?.sections.at(-1)?.cachePolicy,
    'no_cache',
    'runtime context plan should preserve cache policy for current user message',
  )
  assertEqual(record.messages.length, 2, 'host stable instructions should not mutate store record')
}

function testContextAssemblerSectionsContract(): void {
  assertEqual(
    typeof runtimeSdk.assembleAgentContext,
    'function',
    'runtime SDK should expose context assembler function',
  )
  assertEqual(
    typeof runtimeSdk.ContextAssembler,
    'function',
    'runtime SDK should expose context assembler class',
  )

  const baseMessages: PersistedMessage[] = [
    {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-user-old',
      role: 'user' as const,
      blocks: [{ type: 'text' as const, content: 'older request' }],
      status: 'done' as const,
    },
    {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-assistant-old',
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, content: 'older answer' }],
      status: 'done' as const,
    },
    {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-user-current',
      role: 'user' as const,
      blocks: [{ type: 'text' as const, content: 'current request' }],
      status: 'done' as const,
    },
  ]

  const assembled = runtimeSdk.assembleAgentContext({
    stableInstructions: [{ role: 'system', content: 'stable instructions' }],
    dynamicContext: [{ role: 'system', content: 'dynamic runtime context' }],
    messages: baseMessages,
    modelInfo: { model: 'contract', contextLength: 100_000 },
    providerId: 'anthropic',
  })

  assertEqual(
    assembled.sections.map((section) => section.kind).join(','),
    'stable_instructions,dynamic_context,selected_history,current_user_message',
    'context assembler should expose ordered prompt sections',
  )
  assertEqual(
    assembled.sections.map((section) => section.metadata.source).join(','),
    'runtime,runtime,conversation,user',
    'context assembler should expose section sources for cache routing',
  )
  assertEqual(
    assembled.sections.map((section) => section.metadata.cachePolicy).join(','),
    'stable,turn,conversation,no_cache',
    'context assembler should expose section cache policies',
  )
  assert(
    assembled.sections.every((section) => /^[0-9a-f]{16}$/.test(section.metadata.hash)),
    'context assembler should expose deterministic section hashes',
  )
  assert(
    assembled.sections.every((section) => section.metadata.estimatedTokens > 0),
    'context assembler should expose estimated tokens for each section',
  )
  assert(
    assembled.sections
      .filter((section) => section.metadata.cachePolicy !== 'no_cache')
      .every((section) => section.metadata.cacheKey?.includes(`:${section.kind}:`)),
    'context assembler should expose cache keys for cacheable sections',
  )
  assertEqual(
    assembled.sections.at(-1)?.metadata.cacheKey,
    null,
    'context assembler should not assign cache keys to current user messages',
  )
  assertEqual(assembled.plan.version, 1, 'context assembler should expose a versioned context plan')
  assertEqual(assembled.plan.budget.pressure, 'ok', 'context plan should expose budget pressure')
  assertEqual(
    assembled.plan.ledger.estimator.providerId,
    'anthropic',
    'context ledger should preserve provider-aware token estimator metadata',
  )
  assertEqual(
    assembled.plan.ledger.totalEstimatedTokens,
    assembled.plan.totalEstimatedTokens,
    'context ledger should mirror the plan estimated token total',
  )
  assertEqual(
    assembled.plan.budget.totalEstimatedTokens,
    assembled.plan.totalEstimatedTokens,
    'context budget should expose the same estimated token total as the plan',
  )
  assertEqual(
    assembled.plan.compaction.microcompact.clearedToolResultCount,
    0,
    'small context should not microcompact when no tool results are present',
  )
  assertEqual(
    assembled.plan.compaction.shouldAutoCompact,
    false,
    'small context should not request auto compact',
  )
  assertEqual(
    assembled.plan.totalMessages,
    assembled.messages.length,
    'context plan should account for every flattened message',
  )
  assertEqual(assembled.plan.cacheableSections, 3, 'context plan should count cacheable sections')
  assertEqual(
    assembled.plan.sections
      .map((section) => `${section.kind}:${section.messageStartIndex}-${section.messageEndIndex}`)
      .join(','),
    'stable_instructions:0-1,dynamic_context:1-2,selected_history:2-4,current_user_message:4-5',
    'context plan should expose flattened message ranges per section',
  )
  assertEqual(
    assembled.messages.map((message) => message.role).join(','),
    'system,system,user,assistant,user',
    'context assembler should preserve flattened model message order',
  )
  assertEqual(
    assembled.sections.at(-1)?.messages[0]?.role,
    'user',
    'context assembler should isolate current user message as the final section',
  )

  const viaClass = new runtimeSdk.ContextAssembler().assemble({
    transientContext: [{ role: 'system', content: 'legacy dynamic context' }],
    messages: baseMessages,
    modelInfo: { model: 'contract', contextLength: 100_000 },
  })
  assertEqual(
    viaClass.sections[0]?.kind,
    'dynamic_context',
    'context assembler should map legacy transient context into dynamic context',
  )
  assertEqual(
    viaClass.sections[0]?.metadata.cachePolicy,
    'turn',
    'legacy transient context should keep dynamic turn cache policy',
  )
  assertEqual(
    viaClass.messages[0]?.role,
    'system',
    'context assembler class should flatten assembled sections',
  )

  const toolHistory: PersistedMessage[] = Array.from({ length: 8 }, (_, index) => ({
    schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
    id: `microcompact-tool-${index}`,
    role: 'assistant' as const,
    blocks: [
      {
        type: 'tool_call' as const,
        id: `microcompact-call-${index}`,
        name: 'read',
        arguments: `{"path":"packages/agent/src/context-${index}.ts"}`,
        status: 'done' as const,
        result: `tool output ${index} ${'x'.repeat(500)}`,
      },
    ],
    status: 'done' as const,
  }))
  const microcompacted = runtimeSdk.assembleAgentContext({
    messages: [
      ...toolHistory,
      {
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: 'microcompact-current',
        role: 'user' as const,
        blocks: [{ type: 'text' as const, content: 'current request after tool history' }],
        status: 'done' as const,
      },
    ],
    modelInfo: { model: 'contract', contextLength: 100_000 },
  })
  assert(
    microcompacted.plan.compaction.microcompact.clearedToolResultCount > 0,
    'context assembler should microcompact older tool results before selection',
  )
  assert(
    microcompacted.messages.some(
      (message) => message.role === 'tool' && message.content.includes('microcompacted'),
    ),
    'microcompacted context should replace old tool result content with a stable placeholder',
  )
  assert(
    microcompacted.messages.some(
      (message) => message.role === 'tool' && message.content.includes('tool output 7'),
    ),
    'microcompacted context should keep recent tool result content intact',
  )

  const largeToolResultMessage: PersistedMessage = {
    schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
    id: 'context-large-tool-result',
    role: 'assistant' as const,
    blocks: [
      {
        type: 'text' as const,
        content: 'implemented packages/agent/src/context.ts and persisted the large tool result',
      },
      {
        type: 'tool_call' as const,
        id: 'large-tool-call',
        name: 'read_log',
        arguments: '{"path":"packages/agent/src/context.ts"}',
        status: 'done' as const,
        resultRef: {
          kind: 'file' as const,
          path: '/tmp/aila/tool-results/conversation/large-tool-call.txt',
          relativePath: 'tool-results/conversation/large-tool-call.txt',
          sizeChars: 90_000,
          preview: 'large persisted output preview',
        },
      },
    ],
    status: 'done' as const,
  }
  const largeHistory: PersistedMessage[] = Array.from({ length: 30 }, (_, index) => ({
    schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
    id: `context-large-user-${index}`,
    role: 'user' as const,
    blocks: [
      {
        type: 'text' as const,
        content: `large omitted request ${index} ${'x'.repeat(900)}`,
      },
    ],
    status: 'done' as const,
  }))
  const compacted = runtimeSdk.assembleAgentContext({
    messages: [
      largeToolResultMessage,
      ...largeHistory,
      {
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: 'context-large-current',
        role: 'user' as const,
        blocks: [{ type: 'text' as const, content: 'current request after large history' }],
        status: 'done' as const,
      },
    ],
    modelInfo: { model: 'contract', contextLength: 4_000 },
  })
  assert(
    compacted.sections.some((section) => section.kind === 'compaction_summary'),
    'context assembler should expose omitted history as a compaction summary section',
  )
  assertEqual(
    compacted.sections.find((section) => section.kind === 'compaction_summary')?.metadata
      .cachePolicy,
    'conversation',
    'compaction summaries should be eligible for conversation-scoped cache reuse',
  )
  assert(
    compacted.stats.omittedRounds > 0,
    'context assembler should report omitted rounds when history exceeds budget',
  )
  assert(
    compacted.plan.budget.fixedCharCost > 0 &&
      compacted.plan.budget.selectedHistoryCharCost >= 0 &&
      compacted.plan.budget.compactionCharCost > 0,
    'context budget plan should account for fixed, selected history, and compaction costs',
  )
  assert(
    compacted.plan.compaction.shouldAutoCompact &&
      compacted.plan.compaction.reason === 'omitted_history' &&
      compacted.plan.compaction.recommendedCheckpoint?.boundaryMessageId !== undefined,
    'context compaction plan should recommend a checkpoint when history is omitted',
  )
  assertEqual(
    compacted.sections.at(-1)?.kind,
    'current_user_message',
    'context assembler should keep current user message after compaction summary and selected history',
  )

  const checkpoint = compacted.plan.compaction.recommendedCheckpoint
  assert(checkpoint, 'compacted context should include a recommended checkpoint')
  assert(
    checkpoint.artifact.toolResults.some(
      (result) =>
        result.toolCallId === 'large-tool-call' &&
        result.relativePath === 'tool-results/conversation/large-tool-call.txt',
    ),
    'recommended checkpoint artifact should retain persisted tool result references',
  )
  assert(
    checkpoint.summary.includes('Persisted tool outputs available for rehydration'),
    'recommended checkpoint summary should render persisted tool output rehydration hints',
  )
  const withCheckpoint = runtimeSdk.assembleAgentContext({
    messages: [
      largeToolResultMessage,
      ...largeHistory,
      {
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: 'context-large-current',
        role: 'user' as const,
        blocks: [{ type: 'text' as const, content: 'current request after large history' }],
        status: 'done' as const,
      },
    ],
    modelInfo: { model: 'contract', contextLength: 4_000 },
    compactionCheckpoint: {
      schemaVersion: runtimeSdk.AILA_CONTEXT_CHECKPOINT_SCHEMA_VERSION,
      id: checkpoint.id,
      createdAt: 123,
      boundaryMessageId: checkpoint.boundaryMessageId,
      sourceMessageIds: checkpoint.sourceMessageIds,
      omittedRoundCount: checkpoint.omittedRoundCount,
      summary: checkpoint.summary,
      charCost: checkpoint.charCost,
      artifact: checkpoint.artifact,
    },
  })
  assertEqual(
    withCheckpoint.plan.compaction.activeCheckpointId,
    checkpoint.id,
    'context assembler should recognize an active checkpoint boundary',
  )
  assert(
    withCheckpoint.messages.some(
      (message) =>
        message.role === 'system' &&
        message.content.includes('Earlier conversation context checkpoint:'),
    ),
    'active checkpoint summary should be included in the assembled prompt',
  )
  assert(
    withCheckpoint.messages.some(
      (message) =>
        message.role === 'system' &&
        message.content.includes('tool-results/conversation/large-tool-call.txt'),
    ),
    'active checkpoint artifact should rehydrate persisted tool result references into the prompt',
  )
}

async function testRuntimePersistsAutoContextCheckpoint(): Promise<void> {
  const store = runtimeSdk.createInMemoryRuntimeStore()
  const conversation = await store.createConversation?.()
  assert(conversation, 'in-memory store should create a conversation')
  for (let index = 0; index < 16; index += 1) {
    await store.appendSessionEntry(conversation.id, {
      type: 'message.committed',
      timestamp: index + 1,
      data: {
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: `auto-compact-history-${index}`,
          role: 'user',
          blocks: [{ type: 'text', content: `history ${index} ${'x'.repeat(1200)}` }],
          status: 'done',
        },
      },
    })
  }

  let streamedPlan: AgentContextPlan | undefined
  let streamedAssistantMessageId: string | undefined
  let semanticSourceMessageCount = 0
  const runtime = new WorkbenchRuntime({
    store,
    getModelInfo: () => ({ model: 'small-context-contract', contextLength: 4_000 }),
    countContextTokens: async (input) => {
      assert(
        input.contextPlan.compaction.recommendedCheckpoint,
        'token preflight should receive the assembled context plan before streaming',
      )
      return {
        inputTokens: 1_234,
        method: 'contract_counter',
        providerId: input.selection.providerId,
        model: input.selection.modelId,
      }
    },
    generateContextCompactArtifact: async (input) => {
      semanticSourceMessageCount = input.sourceMessages.length
      return {
        artifact: {
          ...input.recommendedCheckpoint.artifact,
          summary: 'semantic compact artifact summary',
          decisions: ['semantic compact retained the important implementation decision'],
        },
        summary: 'semantic compact rendered summary',
      }
    },
    runAgent: async (req, handlers) => {
      streamedPlan = req.contextPlan
      streamedAssistantMessageId = req.assistantMessageId
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          modelCallCount: 1,
          maxInputTokens: 10,
          lastInputTokens: 10,
          lastOutputTokens: 5,
          lastCacheReadTokens: 6,
          lastCacheMissTokens: 4,
        },
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'done' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
  })

  await runtime.send({
    conversationId: conversation.id,
    userText: 'current request',
    selection: { providerId: 'openrouter', modelId: 'contract/small' },
  })
  await waitFor(() => streamedPlan !== undefined, 'runtime stream should receive context plan')
  const record = await store.getConversation(conversation.id)
  assert(
    record.meta.context?.checkpoint,
    'runtime should persist a recommended context checkpoint into conversation meta',
  )
  assertEqual(
    record.meta.context.checkpoint.id,
    streamedPlan?.compaction.recommendedCheckpoint?.id,
    'persisted context checkpoint should match the streamed context plan recommendation',
  )
  assert(
    record.meta.context.checkpoint.artifact,
    'runtime should persist the recommended context checkpoint artifact',
  )
  assertEqual(
    record.meta.context.checkpoint.summary,
    'semantic compact rendered summary',
    'runtime should allow a semantic compact hook to replace the persisted checkpoint summary',
  )
  assert(
    record.meta.context.checkpoint.artifact.decisions.includes(
      'semantic compact retained the important implementation decision',
    ),
    'runtime should persist semantic compact artifact fields returned by the host',
  )
  assert(
    semanticSourceMessageCount > 0,
    'semantic compact hook should receive the source messages covered by the checkpoint',
  )
  assertEqual(
    streamedPlan?.ledger.estimator.providerId,
    'openrouter',
    'runtime should pass provider id into the context token ledger',
  )
  assertEqual(
    streamedPlan?.ledger.preflight?.inputTokens,
    1_234,
    'runtime should attach provider token preflight results to the streamed context plan',
  )
  const turnLedger = record.meta.context.turns?.at(-1)
  assert(turnLedger, 'runtime should persist a per-turn context ledger entry')
  assertEqual(
    turnLedger.preflight?.inputTokens,
    1_234,
    'context turn ledger should persist provider preflight token counts',
  )
  assertEqual(
    turnLedger.usage?.totalTokens,
    15,
    'context turn ledger should persist actual model usage for the turn',
  )
  assertEqual(
    turnLedger.usage?.maxInputTokens,
    10,
    'context turn ledger should persist real max request input tokens',
  )
  assertEqual(
    turnLedger.usage?.lastOutputTokens,
    5,
    'context turn ledger should persist real last output tokens',
  )
  assertEqual(
    turnLedger.usage?.lastCacheReadTokens,
    6,
    'context turn ledger should persist real last cache read tokens',
  )
  assertEqual(
    turnLedger.compaction.recommendedCheckpointId,
    streamedPlan?.compaction.recommendedCheckpoint?.id,
    'context turn ledger should link the turn to the recommended checkpoint',
  )
  const agentEvents = runtimeSdk.sessionRunEvents(await store.listSessionEntries(conversation.id))
  const compactingEvent = agentEvents.find((event) => event.type === 'context:compacting')
  const compactedEvent = agentEvents.find((event) => event.type === 'context:compacted')
  assert(compactingEvent, 'runtime should record a context compacting activity event')
  assert(compactedEvent, 'runtime should record a context compacted activity event')
  assertEqual(
    compactingEvent.messageId,
    streamedAssistantMessageId,
    'context compacting event should attach to the assistant turn',
  )
  assertEqual(
    compactedEvent.messageId,
    streamedAssistantMessageId,
    'context compacted event should attach to the assistant turn',
  )
  assertEqual(
    compactingEvent.data?.checkpointId,
    record.meta.context.checkpoint.id,
    'context compacting event should identify the recommended checkpoint',
  )
  assertEqual(
    compactedEvent.data?.checkpointId,
    record.meta.context.checkpoint.id,
    'context compacted event should identify the persisted checkpoint',
  )
  assertEqual(
    compactedEvent.data?.preflightInputTokens,
    1_234,
    'context compacted event should include provider token preflight counts',
  )
  assertEqual(
    compactedEvent.data?.summaryChars,
    'semantic compact rendered summary'.length,
    'context compacted event should include persisted summary size',
  )
  assertEqual(
    compactedEvent.data?.compactArtifactSource,
    'model',
    'context compacted event should identify model-generated compact artifacts',
  )
  assertEqual(
    compactedEvent.data?.sourceEstimatedTokens,
    streamedPlan?.compaction.recommendedCheckpoint?.sourceEstimatedTokens,
    'context compacted event should include source history token estimate',
  )
  assertEqual(
    compactedEvent.data?.checkpointEstimatedTokens,
    Math.ceil(
      record.meta.context.checkpoint.charCost / (streamedPlan?.ledger.estimator.charsPerToken ?? 4),
    ),
    'context compacted event should include persisted checkpoint token estimate',
  )
  assert(
    typeof compactedEvent.data?.estimatedSavedTokens === 'number' &&
      compactedEvent.data.estimatedSavedTokens > 0,
    'context compacted event should include estimated saved tokens',
  )
}

async function testRuntimeManualCompactConversation(): Promise<void> {
  const store = runtimeSdk.createInMemoryRuntimeStore()
  const conversation = await store.createConversation?.()
  assert(conversation, 'in-memory store should create a conversation')
  for (let index = 0; index < 6; index += 1) {
    await store.appendSessionEntry(conversation.id, {
      type: 'message.committed',
      timestamp: index + 1,
      data: {
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: `manual-compact-history-${index}`,
          role: 'user',
          blocks: [{ type: 'text', content: `manual compact history ${index}` }],
          status: 'done',
        },
      },
    })
  }

  let semanticSourceIds: string[] = []
  const runtime = new WorkbenchRuntime({
    store,
    getModelInfo: () => ({ model: 'large-context-contract', contextLength: 128_000 }),
    countContextTokens: async (input) => ({
      inputTokens: 777,
      method: 'manual_counter',
      providerId: input.selection.providerId,
      model: input.selection.modelId,
    }),
    generateContextCompactArtifact: async (input) => {
      semanticSourceIds = input.sourceMessages.map((message) => message.id)
      return {
        artifact: {
          ...input.recommendedCheckpoint.artifact,
          summary: 'manual semantic compact artifact summary',
        },
        summary: 'manual semantic compact rendered summary',
      }
    },
  })

  const result = await runtime.compactConversation({
    conversationId: conversation.id,
    selection: { providerId: 'openrouter', modelId: 'contract/large' },
  })
  assert(result.compacted, 'manual compact should persist a checkpoint even without auto pressure')
  assert(result.checkpoint, 'manual compact result should include the persisted checkpoint')
  assertEqual(
    result.checkpoint.summary,
    'manual semantic compact rendered summary',
    'manual compact should use the semantic compact hook',
  )
  assert(
    result.checkpoint.sourceMessageIds.includes('manual-compact-history-0'),
    'manual compact should cover older history',
  )
  assert(
    !result.checkpoint.sourceMessageIds.includes('manual-compact-history-5'),
    'manual compact should keep recent history outside the checkpoint',
  )
  assert(
    semanticSourceIds.includes('manual-compact-history-0'),
    'manual compact semantic hook should receive compacted source messages',
  )
  const record = await store.getConversation(conversation.id)
  assertEqual(
    record.meta.context?.checkpoint?.id,
    result.checkpoint.id,
    'manual compact should update conversation context metadata',
  )

  const agentEvents = runtimeSdk.sessionRunEvents(await store.listSessionEntries(conversation.id))
  const compactingEvent = agentEvents.find((event) => event.type === 'context:compacting')
  const compactedEvent = agentEvents.find((event) => event.type === 'context:compacted')
  assert(compactingEvent, 'manual compact should record a compacting event')
  assert(compactedEvent, 'manual compact should record a compacted event')
  assertEqual(compactingEvent.data?.trigger, 'manual', 'manual compacting event trigger')
  assertEqual(compactedEvent.data?.trigger, 'manual', 'manual compacted event trigger')
  assertEqual(compactedEvent.data?.reason, 'manual', 'manual compacted event reason')
  assertEqual(
    compactedEvent.data?.compactArtifactSource,
    'model',
    'manual compact event should identify model-generated compact artifacts',
  )
  assertEqual(
    compactedEvent.data?.preflightInputTokens,
    777,
    'manual compact event should include provider token preflight counts',
  )
  assert(
    typeof compactedEvent.data?.sourceEstimatedTokens === 'number' &&
      compactedEvent.data.sourceEstimatedTokens > 0,
    'manual compact event should include source history token estimate',
  )
  assert(
    typeof compactedEvent.data?.estimatedSavedTokens === 'number' &&
      compactedEvent.data.estimatedSavedTokens > 0,
    'manual compact event should include estimated saved tokens',
  )
}

async function testRuntimeStreamHandlerSnapshots(): Promise<void> {
  const conversationId = 'stream-handler-snapshot-contract'
  const emitted: WorkbenchEvent[] = []
  let storedUsageTotal: number | null = null
  let record: ConversationRecord = {
    meta: {
      schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
      id: conversationId,
      title: 'stream handler snapshot',
      createdAt: 1,
      updatedAt: 1,
    },
    messages: [],
  }

  const store: WorkbenchStore = {
    getConversation: async (id) => {
      if (id !== conversationId) throw new Error(`unexpected conversation: ${id}`)
      return record
    },
    saveMessage: async (_id, message) => {
      await Promise.resolve()
      const index = record.messages.findIndex((current) => current.id === message.id)
      record =
        index >= 0
          ? {
              ...record,
              messages: record.messages.map((current, currentIndex) =>
                currentIndex === index ? message : current,
              ),
            }
          : { ...record, messages: [...record.messages, message] }
      return { ...record.meta, updatedAt: record.meta.updatedAt + record.messages.length }
    },
    recordRunEvent: async (_id, event) => ({
      event: {
        ...event,
        schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      },
      summary: { ...record.meta, updatedAt: record.meta.updatedAt + record.messages.length + 1 },
    }),
    recordUsage: async (_id, usage) => {
      storedUsageTotal = usage.totalTokens
      return {
        ...record.meta,
        updatedAt: record.meta.updatedAt + record.messages.length + 2,
        usage: { ...usage, updatedAt: 3 },
      }
    },
    deleteConversation: async () => {
      throw new Error('stream handler snapshot should not delete conversation')
    },
  }

  const runtime = new WorkbenchRuntime({
    store,
    onEvent: (event) => emitted.push(event),
    runAgent: async (req, handlers) => {
      const doneEvent = {
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant' as const,
          blocks: [{ type: 'text' as const, content: 'original stream result' }],
          status: 'done' as const,
          model: req.selection,
        },
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      } satisfies Parameters<typeof handlers.onDone>[0]
      const done = handlers.onDone(doneEvent)
      const [block] = doneEvent.message.blocks
      if (block?.type === 'text') block.content = 'mutated stream result'
      doneEvent.usage.totalTokens = 999
      await done
    },
    logger: { warn() {}, error() {} },
  })

  await runtime.send({
    conversationId,
    userText: 'snapshot stream handler event',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await waitFor(
    () => runtime.listActiveStreams().length === 0,
    'stream handler snapshot should settle',
  )

  const doneEvent = emitted.find((event) => event.type === 'chat:done')
  const doneText =
    doneEvent?.type === 'chat:done' && doneEvent.data.message.blocks[0]?.type === 'text'
      ? doneEvent.data.message.blocks[0].content
      : null
  assertEqual(
    doneText,
    'original stream result',
    'runtime should snapshot stream handler done events before host mutation',
  )
  assertEqual(
    doneEvent?.type === 'chat:done' ? doneEvent.data.usage?.totalTokens : null,
    3,
    'runtime should snapshot stream handler usage before host mutation',
  )
  assertEqual(storedUsageTotal, 3, 'runtime should persist snapshotted stream usage')
}

async function testRuntimeConversationStoreFacadeContract(): Promise<void> {
  const calls: string[] = []
  const emitted: WorkbenchEvent[] = []
  const eventsByConversation = new Map<string, PersistedRunEvent[]>()
  const summaries = new Map<string, ConversationSummary>()
  const records = new Map<string, ConversationRecord>()
  let nextId = 1

  const store: WorkbenchStore = {
    createConversation: async (workspace) => {
      const id = `injected-conversation-${nextId++}`
      calls.push(`create:${workspace?.id ?? 'no-workspace'}`)
      const summary: ConversationSummary = {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id,
        title: 'injected conversation',
        createdAt: nextId,
        updatedAt: nextId,
        ...(workspace ? { workspace: structuredClone(workspace) } : {}),
      }
      summaries.set(id, summary)
      records.set(id, { meta: summary, messages: [] })
      eventsByConversation.set(id, [
        {
          schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
          timestamp: 1,
          conversationId: id,
          messageId: 'assistant-injected-facade',
          type: 'turn.started',
          data: { providerId: 'openrouter', modelId: 'contract/mock' },
        },
      ])
      return summary
    },
    getConversation: async (conversationId) => {
      calls.push(`get:${conversationId}`)
      const record = records.get(conversationId)
      if (!record) throw new Error(`missing record: ${conversationId}`)
      return record
    },
    saveMessage: async () => {
      throw new Error('conversation facade should not upsert messages')
    },
    recordRunEvent: async () => {
      throw new Error('conversation facade should not append events')
    },
    listConversations: async () => {
      calls.push('list')
      return Array.from(summaries.values())
    },
    listRunEvents: async (conversationId) => {
      calls.push(`events:${conversationId}`)
      return eventsByConversation.get(conversationId) ?? []
    },
    renameConversation: async (conversationId, title) => {
      calls.push(`rename:${conversationId}:${title}`)
      const current = summaries.get(conversationId)
      if (!current) throw new Error(`missing summary: ${conversationId}`)
      const renamed = { ...current, title, updatedAt: current.updatedAt + 1 }
      summaries.set(conversationId, renamed)
      const record = records.get(conversationId)
      if (record) records.set(conversationId, { ...record, meta: renamed })
      return renamed
    },
    recordUsage: async () => {
      throw new Error('conversation facade should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('conversation facade should not delete conversations')
    },
  }

  const runtime = new WorkbenchRuntime({
    store,
    onEvent: (event) => {
      if (event.type === 'conversations:updated') {
        event.data.title = `event-mutated:${event.data.title}`
      }
      if (event.type === 'run:event' && event.data.data) {
        event.data.data.modelId = 'event-mutated'
      }
      emitted.push(event)
    },
    logger: { warn() {}, error() {} },
  })

  const chat = await runtime.createConversation()
  const newerThread = await runtime.createConversation()
  assertEqual(
    chat.title,
    'injected conversation',
    'runtime create should isolate returned summary from onEvent mutation',
  )
  chat.title = 'caller-mutated-chat'
  assertEqual(
    summaries.get(chat.id)?.title,
    'injected conversation',
    'runtime create should isolate store summary from caller mutation',
  )
  const listedConversations = await runtime.listConversations()
  assertEqual(listedConversations.length, 2, 'runtime should list all conversations')
  assertEqual(
    listedConversations.map((summary) => summary.id).join(','),
    `${newerThread.id},${chat.id}`,
    'runtime should sort injected store conversations by updatedAt desc',
  )
  const listedChat = listedConversations.find((summary) => summary.id === chat.id)
  if (listedChat) listedChat.title = 'caller-mutated-list'
  assertEqual(
    summaries.get(chat.id)?.title,
    'injected conversation',
    'runtime list should isolate store summaries from caller mutation',
  )
  const fetchedChat = await runtime.getConversation(chat.id)
  assertEqual(fetchedChat.meta.id, chat.id, 'runtime get conversation should delegate to store')
  fetchedChat.meta.title = 'caller-mutated-record'
  assertEqual(
    records.get(chat.id)?.meta.title,
    'injected conversation',
    'runtime get should isolate store records from caller mutation',
  )
  assertEqual(
    (await runtime.resolveConversation({ conversationId: newerThread.id })).summary.id,
    newerThread.id,
    'runtime resolve should validate and return explicit conversations',
  )
  assertEqual(
    (await runtime.resolveConversation({ resumeLatest: true })).conversationId,
    newerThread.id,
    'runtime resolve latest should not depend on injected store ordering',
  )
  const resolvedNew = await runtime.resolveConversation()
  assertEqual(resolvedNew.isExisting, false, 'runtime resolve should create missing input')
  const workspaceRef = {
    id: '/contract/workspace',
    path: '/contract/workspace',
    label: 'Contract Workspace',
  }
  const workspaceChat = await runtime.createConversation({ workspace: workspaceRef })
  assertEqual(
    workspaceChat.workspace?.id,
    '/contract/workspace',
    'runtime create should pass optional workspace metadata through the store',
  )
  if (workspaceChat.workspace) workspaceChat.workspace.label = 'caller-mutated-workspace'
  assertEqual(
    summaries.get(workspaceChat.id)?.workspace?.label,
    'Contract Workspace',
    'runtime create should isolate workspace metadata from caller mutation',
  )
  try {
    await runtime.resolveConversation({ conversationId: chat.id, resumeLatest: true })
    throw new Error('combined resolve options unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('cannot be combined'),
      'runtime resolve should reject ambiguous conversation options',
    )
  }
  const listedEvents = await runtime.listRunEvents(chat.id)
  assertEqual(listedEvents[0]?.type, 'turn.started', 'runtime list events should delegate to store')
  if (listedEvents[0]?.data) listedEvents[0].data.modelId = 'caller-mutated-event'
  assertEqual(
    eventsByConversation.get(chat.id)?.[0]?.data?.modelId,
    'contract/mock',
    'runtime list events should isolate store events from caller mutation',
  )
  const renamed = await runtime.renameConversation(chat.id, 'renamed via runtime')
  assertEqual(renamed.title, 'renamed via runtime', 'runtime rename should delegate to store')
  assertEqual(
    summaries.get(chat.id)?.title,
    'renamed via runtime',
    'runtime rename should isolate store summary from onEvent mutation',
  )
  renamed.title = 'caller-mutated-rename'
  assertEqual(
    summaries.get(chat.id)?.title,
    'renamed via runtime',
    'runtime rename should isolate store summary from caller mutation',
  )
  assert(
    emitted.filter((event) => event.type === 'conversations:updated').length >= 3,
    'runtime create and rename should emit conversation updates',
  )
  assert(
    calls.some((call) => call === `rename:${chat.id}:renamed via runtime`),
    'runtime should call injected rename',
  )
}

async function testRuntimeConversationRuntimeStateApiUsesEventReplay(): Promise<void> {
  const store = createInMemoryRuntimeStore()
  const runtime = new WorkbenchRuntime({
    store,
    logger: { warn() {}, error() {} },
  })
  const chat = await runtime.createConversation()
  const completedThread = await runtime.createConversation()

  await runtime.recordRunEvent({
    timestamp: 10,
    conversationId: chat.id,
    messageId: 'assistant-runtime-state',
    type: 'turn.started',
    data: {
      providerId: 'openrouter',
      modelId: 'contract/mock',
      inputMessageCount: 1,
    },
  })
  await runtime.recordRunEvent({
    eventId: 'runtime-state-approval',
    timestamp: 20,
    conversationId: chat.id,
    messageId: 'assistant-runtime-state',
    type: 'tool.approval.requested',
    data: {
      requestId: 'approval-runtime-state',
      toolCallId: 'tool-call-runtime-state',
      toolName: 'write',
    },
  })
  await runtime.recordRunEvent({
    eventId: 'runtime-state-approval',
    timestamp: 20,
    conversationId: chat.id,
    messageId: 'assistant-runtime-state',
    type: 'tool.approval.requested',
    data: {
      requestId: 'approval-runtime-state',
      toolCallId: 'tool-call-runtime-state',
      toolName: 'write',
    },
  })
  await runtime.recordRunEvent({
    timestamp: 30,
    conversationId: completedThread.id,
    messageId: 'assistant-completed-runtime-state',
    type: 'turn.completed',
    data: { outputBlockCount: 1 },
  })

  const state = await runtime.getConversationRuntimeState(chat.id)
  assertEqual(state.phase, 'approval', 'runtime state API should replay pending approval phase')
  assertEqual(state.active, true, 'runtime state API should report active replay state')
  assertEqual(
    state.turn?.assistantMessageId,
    'assistant-runtime-state',
    'runtime state API should expose assistant turn id',
  )
  assertEqual(
    state.turn?.selection?.modelId,
    'contract/mock',
    'runtime state API should preserve replayed model selection',
  )
  assertEqual(
    state.turn?.pendingApproval?.requestId,
    'approval-runtime-state',
    'runtime state API should preserve pending approval details',
  )

  if (state.turn?.pendingApproval) state.turn.pendingApproval.requestId = 'caller-mutated'
  const stateAgain = await runtime.getConversationRuntimeState(chat.id)
  assertEqual(
    stateAgain.turn?.pendingApproval?.requestId,
    'approval-runtime-state',
    'runtime state API should isolate replay state from caller mutation',
  )

  const hydration = await runtime.hydrateConversation(chat.id)
  assertEqual(
    hydration.record.meta.id,
    chat.id,
    'runtime hydrate should include the conversation record',
  )
  assertEqual(hydration.events.length, 2, 'runtime hydrate should include replay events')
  assertEqual(
    hydration.runtimeState.phase,
    'approval',
    'runtime hydrate should include replayed lifecycle state',
  )
  assertEqual(hydration.activeTurn, null, 'runtime hydrate should report no live active turn')
  hydration.record.meta.title = 'caller-mutated-hydration'
  const firstHydrationEvent = hydration.events[0]
  assert(firstHydrationEvent, 'runtime hydrate should include first event')
  firstHydrationEvent.data = { providerId: 'mutated', modelId: 'mutated' }
  const pendingApproval = hydration.runtimeState.turn?.pendingApproval
  assert(pendingApproval, 'runtime hydrate should include pending approval')
  pendingApproval.requestId = 'mutated-hydration'
  const hydratedAgain = await runtime.hydrateConversation(chat.id)
  assertEqual(
    hydratedAgain.record.meta.title,
    '新对话',
    'runtime hydrate should isolate records from caller mutation',
  )
  assertEqual(
    hydratedAgain.events[0]?.data?.modelId,
    'contract/mock',
    'runtime hydrate should isolate events from caller mutation',
  )
  assertEqual(
    hydratedAgain.runtimeState.turn?.pendingApproval?.requestId,
    'approval-runtime-state',
    'runtime hydrate should isolate replay state from caller mutation',
  )
  const runtimeStates = await runtime.listConversationRuntimeStates()
  assertEqual(runtimeStates.length, 2, 'runtime state list should include every thread')
  const chatState = runtimeStates.find((candidate) => candidate.conversationId === chat.id)
  assertEqual(
    chatState?.conversationId,
    chat.id,
    'runtime state list should include the active thread',
  )
  assertEqual(
    chatState?.state.phase,
    'approval',
    'runtime state list should include replay state snapshots',
  )

  const completedState = runtimeStates.find(
    (candidate) => candidate.conversationId === completedThread.id,
  )
  assertEqual(
    completedState?.conversationId,
    completedThread.id,
    'runtime state list should include the completed thread',
  )
  assertEqual(
    completedState?.state.phase,
    'completed',
    'runtime state list should replay terminal thread state',
  )
}

async function testRuntimeOptionalStoreCapabilitiesFailClosed(): Promise<void> {
  const store = createInMemoryRuntimeStore()
  const runtime = new WorkbenchRuntime({ store, logger: { warn() {}, error() {} } })
  const summary = await runtime.createConversation()
  await runtime.renameConversation(summary.id, 'required journal store')
  assertEqual(
    (await runtime.listConversations())[0]?.title,
    'required journal store',
    'runtime store should expose the complete conversation contract',
  )
  assertEqual(
    (await runtime.listRunEvents(summary.id)).length,
    0,
    'new conversations should begin without run events',
  )
  const recovered = await runtime.recoverInterruptedActivities('minimal store restart')
  assertEqual(
    recovered.length,
    0,
    'complete store recovery should be a no-op when no run is interrupted',
  )
}

async function testInMemoryRuntimeStoreEventListContract(): Promise<void> {
  const store = createInMemoryRuntimeStore()
  const summary = await store.createConversation?.()
  assert(summary, 'in-memory runtime store should create conversations')
  const workspaceSummary = await store.createConversation?.({
    id: '/memory/workspace',
    path: '/memory/workspace',
    label: 'Memory Workspace',
  })
  assert(workspaceSummary, 'in-memory runtime store should create workspace conversations')
  assertEqual(
    workspaceSummary.workspace?.label,
    'Memory Workspace',
    'in-memory runtime store should persist optional workspace metadata',
  )
  if (workspaceSummary.workspace) workspaceSummary.workspace.label = 'caller-mutated'
  assertEqual(
    (await store.getConversation(workspaceSummary.id)).meta.workspace?.label,
    'Memory Workspace',
    'in-memory runtime store should isolate workspace metadata from caller mutation',
  )

  const laterEvent: PersistedRunEvent = {
    schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
    timestamp: 20,
    conversationId: summary.id,
    messageId: 'assistant-memory-events',
    type: 'tool.requested',
    data: { toolName: 'read' },
  }
  const earlierEvent: PersistedRunEvent = {
    schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
    timestamp: 10,
    conversationId: summary.id,
    messageId: 'assistant-memory-events',
    type: 'turn.started',
    data: { providerId: 'openrouter', modelId: 'contract/mock' },
  }

  await store.appendSessionEntry(summary.id, {
    type: 'run.event',
    entryId: 'memory-event-later',
    timestamp: laterEvent.timestamp,
    data: { event: laterEvent },
  })
  await store.appendSessionEntry(summary.id, {
    type: 'run.event',
    entryId: 'memory-event-earlier',
    timestamp: earlierEvent.timestamp,
    data: { event: earlierEvent },
  })
  await store.appendSessionEntry(summary.id, {
    type: 'run.event',
    entryId: 'memory-event-earlier',
    timestamp: earlierEvent.timestamp,
    data: { event: earlierEvent },
  })

  const listed = runtimeSdk.sessionRunEvents(await store.listSessionEntries(summary.id))
  assertEqual(listed.length, 2, 'in-memory event list should deduplicate replay events')
  assertEqual(listed[0]?.timestamp, 20, 'durable journal order should follow allocated sequence')
  assertEqual(listed[0]?.seq, 2, 'first event follows the session-created journal entry')
  assertEqual(listed[1]?.timestamp, 10, 'timestamps should not reorder durable journal entries')
  assertEqual(listed[1]?.seq, 3, 'second event should own the next journal sequence')

  if (listed[1]?.data) listed[1].data.modelId = 'mutated'
  const relisted = runtimeSdk.sessionRunEvents(await store.listSessionEntries(summary.id))
  assertEqual(
    relisted[1]?.data?.modelId,
    'contract/mock',
    'in-memory event list should return snapshots',
  )

  await store.deleteConversation(summary.id)
  try {
    await store.listSessionEntries(summary.id)
    throw new Error('deleted session journal unexpectedly remained readable')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('conversation not found'),
      'deleted session journal should no longer exist',
    )
  }
}

async function testRuntimeEnvironmentContract(): Promise<void> {
  const ids = ['conversation-env-id', 'user-env-id', 'assistant-env-id']
  const timestamps = [100, 200, 300, 400]
  const emitted: WorkbenchEvent[] = []
  const runtime = new WorkbenchRuntime({
    createId: () => {
      const id = ids.shift()
      if (!id) throw new Error('runtime requested an unexpected id')
      return id
    },
    now: () => {
      const timestamp = timestamps.shift()
      if (timestamp === undefined) throw new Error('runtime requested an unexpected timestamp')
      return timestamp
    },
    onEvent: (event) => emitted.push(event),
    logger: { warn() {}, error() {} },
  })

  const conversation = await runtime.createConversation()
  assertEqual(conversation.id, 'conversation-env-id', 'runtime should use injected id for create')
  assertEqual(conversation.createdAt, 100, 'runtime should use injected clock for createdAt')
  assertEqual(conversation.updatedAt, 100, 'runtime should use injected clock for updatedAt')

  const result = await runtime.send({
    conversationId: conversation.id,
    userText: 'deterministic environment',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  assertEqual(result.userMessage.id, 'user-env-id', 'runtime should use injected id for user')
  assertEqual(
    result.assistantMessageId,
    'assistant-env-id',
    'runtime should use injected id for assistant',
  )

  const record = await runtime.getConversation(conversation.id)
  assertEqual(record.meta.updatedAt, 400, 'runtime should use injected event time for activity')
  assertEqual(record.messages[0]?.id, 'user-env-id', 'recorded user id')
  assertEqual(record.messages[1]?.id, 'assistant-env-id', 'recorded assistant id')
  assertEqual(record.messages[1]?.status, 'error', 'hostless assistant status')

  const failedEvent = emitted.find(
    (event) => event.type === 'run:event' && event.data.type === 'turn.failed',
  )
  assert(failedEvent?.type === 'run:event', 'runtime should emit setup failure event')
  assertEqual(
    failedEvent.data.timestamp,
    400,
    'runtime should timestamp events from injected clock',
  )
  assertEqual(ids.length, 0, 'runtime should consume expected injected ids')
  assertEqual(timestamps.length, 0, 'runtime should consume expected injected timestamps')
}

async function testRuntimeAppendUserMessageUsesInjectedStore(): Promise<void> {
  const conversationId = 'append-user-message-contract'
  const calls: string[] = []
  const emitted: WorkbenchEvent[] = []
  const store: WorkbenchStore = {
    getConversation: async () => {
      throw new Error('append user message should not read conversation')
    },
    saveMessage: async (id, message) => {
      calls.push(`upsert:${id}:${message.role}`)
      const [block] = message.blocks
      if (block?.type === 'text') block.content = 'store-mutated-message'
      const summary: ConversationSummary = {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id,
        title: 'append user message',
        createdAt: 1,
        updatedAt: 2,
      }
      return summary
    },
    recordRunEvent: async () => {
      throw new Error('append user message should not append agent events')
    },
    recordUsage: async () => {
      throw new Error('append user message should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('append user message should not delete conversation')
    },
  }

  const runtime = new WorkbenchRuntime({
    store,
    onEvent: (event) => emitted.push(event),
    logger: { warn() {}, error() {} },
  })
  const message = await runtime.appendUserMessage({
    conversationId,
    text: '[local command]\nresult',
  })

  assertEqual(message.role, 'user', 'runtime append user message role')
  assertEqual(
    message.blocks[0]?.type === 'text' ? message.blocks[0].content : '',
    '[local command]\nresult',
    'runtime append user message content',
  )
  assertEqual(
    calls.join(','),
    `upsert:${conversationId}:user`,
    'runtime append user message should use injected store',
  )
  assert(
    emitted.some(
      (event) => event.type === 'conversations:updated' && event.data.id === conversationId,
    ),
    'runtime append user message should emit conversation update',
  )
}

async function testRuntimeRecordRunEventUsesInjectedStore(): Promise<void> {
  const conversationId = 'record-agent-event-contract'
  const calls: string[] = []
  const emitted: WorkbenchEvent[] = []
  let persistedFromStore: PersistedRunEvent | undefined
  let summaryFromStore: ConversationSummary | undefined
  const store: WorkbenchStore = {
    getConversation: async () => {
      throw new Error('record agent event should not read conversation')
    },
    saveMessage: async () => {
      throw new Error('record agent event should not upsert messages')
    },
    recordRunEvent: async (id, event) => {
      calls.push(`event:${id}:${event.type}`)
      if (event.data) event.data.requestId = 'store-mutated-request'
      persistedFromStore = {
        ...event,
        schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      }
      summaryFromStore = {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id,
        title: 'record agent event',
        createdAt: 1,
        updatedAt: 3,
      }
      return {
        event: persistedFromStore,
        summary: summaryFromStore,
      }
    },
    recordUsage: async () => {
      throw new Error('record agent event should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('record agent event should not delete conversation')
    },
  }

  const runtime = new WorkbenchRuntime({
    store,
    onEvent: (event) => {
      if (event.type === 'run:event' && event.data.data) {
        event.data.data.requestId = 'event-mutated-request'
      }
      if (event.type === 'conversations:updated') {
        event.data.title = 'event-mutated-summary'
      }
      emitted.push(event)
    },
    logger: { warn() {}, error() {} },
  })
  const inputEvent: RuntimeRecordRunEventInput = {
    timestamp: 2,
    conversationId,
    messageId: 'assistant-message',
    type: 'tool.approval.requested',
    data: { requestId: 'approval-request', toolName: 'write_file' },
  }
  const recorded = await runtime.recordRunEvent(inputEvent)

  assertEqual(recorded, true, 'runtime record agent event result')
  assertEqual(
    inputEvent.data?.requestId,
    'approval-request',
    'runtime record should isolate caller event from store mutation',
  )
  assertEqual(
    persistedFromStore?.data?.requestId,
    'store-mutated-request',
    'runtime record should isolate persisted event from onEvent mutation',
  )
  assertEqual(
    summaryFromStore?.title,
    'record agent event',
    'runtime record should isolate persisted summary from onEvent mutation',
  )
  assertEqual(
    calls.join(','),
    `event:${conversationId}:tool.approval.requested`,
    'runtime record agent event should use injected store',
  )
  assert(
    emitted.some(
      (event) =>
        event.type === 'run:event' &&
        event.data.conversationId === conversationId &&
        event.data.type === 'tool.approval.requested',
    ),
    'runtime record agent event should emit persisted agent event',
  )
  assert(
    emitted.some(
      (event) => event.type === 'conversations:updated' && event.data.id === conversationId,
    ),
    'runtime record agent event should emit conversation update',
  )
}

async function testRuntimeRecoveryDelegatesToInjectedStore(): Promise<void> {
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: 'delegated-recovery',
    title: 'delegated recovery',
    createdAt: 1,
    updatedAt: 2,
  }
  const recoveredEvent: PersistedRunEvent = {
    schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
    timestamp: 2,
    conversationId: summary.id,
    messageId: 'delegated-assistant',
    type: 'turn.interrupted',
    data: { reason: 'delegated' },
  }
  let delegatedReason: string | undefined
  const events: WorkbenchEvent[] = []
  const store: WorkbenchStore = {
    getConversation: async () => {
      throw new Error('delegated recovery should not read conversations directly')
    },
    saveMessage: async () => {
      throw new Error('delegated recovery should not upsert messages')
    },
    recordRunEvent: async () => {
      throw new Error('delegated recovery should not append directly')
    },
    recoverInterruptedActivities: async (reason) => {
      delegatedReason = reason
      return [{ event: recoveredEvent, summary }]
    },
    recordUsage: async () => {
      throw new Error('delegated recovery should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('delegated recovery should not delete conversations')
    },
  }

  const runtime = new WorkbenchRuntime({
    store,
    onEvent: (event) => {
      if (event.type === 'conversations:updated') event.data.title = 'event-mutated recovery'
      events.push(event)
    },
    logger: { warn() {}, error() {} },
  })
  const recovered = await runtime.recoverInterruptedActivities('delegated host restart')

  assertEqual(delegatedReason, 'delegated host restart', 'runtime should pass recovery reason')
  assertEqual(recovered[0]?.id, 'delegated-recovery', 'runtime should return delegated recovery')
  assertEqual(
    summary.title,
    'delegated recovery',
    'delegated recovery should isolate store summary from onEvent mutation',
  )
  if (recovered[0]) recovered[0].title = 'caller-mutated recovery'
  assertEqual(
    summary.title,
    'delegated recovery',
    'delegated recovery should isolate store summary from caller mutation',
  )
  assert(
    events.some(
      (event) => event.type === 'conversations:updated' && event.data.id === 'delegated-recovery',
    ),
    'delegated recovery should emit conversation update',
  )
  assert(
    events.some(
      (event) => event.type === 'run:event' && event.data.conversationId === 'delegated-recovery',
    ),
    'delegated recovery should emit recovered agent event',
  )
}

async function testRuntimeRecoveryUsesInjectedStoreReplay(): Promise<void> {
  const conversationId = 'injected-replay-recovery'
  let summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'injected replay recovery',
    createdAt: 1,
    updatedAt: 10,
    activity: {
      state: 'running',
      title: 'Model streaming',
      updatedAt: 10,
      eventType: 'turn.started',
      messageId: 'assistant-injected-recovery',
      detail: 'contract/mock',
    },
  }
  const storedEvents: PersistedRunEvent[] = [
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 10,
      conversationId,
      messageId: 'assistant-injected-recovery',
      type: 'turn.started',
      data: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  ]
  const calls: string[] = []
  const emitted: WorkbenchEvent[] = []
  let appendedEvent: PersistedRunEvent | undefined
  const store: WorkbenchStore = {
    getConversation: async () => {
      throw new Error('injected replay recovery should not read a conversation record')
    },
    saveMessage: async () => {
      throw new Error('injected replay recovery should not upsert messages')
    },
    listConversations: async () => {
      calls.push('list-conversations')
      return [summary]
    },
    listRunEvents: async (id) => {
      calls.push(`list-events:${id}`)
      return storedEvents
    },
    recordRunEvent: async (id, event) => {
      calls.push(`append:${event.type}:${id}`)
      appendedEvent = {
        schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
        ...event,
      }
      storedEvents.push(appendedEvent)
      summary = {
        ...summary,
        updatedAt: event.timestamp,
        activity: replayConversationActivity(storedEvents),
      }
      return { event: appendedEvent, summary }
    },
    recordUsage: async () => {
      throw new Error('injected replay recovery should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('injected replay recovery should not delete conversations')
    },
  }

  const runtime = new WorkbenchRuntime({
    store,
    onEvent: (event) => emitted.push(event),
    logger: { warn() {}, error() {} },
  })
  const recovered = await runtime.recoverInterruptedActivities('injected host restart')

  assertEqual(
    calls.join(','),
    `list-conversations,list-events:${conversationId},append:turn.interrupted:${conversationId}`,
    'runtime should recover through injected store methods',
  )
  assertEqual(appendedEvent?.type, 'turn.interrupted', 'injected replay should append interrupted')
  assertEqual(
    appendedEvent?.data?.previousEventType,
    'turn.started',
    'injected replay should preserve previous event',
  )
  assertEqual(
    appendedEvent?.data?.modelId,
    'contract/mock',
    'injected replay should preserve model id',
  )
  assertEqual(recovered[0]?.activity?.state, 'interrupted', 'injected replay recovered state')
  assert(
    emitted.some((event) => event.type === 'run:event' && event.data.type === 'turn.interrupted'),
    'injected replay recovery should emit agent event',
  )
  assert(
    emitted.some(
      (event) =>
        event.type === 'conversations:updated' && event.data.activity?.state === 'interrupted',
    ),
    'injected replay recovery should emit conversation update',
  )
}

async function testRuntimeDeleteAssetCleanupHostBoundary(): Promise<void> {
  await withTempDataDir(async () => {
    let getCalledWithoutHook = false
    let deleteCalledWithoutHook = false
    const withoutCleanupStore: WorkbenchStore = {
      getConversation: async () => {
        getCalledWithoutHook = true
        throw new Error('delete without cleanup hook should not read conversation')
      },
      saveMessage: async () => {
        throw new Error('not used')
      },
      recordRunEvent: async () => {
        throw new Error('not used')
      },
      recordUsage: async () => {
        throw new Error('not used')
      },
      deleteConversation: async () => {
        deleteCalledWithoutHook = true
      },
    }
    const runtimeWithoutCleanup = new WorkbenchRuntime({
      store: withoutCleanupStore,
      logger: { warn() {}, error() {} },
    })

    await runtimeWithoutCleanup.deleteConversation('delete-without-cleanup-hook')
    assertEqual(
      getCalledWithoutHook,
      false,
      'runtime delete should not read conversation when no asset cleanup host exists',
    )
    assertEqual(
      deleteCalledWithoutHook,
      true,
      'runtime delete should still delete through store without asset cleanup host',
    )

    const order: string[] = []
    const record: ConversationRecord = {
      meta: {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id: 'delete-with-cleanup-hook',
        title: 'cleanup',
        createdAt: 1,
        updatedAt: 2,
      },
      messages: [
        {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: 'assistant-image',
          role: 'assistant',
          blocks: [{ type: 'image', url: 'aila-image://i/contract.png', mime: 'image/png' }],
          status: 'done',
        },
      ],
    }
    const withCleanupStore: WorkbenchStore = {
      getConversation: async (conversationId) => {
        order.push(`get:${conversationId}`)
        return record
      },
      saveMessage: async () => {
        throw new Error('not used')
      },
      recordRunEvent: async () => {
        throw new Error('not used')
      },
      recordUsage: async () => {
        throw new Error('not used')
      },
      deleteConversation: async (conversationId) => {
        order.push(`delete:${conversationId}`)
      },
    }
    const runtimeWithCleanup = new WorkbenchRuntime({
      store: withCleanupStore,
      host: {
        cleanupConversationAssets: (cleanupRecord) => {
          order.push(`cleanup:${cleanupRecord.meta.id}`)
          cleanupRecord.meta.title = 'cleanup-mutated-title'
          cleanupRecord.messages.push({
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: 'cleanup-mutated-message',
            role: 'assistant',
            blocks: [{ type: 'text', content: 'cleanup mutated message' }],
            status: 'done',
          })
        },
      },
      logger: { warn() {}, error() {} },
    })

    await runtimeWithCleanup.deleteConversation('delete-with-cleanup-hook')
    assertEqual(
      order.join(','),
      'get:delete-with-cleanup-hook,cleanup:delete-with-cleanup-hook,delete:delete-with-cleanup-hook',
      'runtime delete should delegate asset cleanup to host before store delete',
    )
    assertEqual(
      record.meta.title,
      'cleanup',
      'runtime delete should isolate store record from cleanup host mutation',
    )
    assertEqual(
      record.messages.length,
      1,
      'runtime delete should isolate store messages from cleanup host mutation',
    )
  })
}

async function testRuntimeRetriesDanglingUserTurn(): Promise<void> {
  await withTempDataDir(async () => {
    const previousOpenRouterKey = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = ''
    try {
      const conversation = await createConversation()
      await appendMessage(conversation.id, {
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: 'dangling-user',
        role: 'user',
        blocks: [{ type: 'text', content: 'recover this interrupted turn' }],
        status: 'done',
      })

      const events: WorkbenchEvent[] = []
      const runtime = new WorkbenchRuntime({
        store: createPersistedRuntimeStore(),
        onEvent: (event) => events.push(event),
        logger: { warn() {}, error() {} },
      })

      const result = await runtime.retryLastUserMessage({
        conversationId: conversation.id,
        selection: { providerId: 'openrouter', modelId: 'minimax/minimax-m3' },
      })

      assertEqual(
        result.userMessage.id,
        'dangling-user',
        'retry should reuse dangling user message',
      )
      await waitFor(
        () => events.some((event) => event.type === 'chat:error'),
        'retry did not emit expected no-key error event',
      )
      await runtime.abortAll()

      const record = await getConversation(conversation.id)
      assertEqual(
        record.messages.filter((message) => message.role === 'user').length,
        1,
        'retry must not append a duplicate user message',
      )
      assertEqual(record.messages.length, 2, 'retry should append exactly one assistant message')
      assertEqual(record.messages[1]?.role, 'assistant', 'retry assistant response persisted')
    } finally {
      if (previousOpenRouterKey === undefined) {
        delete process.env.OPENROUTER_API_KEY
      } else {
        process.env.OPENROUTER_API_KEY = previousOpenRouterKey
      }
    }
  })
}

async function testRuntimeRetriesFailedAssistantTurn(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'failed-turn-user',
      role: 'user',
      blocks: [{ type: 'text', content: 'retry the failed assistant turn' }],
      status: 'done',
    })
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'failed-assistant',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'partial failed output should not be retried' }],
      status: 'error',
      error: 'Aborted',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    const events: WorkbenchEvent[] = []
    let modelInput = ''
    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      runAgent: async (req, handlers) => {
        modelInput = JSON.stringify(req.messages)
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
          data: { outputBlockCount: 1 },
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'retried successfully' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    const result = await runtime.retryLastUserMessage({
      conversationId: conversation.id,
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    assertEqual(
      result.userMessage.id,
      'failed-turn-user',
      'retry should reuse the user before the failed assistant turn',
    )
    await waitFor(
      () => events.some((event) => event.type === 'chat:done'),
      'retry should complete the replacement assistant turn',
    )

    assert(
      modelInput.includes('retry the failed assistant turn'),
      'retry context should include the original user request',
    )
    assert(
      !modelInput.includes('partial failed output should not be retried'),
      'retry context should exclude the failed assistant output',
    )

    const record = await getConversation(conversation.id)
    assertEqual(
      record.messages.filter((message) => message.role === 'user').length,
      1,
      'retrying failed assistant must not duplicate the user message',
    )
    assertEqual(
      record.messages.filter((message) => message.role === 'assistant').length,
      2,
      'retrying failed assistant should append one replacement assistant message',
    )
    assertEqual(
      record.messages[1]?.status,
      'error',
      'failed assistant should remain in persisted history',
    )
    assertEqual(record.messages[2]?.status, 'done', 'replacement assistant should be persisted')
  })
}

async function testRuntimeContextSkipsNonDoneAssistantHistory(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-user-before-error',
      role: 'user',
      blocks: [{ type: 'text', content: 'request before failed assistant' }],
      status: 'done',
    })
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-failed-assistant',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'failed partial output should be excluded' }],
      status: 'error',
      error: 'provider failed',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-streaming-assistant',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'legacy streaming output should be excluded' }],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    let modelInput = ''
    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      runAgent: async (req, handlers) => {
        modelInput = JSON.stringify(req.messages)
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
          data: { outputBlockCount: 1 },
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'continued after failed history' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'continue after failed assistant',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    assert(
      modelInput.includes('request before failed assistant'),
      'context should keep user history before failed assistant',
    )
    assert(
      modelInput.includes('continue after failed assistant'),
      'context should include current user request',
    )
    assert(
      !modelInput.includes('failed partial output should be excluded'),
      'context should exclude failed assistant output',
    )
    assert(
      !modelInput.includes('legacy streaming output should be excluded'),
      'context should exclude legacy streaming assistant output',
    )
  })
}

async function testRuntimeSerializesConcurrentTurnStarts(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveFirstSetupStarted: () => void = () => {}
    let releaseFirstSetup: () => void = () => {}
    let resolveSecondSetupStarted: () => void = () => {}
    const firstSetupStarted = new Promise<void>((resolve) => {
      resolveFirstSetupStarted = resolve
    })
    const firstSetupRelease = new Promise<void>((resolve) => {
      releaseFirstSetup = resolve
    })
    const secondSetupStarted = new Promise<void>((resolve) => {
      resolveSecondSetupStarted = resolve
    })
    let transientContextCalls = 0
    let streamCount = 0
    let secondModelInput = ''

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      loadTransientContext: async () => {
        transientContextCalls += 1
        if (transientContextCalls === 1) {
          resolveFirstSetupStarted()
          await firstSetupRelease
        } else if (transientContextCalls === 2) {
          resolveSecondSetupStarted()
        }
        return undefined
      },
      runAgent: async (req, handlers) => {
        streamCount += 1
        const callIndex = streamCount
        if (callIndex === 2) secondModelInput = JSON.stringify(req.messages)
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
          data: { outputBlockCount: 1 },
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                content: callIndex === 1 ? 'first serialized answer' : 'second serialized answer',
              },
            ],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    const firstSend = runtime.send({
      conversationId: conversation.id,
      userText: 'first concurrent turn',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await firstSetupStarted

    const secondSend = runtime.send({
      conversationId: conversation.id,
      userText: 'second concurrent turn',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    const setupRace = await Promise.race([
      secondSetupStarted.then(() => 'second-started'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 30)),
    ])
    assertEqual(setupRace, 'blocked', 'second turn setup should wait for first turn registration')

    const duringFirstSetup = await getConversation(conversation.id)
    assertEqual(
      duringFirstSetup.messages.filter((message) => message.role === 'user').length,
      1,
      'concurrent second send must not append a user message before the first turn is registered',
    )
    assert(
      !JSON.stringify(duringFirstSetup.messages).includes('second concurrent turn'),
      'concurrent second send should not leak into first turn history',
    )

    releaseFirstSetup()
    await firstSend
    await secondSetupStarted
    await secondSend
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'serialized concurrent turns should both finish',
    )

    const record = await getConversation(conversation.id)
    assertEqual(streamCount, 2, 'runtime should still run both serialized turns')
    assertEqual(record.messages.length, 4, 'serialized sends should persist two full turns')
    assertEqual(record.messages[0]?.role, 'user', 'first serialized message role')
    assertEqual(record.messages[1]?.role, 'assistant', 'first serialized answer role')
    assertEqual(record.messages[2]?.role, 'user', 'second serialized message role')
    assertEqual(record.messages[3]?.role, 'assistant', 'second serialized answer role')
    assert(
      secondModelInput.includes('first serialized answer'),
      'second turn context should include the completed first assistant turn',
    )
    assert(
      secondModelInput.includes('second concurrent turn'),
      'second turn context should include the second user request',
    )
  })
}

async function testRuntimeAbortCancelsTurnSetupBeforeStreamStarts(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: WorkbenchEvent[] = []
    let resolveSetupStarted: () => void = () => {}
    let releaseSetup: () => void = () => {}
    const setupStarted = new Promise<void>((resolve) => {
      resolveSetupStarted = resolve
    })
    const setupRelease = new Promise<void>((resolve) => {
      releaseSetup = resolve
    })
    let streamStarted = false
    let cleanupReason: string | null = null

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      onConversationAbort: (_conversationId, reason) => {
        cleanupReason = reason
      },
      loadTransientContext: async () => {
        resolveSetupStarted()
        await setupRelease
        return undefined
      },
      runAgent: async () => {
        streamStarted = true
      },
    })

    const sending = runtime.send({
      conversationId: conversation.id,
      userText: 'abort while setup is loading',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await setupStarted

    const [active] = runtime.listActiveStreams()
    assert(active, 'setup-stage turn should be visible as active')
    assertEqual(active.conversationId, conversation.id, 'setup-stage active conversation id')
    assertEqual(active.selection.modelId, 'contract/mock', 'setup-stage active model')

    const aborting = runtime.abort(conversation.id)
    await waitFor(() => cleanupReason === 'user', 'setup abort should notify host cleanup')
    releaseSetup()
    const result = await sending
    await aborting

    assertEqual(streamStarted, false, 'aborted setup should not start provider stream')
    assertEqual(runtime.listActiveStreams().length, 0, 'aborted setup should clear active turn')
    assertEqual(
      result.assistantMessageId,
      active.assistantMessageId,
      'send result should match setup-stage active assistant id',
    )

    const agentEvents = await listRunEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'requested' &&
          event.data.reason === 'user',
      ),
      'setup abort should persist cancellation request',
    )
    assert(
      agentEvents.some(
        (event) =>
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'completed' &&
          event.messageId === active.assistantMessageId,
      ),
      'setup abort should persist completed cancellation',
    )
    assert(
      !agentEvents.some((event) => event.type === 'turn.failed'),
      'setup abort should not be recorded as a setup failure',
    )
    assert(
      events.some(
        (event) =>
          event.type === 'chat:error' &&
          event.data.messageId === active.assistantMessageId &&
          event.data.error === 'Aborted',
      ),
      'setup abort should emit chat:error for the assistant placeholder',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.messages.length, 2, 'setup abort should persist user and assistant')
    assertEqual(record.messages[1]?.id, active.assistantMessageId, 'setup abort assistant id')
    assertEqual(record.messages[1]?.status, 'error', 'setup abort assistant status')
    assertEqual(record.messages[1]?.error, 'Aborted', 'setup abort assistant error')
    assertEqual(record.meta.activity?.state, 'cancelled', 'setup abort activity state')
  })
}

async function testRuntimeSendRecoversTimedOutTurnSetupLock(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveFirstSetupStarted: () => void = () => {}
    const firstSetupStarted = new Promise<void>((resolve) => {
      resolveFirstSetupStarted = resolve
    })
    let cleanupReason: string | null = null
    let transientContextCalls = 0
    let streamCount = 0
    let firstSendSettled = false

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      logger: { warn() {}, error() {} },
      onConversationAbort: (_conversationId, reason) => {
        cleanupReason = reason
      },
      loadTransientContext: async () => {
        transientContextCalls += 1
        if (transientContextCalls === 1) {
          resolveFirstSetupStarted()
          await new Promise<void>(() => {})
        }
        return undefined
      },
      runAgent: async (req, handlers) => {
        streamCount += 1
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'replacement after setup timeout' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    void runtime
      .send({
        conversationId: conversation.id,
        userText: 'setup will not finish',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      })
      .then(
        () => {
          firstSendSettled = true
        },
        () => {
          firstSendSettled = true
        },
      )
    await firstSetupStarted

    const [active] = runtime.listActiveStreams()
    assert(active, 'stuck setup-stage turn should be visible as active')
    assertEqual(active.conversationId, conversation.id, 'stuck setup active conversation id')

    await withTimeout(runtime.abort(conversation.id), 'abort should time out setup cleanup', 500)
    assertEqual(cleanupReason, 'user', 'stuck setup abort cleanup reason')
    assertEqual(runtime.listActiveStreams().length, 0, 'stuck setup abort should clear active turn')

    const replacement = await withTimeout(
      runtime.send({
        conversationId: conversation.id,
        userText: 'replacement should start',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      }),
      'send should recover after a timed-out setup turn',
      500,
    )
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'replacement after stuck setup should finish',
    )

    assertEqual(firstSendSettled, false, 'stuck setup send should remain abandoned')
    assertEqual(transientContextCalls, 2, 'replacement should run a fresh setup phase')
    assertEqual(streamCount, 1, 'only replacement turn should reach provider stream')

    const agentEvents = await listRunEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.messageId === active.assistantMessageId &&
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'requested' &&
          event.data.reason === 'user',
      ),
      'stuck setup abort should persist cancellation request',
    )
    assert(
      agentEvents.some(
        (event) =>
          event.messageId === active.assistantMessageId &&
          event.type === 'turn.interrupted' &&
          event.data?.reason === 'user cleanup timed out',
      ),
      'stuck setup abort should mark the abandoned turn interrupted',
    )
    assert(
      agentEvents.some(
        (event) =>
          event.messageId === replacement.assistantMessageId && event.type === 'turn.completed',
      ),
      'replacement turn after stuck setup should complete',
    )

    const record = await getConversation(conversation.id)
    assert(
      !record.messages.some((message) => message.id === active.assistantMessageId),
      'abandoned setup turn must not persist an assistant message',
    )
    assert(
      record.messages.some(
        (message) =>
          message.id === replacement.assistantMessageId &&
          message.role === 'assistant' &&
          message.status === 'done',
      ),
      'replacement assistant message should be persisted',
    )
  })
}

async function testRuntimeAbortPersistsCancellationActivity(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: WorkbenchEvent[] = []
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      runAgent: async (req, handlers) => {
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve()
            return
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
      },
    })

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'cancel this turn',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started
    await runtime.abort(conversation.id)

    await waitFor(
      () => events.some((event) => event.type === 'chat:error'),
      'abort should complete the active stream with an error message',
    )
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'run:event' &&
            event.data.type === 'turn.cancelled' &&
            event.data.data?.phase === 'completed',
        ),
      'abort should persist completed cancellation activity',
    )

    const agentEvents = await listRunEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) => event.type === 'turn.cancelled' && event.data?.phase === 'requested',
      ),
      'abort should persist user cancellation request',
    )
    assert(
      agentEvents.some(
        (event) => event.type === 'turn.cancelled' && event.data?.phase === 'completed',
      ),
      'abort should persist completed cancellation',
    )
    assert(
      !agentEvents.some((event) => event.type === 'turn.failed'),
      'abort should not be classified as a failed turn',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'cancelled', 'aborted activity state')
    assertEqual(record.meta.activity?.title, 'Stopped', 'aborted activity title')
    assertEqual(
      record.meta.activity?.messageId,
      result.assistantMessageId,
      'aborted activity should point at the assistant turn',
    )
    assertEqual(record.messages.length, 2, 'abort should persist user and assistant messages')
    assertEqual(record.messages[1]?.status, 'error', 'aborted assistant message status')
    assertEqual(record.messages[1]?.error, 'Aborted', 'aborted assistant message error')
  })
}

async function testRuntimeAbortTimesOutStuckStreamCleanup(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: WorkbenchEvent[] = []
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let cleanupReason: string | null = null

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      onConversationAbort: (_conversationId, reason) => {
        cleanupReason = reason
      },
      runAgent: async (req) => {
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>(() => {})
      },
    })

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'abort a stuck stream',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    await withTimeout(runtime.abort(conversation.id), 'abort should time out stuck cleanup', 500)
    assertEqual(cleanupReason, 'user', 'stuck abort cleanup reason')
    assertEqual(runtime.listActiveStreams().length, 0, 'stuck abort should clear active stream')

    const agentEvents = await listRunEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.messageId === result.assistantMessageId &&
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'requested' &&
          event.data.reason === 'user',
      ),
      'stuck abort should persist user cancellation request',
    )
    assertEqual(
      agentEvents.at(-1)?.type,
      'turn.interrupted',
      'stuck abort should end with interrupted event',
    )
    assertEqual(
      agentEvents.at(-1)?.data?.reason,
      'user cleanup timed out',
      'stuck abort interrupted reason',
    )
    assertEqual(
      agentEvents.at(-1)?.data?.modelId,
      'contract/mock',
      'stuck abort interrupted event should preserve model id',
    )
    assertEqual(
      replayConversationRuntimeState(agentEvents).turn?.selection?.modelId,
      'contract/mock',
      'stuck abort replay should preserve model selection',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'interrupted', 'stuck abort activity state')
    assertEqual(
      record.meta.activity?.messageId,
      result.assistantMessageId,
      'stuck abort activity message id',
    )
    assert(
      events.some((event) => event.type === 'run:event' && event.data.type === 'turn.interrupted'),
      'stuck abort should emit interrupted runtime event',
    )
  })
}

async function testRuntimeRepeatedAbortWaitsForSameCleanup(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let cleanupCalls = 0

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 50,
      logger: { warn() {}, error() {} },
      onConversationAbort: () => {
        cleanupCalls += 1
      },
      runAgent: async (req) => {
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>(() => {})
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'repeated abort stuck stream',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    const firstAbort = runtime.abort(conversation.id)
    await waitFor(() => cleanupCalls === 1, 'first repeated abort should notify cleanup')

    let secondAbortSettled = false
    const secondAbort = runtime.abort(conversation.id).then(
      () => {
        secondAbortSettled = true
      },
      () => {
        secondAbortSettled = true
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    assertEqual(
      secondAbortSettled,
      false,
      'repeated abort should wait for the already-aborted stream cleanup',
    )

    await withTimeout(firstAbort, 'first repeated abort should time out cleanup', 500)
    await withTimeout(secondAbort, 'second repeated abort should share cleanup timeout', 500)
    assertEqual(runtime.listActiveStreams().length, 0, 'repeated abort should clear active stream')

    const agentEvents = await listRunEvents(conversation.id)
    const requestedCancellations = agentEvents.filter(
      (event) =>
        event.type === 'turn.cancelled' &&
        event.data?.phase === 'requested' &&
        event.data.reason === 'user',
    )
    const interrupted = agentEvents.filter(
      (event) =>
        event.type === 'turn.interrupted' && event.data?.reason === 'user cleanup timed out',
    )
    assertEqual(
      requestedCancellations.length,
      1,
      'repeated abort should persist one cancellation request',
    )
    assertEqual(
      interrupted.length,
      1,
      'repeated abort should persist one interrupted cleanup event',
    )
  })
}

async function testRuntimeUnexpectedStreamErrorPersistsFailureActivity(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: WorkbenchEvent[] = []
    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      runAgent: async (req) => {
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        throw new Error('provider socket closed')
      },
    })

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'surface provider crash',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'chat:error' && event.data.messageId === result.assistantMessageId,
        ),
      'unexpected stream error should emit chat:error',
    )
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'run:event' &&
            event.data.type === 'turn.failed' &&
            event.data.messageId === result.assistantMessageId,
        ),
      'unexpected stream error should persist failed activity',
    )

    const agentEvents = await listRunEvents(conversation.id)
    assertEqual(agentEvents.at(-1)?.type, 'turn.failed', 'unexpected error final activity event')
    assertEqual(
      agentEvents.at(-1)?.data?.error,
      'provider socket closed',
      'unexpected error activity detail',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'failed', 'unexpected error activity state')
    assertEqual(record.meta.activity?.title, 'Error', 'unexpected error activity title')
    assertEqual(
      record.meta.activity?.messageId,
      result.assistantMessageId,
      'unexpected error activity message id',
    )
    assertEqual(record.messages.length, 2, 'unexpected error should persist user and assistant')
    assertEqual(record.messages[1]?.status, 'error', 'unexpected error assistant status')
    assertEqual(
      record.messages[1]?.error,
      'provider socket closed',
      'unexpected error assistant detail',
    )
  })
}

async function testRuntimeSetupFailurePersistsAssistantError(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: WorkbenchEvent[] = []
    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      workspaceRoots: () => {
        throw new Error('workspace roots unavailable')
      },
      runAgent: async () => {
        throw new Error('stream should not start after setup failure')
      },
    })

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'fail before stream starts',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    assertEqual(runtime.listActiveStreams().length, 0, 'setup failure should not stay active')
    assert(
      events.some(
        (event) =>
          event.type === 'chat:error' && event.data.messageId === result.assistantMessageId,
      ),
      'setup failure should emit chat:error',
    )
    assert(
      events.some(
        (event) =>
          event.type === 'run:event' &&
          event.data.type === 'turn.failed' &&
          event.data.messageId === result.assistantMessageId,
      ),
      'setup failure should emit persisted turn.failed event',
    )

    const agentEvents = await listRunEvents(conversation.id)
    assertEqual(agentEvents.at(-1)?.type, 'turn.failed', 'setup failure final activity event')
    assertEqual(agentEvents.at(-1)?.data?.phase, 'setup', 'setup failure activity phase')
    assertEqual(
      agentEvents.at(-1)?.data?.providerId,
      'openrouter',
      'setup failure event should preserve provider id',
    )
    assertEqual(
      agentEvents.at(-1)?.data?.modelId,
      'contract/mock',
      'setup failure event should preserve model id',
    )
    assertEqual(
      agentEvents.at(-1)?.data?.error,
      'workspace roots unavailable',
      'setup failure activity detail',
    )
    const replayState = replayConversationRuntimeState(agentEvents)
    assertEqual(replayState.phase, 'failed', 'setup failure replay state')
    assertEqual(
      replayState.turn?.selection?.modelId,
      'contract/mock',
      'setup failure replay should preserve model selection',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'failed', 'setup failure activity state')
    assertEqual(
      record.meta.activity?.messageId,
      result.assistantMessageId,
      'setup failure activity message id',
    )
    assertEqual(record.messages.length, 2, 'setup failure should persist user and assistant')
    assertEqual(record.messages[1]?.status, 'error', 'setup failure assistant status')
    assertEqual(
      record.messages[1]?.error,
      'workspace roots unavailable',
      'setup failure assistant detail',
    )
  })
}

async function testRuntimeSetupFailureRejectsWhenConversationDeleted(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: WorkbenchEvent[] = []
    let deleteStarted: Promise<void> | null = null
    let streamStarted = false
    let runtime: WorkbenchRuntime

    runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      workspaceRoots: () => {
        deleteStarted = runtime.deleteConversation(conversation.id)
        throw new Error('workspace roots unavailable after delete')
      },
      runAgent: async () => {
        streamStarted = true
      },
    })

    let rejected = false
    try {
      await runtime.send({
        conversationId: conversation.id,
        userText: 'delete during setup failure',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      })
    } catch (error) {
      rejected = error instanceof Error && error.message.includes('deleted')
    }

    assert(rejected, 'setup failure after delete should reject the send')
    assertEqual(streamStarted, false, 'deleted setup failure should not start stream')
    assertEqual(runtime.listActiveStreams().length, 0, 'deleted setup failure should not be active')
    assert(
      !events.some((event) => event.type === 'chat:error'),
      'deleted setup failure should not emit chat:error',
    )

    if (deleteStarted) await deleteStarted
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'setup failure delete should remove conversation',
    )
    await assertSessionJournalMissing(
      conversation.id,
      'deleted setup failure should not recreate event log',
    )
  })
}

async function testRuntimeSetupFailureSuppressesChatErrorAfterDelete(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: WorkbenchEvent[] = []
    let deleteStarted: Promise<void> | null = null
    let runtime: WorkbenchRuntime

    runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => {
        events.push(event)
        if (
          event.type === 'run:event' &&
          event.data.type === 'turn.failed' &&
          event.data.messageId
        ) {
          deleteStarted = runtime.deleteConversation(conversation.id)
        }
      },
      logger: { warn() {}, error() {} },
      workspaceRoots: () => {
        throw new Error('workspace roots unavailable before delete')
      },
      runAgent: async () => {
        throw new Error('stream should not start after setup failure')
      },
    })

    let rejected = false
    try {
      await runtime.send({
        conversationId: conversation.id,
        userText: 'delete after setup activity',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      })
    } catch (error) {
      rejected = error instanceof Error && error.message.includes('deleted')
    }

    assert(rejected, 'setup failure after activity delete should reject the send')
    assert(
      events.some((event) => event.type === 'run:event' && event.data.type === 'turn.failed'),
      'setup failure should emit activity before deletion',
    )
    assert(
      !events.some((event) => event.type === 'chat:error'),
      'setup failure should suppress chat:error after deletion',
    )

    if (deleteStarted) await deleteStarted
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'setup failure activity delete should remove conversation',
    )
    await assertSessionJournalMissing(
      conversation.id,
      'setup failure activity delete should remove event log',
    )
  })
}

async function testRuntimeListsActiveAssistantTurns(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    let resolveStream: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const release = new Promise<void>((resolve) => {
      resolveStream = resolve
    })
    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      runAgent: async (req, handlers) => {
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await release
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'listed active turn finished' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'list active turn',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    const [active] = runtime.listActiveStreams()
    assert(active, 'runtime should list active assistant turn')
    assertEqual(active.conversationId, conversation.id, 'active turn conversation id')
    assertEqual(
      active.assistantMessageId,
      result.assistantMessageId,
      'active turn assistant message id',
    )
    assertEqual(active.selection.modelId, 'contract/mock', 'active turn model id')

    let hydration = await runtime.hydrateConversation(conversation.id)
    assertEqual(
      hydration.activeTurn?.assistantMessageId,
      result.assistantMessageId,
      'runtime hydrate should include the live active assistant turn',
    )
    await waitFor(async () => {
      hydration = await runtime.hydrateConversation(conversation.id)
      return hydration.runtimeState.phase === 'running'
    }, 'runtime hydrate should replay active turn state')
    assertEqual(
      hydration.runtimeState.phase,
      'running',
      'runtime hydrate should include replay state while the turn is active',
    )

    resolveStream()
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'completed stream should leave active turn list',
    )
  })
}

async function testRuntimeDeleteRunsAbortCleanupBeforeWaitingForStream(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    let resolveStream: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const released = new Promise<void>((resolve) => {
      resolveStream = resolve
    })
    let cleanupConversationId: string | null = null
    let cleanupReason: string | null = null

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      onConversationAbort: (conversationId, reason) => {
        cleanupConversationId = conversationId
        cleanupReason = reason
        resolveStream()
      },
      runAgent: async (req, handlers) => {
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await released
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'delete while host approval is pending',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    await withTimeout(
      runtime.deleteConversation(conversation.id),
      'delete should run abort cleanup before waiting for stream cleanup',
    )
    assertEqual(cleanupConversationId, conversation.id, 'delete abort cleanup conversation id')
    assertEqual(cleanupReason, 'delete', 'delete abort cleanup reason')
    assertEqual(runtime.listActiveStreams().length, 0, 'delete should clear active stream')
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'delete should remove conversation after cleanup',
    )
  })
}

async function testRuntimeDeleteTimesOutStuckStreamAndSuppressesLateEvents(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: WorkbenchEvent[] = []
    let resolveStarted: () => void = () => {}
    let resolveLateStream: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const lateRelease = new Promise<void>((resolve) => {
      resolveLateStream = resolve
    })
    let cleanupReason: string | null = null
    let lateStreamFinished = false

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      onConversationAbort: (_conversationId, reason) => {
        cleanupReason = reason
      },
      runAgent: async (req, handlers) => {
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await lateRelease
        handlers.onTextDelta({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          delta: 'late text after delete',
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'late done after delete' }],
            status: 'done',
            model: req.selection,
          },
        })
        lateStreamFinished = true
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'delete stuck stream',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    await withTimeout(
      runtime.deleteConversation(conversation.id),
      'delete should time out stuck stream cleanup',
      500,
    )
    assertEqual(cleanupReason, 'delete', 'stuck delete cleanup reason')
    assertEqual(runtime.listActiveStreams().length, 0, 'stuck delete should clear active stream')
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'stuck delete should remove conversation',
    )

    resolveLateStream()
    await waitFor(() => lateStreamFinished, 'late stream should be allowed to finish')
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'late stream should not recreate deleted conversation',
    )
    await assertSessionJournalMissing(
      conversation.id,
      'late stream should not recreate deleted event log',
    )
    assert(
      !events.some((event) => event.type === 'chat:text-delta' || event.type === 'chat:done'),
      'late stream should not emit chat events after delete',
    )
  })
}

async function testRuntimeRejectsNewTurnsAfterDeleteStarts(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let streamCount = 0
    let streamFinished = false
    let resolveStarted: () => void = () => {}
    let resolveStream: () => void = () => {}
    let resolveAbortNotified: () => void = () => {}
    let resolveAbortCleanup: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const streamRelease = new Promise<void>((resolve) => {
      resolveStream = resolve
    })
    const abortNotified = new Promise<void>((resolve) => {
      resolveAbortNotified = resolve
    })
    const abortCleanup = new Promise<void>((resolve) => {
      resolveAbortCleanup = resolve
    })

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      logger: { warn() {}, error() {} },
      onConversationAbort: () => {
        resolveAbortNotified()
        return abortCleanup
      },
      runAgent: async () => {
        streamCount += 1
        resolveStarted()
        await streamRelease
        streamFinished = true
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'first turn before delete',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    const deleting = runtime.deleteConversation(conversation.id)
    await abortNotified

    for (const operation of ['send', 'retry'] as const) {
      let rejected = false
      try {
        if (operation === 'send') {
          await runtime.send({
            conversationId: conversation.id,
            userText: 'send after delete starts',
            selection: { providerId: 'openrouter', modelId: 'contract/mock' },
          })
        } else {
          await runtime.retryLastUserMessage({
            conversationId: conversation.id,
            selection: { providerId: 'openrouter', modelId: 'contract/mock' },
          })
        }
      } catch (error) {
        rejected = error instanceof Error && error.message.includes('deleted')
      }
      assert(rejected, `${operation} should reject after delete starts`)
    }

    assertEqual(streamCount, 1, 'deleted conversation should not start a replacement stream')
    resolveAbortCleanup()
    await withTimeout(deleting, 'delete should finish after rejecting new turns', 500)
    assertEqual(runtime.listActiveStreams().length, 0, 'delete should clear original stream')

    resolveStream()
    await waitFor(() => streamFinished, 'original stream should be released')
    assertEqual(streamCount, 1, 'late stream release should not start another stream')
  })
}

async function testRuntimeDeleteFailureReopensConversation(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const conversationsDir = getConversationsDir()
    let streamCount = 0
    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      runAgent: async (req, handlers) => {
        streamCount += 1
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'send after failed delete works' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    let deleteFailed = false
    await chmod(conversationsDir, 0o500)
    try {
      await runtime.deleteConversation(conversation.id)
    } catch {
      deleteFailed = true
    } finally {
      await chmod(conversationsDir, 0o700)
    }
    assert(deleteFailed, 'delete should fail while conversations dir is not writable')

    await runtime.send({
      conversationId: conversation.id,
      userText: 'continue after failed delete',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'send after failed delete should finish',
    )

    const record = await getConversation(conversation.id)
    assertEqual(streamCount, 1, 'failed delete should not permanently tombstone conversation')
    assert(
      record.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.blocks.some(
            (block) => block.type === 'text' && block.content === 'send after failed delete works',
          ),
      ),
      'failed delete should allow later assistant persistence',
    )
  })
}

async function testRuntimeDeleteFailureRecordsCancellationForReopenedTurn(): Promise<void> {
  const baseStore = createInMemoryRuntimeStore()
  const conversation = await baseStore.createConversation?.()
  assert(conversation, 'in-memory store should create conversation for delete failure contract')
  const store: WorkbenchStore = {
    ...baseStore,
    deleteConversation: async () => {
      throw new Error('contract delete failed')
    },
  }
  let streamCount = 0
  let resolveStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const runtime = new WorkbenchRuntime({
    store,
    logger: { warn() {}, error() {} },
    runAgent: async (req, handlers) => {
      streamCount += 1
      req.onRunEvent?.({
        timestamp: Date.now(),
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        type: 'turn.started',
        data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
      })
      if (streamCount === 1) {
        resolveStarted()
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve()
            return
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
        return
      }

      req.onRunEvent?.({
        timestamp: Date.now(),
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        type: 'turn.completed',
      })
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'continued after failed active delete' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
  })

  await runtime.send({
    conversationId: conversation.id,
    userText: 'delete active stream but fail',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await started

  let deleteFailed = false
  try {
    await runtime.deleteConversation(conversation.id)
  } catch (error) {
    deleteFailed = error instanceof Error && error.message.includes('contract delete failed')
  }
  assert(deleteFailed, 'active delete failure should reject')
  assertEqual(runtime.listActiveStreams().length, 0, 'failed active delete should clear stream')

  const events = runtimeSdk.sessionRunEvents(await store.listSessionEntries(conversation.id))
  assert(
    events.some(
      (event) =>
        event.type === 'turn.cancelled' &&
        event.data?.phase === 'requested' &&
        event.data.reason === 'delete',
    ),
    'failed active delete should persist delete cancellation before reopening conversation',
  )

  await runtime.send({
    conversationId: conversation.id,
    userText: 'continue after failed active delete',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await waitFor(
    () => runtime.listActiveStreams().length === 0,
    'send after failed active delete should finish',
  )
  const record = await store.getConversation(conversation.id)
  assert(
    record.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.blocks.some(
          (block) =>
            block.type === 'text' && block.content === 'continued after failed active delete',
        ),
    ),
    'failed active delete should reopen conversation for later persistence',
  )
}

async function testRuntimeSendRecoversAbortedStuckPreviousStream(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: WorkbenchEvent[] = []
    let resolveFirstStarted: () => void = () => {}
    let resolveFirstLateStream: () => void = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve
    })
    const firstLateRelease = new Promise<void>((resolve) => {
      resolveFirstLateStream = resolve
    })
    let streamCount = 0
    let firstLateStreamFinished = false

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      runAgent: async (req, handlers) => {
        streamCount += 1
        const callIndex = streamCount
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })

        if (callIndex === 1) {
          resolveFirstStarted()
          await firstLateRelease
          req.onRunEvent?.({
            timestamp: Date.now(),
            conversationId: req.conversationId,
            messageId: req.assistantMessageId,
            type: 'turn.completed',
          })
          await handlers.onDone({
            conversationId: req.conversationId,
            messageId: req.assistantMessageId,
            message: {
              schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
              id: req.assistantMessageId,
              role: 'assistant',
              blocks: [{ type: 'text', content: 'late abandoned answer' }],
              status: 'done',
              model: req.selection,
            },
          })
          firstLateStreamFinished = true
          return
        }

        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'second answer after recovery' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    const first = await runtime.send({
      conversationId: conversation.id,
      userText: 'first turn will ignore abort',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await firstStarted
    await runtime.abort(conversation.id)
    assertEqual(
      runtime.listActiveStreams().length,
      0,
      'abort should recover the stuck first stream',
    )

    const second = await withTimeout(
      runtime.send({
        conversationId: conversation.id,
        userText: 'second turn should recover',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      }),
      'send should recover an aborted stuck previous stream',
      500,
    )
    assertEqual(streamCount, 2, 'send should start a replacement stream after recovery')
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'replacement stream should finish',
    )

    const agentEvents = await listRunEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.messageId === first.assistantMessageId &&
          event.type === 'turn.interrupted' &&
          event.data?.reason === 'user cleanup timed out',
      ),
      'abort should mark the abandoned first turn interrupted',
    )
    assert(
      agentEvents.some(
        (event) => event.messageId === second.assistantMessageId && event.type === 'turn.completed',
      ),
      'replacement turn should complete',
    )

    resolveFirstLateStream()
    await waitFor(() => firstLateStreamFinished, 'abandoned stream should be allowed to unwind')

    const record = await getConversation(conversation.id)
    assert(
      !record.messages.some((message) => message.id === first.assistantMessageId),
      'late abandoned stream must not persist its assistant message',
    )
    assert(
      !record.messages.some((message) =>
        JSON.stringify(message.blocks).includes('late abandoned answer'),
      ),
      'late abandoned stream must not write stale assistant content',
    )
    assert(
      !events.some(
        (event) => event.type === 'chat:done' && event.data.messageId === first.assistantMessageId,
      ),
      'late abandoned stream must not emit chat:done',
    )
  })
}

async function testRuntimeAbortAllWaitsForShutdownCleanup(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let cleanupConversationId: string | null = null
    let cleanupReason: string | null = null
    let streamFinished = false

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      onConversationAbort: (conversationId, reason) => {
        cleanupConversationId = conversationId
        cleanupReason = reason
      },
      runAgent: async (req, handlers) => {
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve()
            return
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
        streamFinished = true
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'shutdown while streaming',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    await withTimeout(runtime.abortAll('shutdown'), 'abortAll should wait for shutdown cleanup')
    assertEqual(cleanupConversationId, conversation.id, 'abortAll cleanup conversation id')
    assertEqual(cleanupReason, 'shutdown', 'abortAll cleanup reason')
    assertEqual(streamFinished, true, 'abortAll should wait for stream cleanup')
    assertEqual(runtime.listActiveStreams().length, 0, 'abortAll should clear active stream')

    const agentEvents = await listRunEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'requested' &&
          event.data.reason === 'shutdown',
      ),
      'abortAll should persist shutdown cancellation request',
    )
    assert(
      agentEvents.some(
        (event) => event.type === 'turn.cancelled' && event.data?.phase === 'completed',
      ),
      'abortAll should persist completed cancellation',
    )
  })
}

async function testRuntimeAbortAllTimesOutStuckStreamCleanup(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let cleanupReason: string | null = null

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      logger: { warn() {}, error() {} },
      onConversationAbort: (_conversationId, reason) => {
        cleanupReason = reason
      },
      runAgent: async (req) => {
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>(() => {})
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'shutdown stuck stream',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    await withTimeout(runtime.abortAll('shutdown'), 'abortAll should time out stuck cleanup', 500)
    assertEqual(cleanupReason, 'shutdown', 'stuck abortAll cleanup reason')
    assertEqual(runtime.listActiveStreams().length, 0, 'stuck cleanup should clear active stream')

    const agentEvents = await listRunEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'requested' &&
          event.data.reason === 'shutdown',
      ),
      'stuck cleanup should persist shutdown cancellation request',
    )
    assertEqual(
      agentEvents.at(-1)?.type,
      'turn.interrupted',
      'stuck cleanup should end with interrupted event',
    )
    assertEqual(
      agentEvents.at(-1)?.data?.reason,
      'shutdown cleanup timed out',
      'stuck cleanup interrupted reason',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'interrupted', 'stuck cleanup activity state')
    assertEqual(record.meta.activity?.title, 'Interrupted', 'stuck cleanup activity title')
  })
}

async function testRuntimeShutdownRejectsNewTurns(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let streamCount = 0
    let streamFinished = false

    const runtime = new WorkbenchRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      runAgent: async (req, handlers) => {
        streamCount += 1
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve()
            return
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        req.onRunEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
        streamFinished = true
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'start before shutdown',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    const firstShutdown = runtime.shutdown()
    const secondShutdown = runtime.shutdown()
    assertEqual(firstShutdown, secondShutdown, 'shutdown should be idempotent')

    for (const operation of ['send', 'retry'] as const) {
      let rejected = false
      try {
        if (operation === 'send') {
          await runtime.send({
            conversationId: conversation.id,
            userText: 'send after shutdown starts',
            selection: { providerId: 'openrouter', modelId: 'contract/mock' },
          })
        } else {
          await runtime.retryLastUserMessage({
            conversationId: conversation.id,
            selection: { providerId: 'openrouter', modelId: 'contract/mock' },
          })
        }
      } catch (error) {
        rejected = error instanceof Error && error.message.includes('shut down')
      }
      assert(rejected, `${operation} should reject after shutdown starts`)
    }

    await withTimeout(firstShutdown, 'shutdown should settle active stream')
    assertEqual(streamFinished, true, 'shutdown should wait for active stream cleanup')
    assertEqual(runtime.listActiveStreams().length, 0, 'shutdown should clear active streams')
    assertEqual(streamCount, 1, 'shutdown should not start replacement streams')

    let rejectedAfterShutdown = false
    try {
      await runtime.send({
        conversationId: conversation.id,
        userText: 'send after shutdown finishes',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      })
    } catch (error) {
      rejectedAfterShutdown = error instanceof Error && error.message.includes('shut down')
    }
    assert(rejectedAfterShutdown, 'send should reject after shutdown finishes')
  })
}

async function testPersistenceContract(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    assertEqual(
      conversation.schemaVersion,
      AILA_CONVERSATION_META_SCHEMA_VERSION,
      'new conversation meta version',
    )

    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'message-1',
      role: 'user',
      blocks: [{ type: 'text', content: 'hello contract' }],
      status: 'done',
    })

    const record = await getConversation(conversation.id)
    assertEqual(
      record.meta.schemaVersion,
      AILA_CONVERSATION_META_SCHEMA_VERSION,
      'read conversation meta version',
    )
    assertEqual(
      record.messages[0]?.schemaVersion,
      AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      'read persisted message version',
    )

    const journalPath = join(
      getConversationsDir(),
      encodeURIComponent(conversation.id),
      'entries.jsonl',
    )
    const rawEntries = (await readFile(journalPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as runtimeSdk.SessionEntry)
    const createdEntry = rawEntries.find((entry) => entry.type === 'session.created')
    const messageEntry = rawEntries.find((entry) => entry.type === 'message.committed')
    assert(createdEntry?.type === 'session.created', 'journal should contain session creation')
    assert(messageEntry?.type === 'message.committed', 'journal should contain committed message')
    assertEqual(
      createdEntry.data.summary.schemaVersion,
      AILA_CONVERSATION_META_SCHEMA_VERSION,
      'journal session meta version',
    )
    assertEqual(
      messageEntry.data.message.schemaVersion,
      AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      'journal message version',
    )

    await appendRunEvent(conversation.id, {
      timestamp: 1,
      conversationId: conversation.id,
      messageId: 'message-1',
      type: 'tool.approval.requested',
      data: { toolName: 'write', requestId: 'approval-1', risk: 'destructive write' },
    })
    const events = await listRunEvents(conversation.id)
    assertEqual(events.length, 1, 'agent events should be readable')
    const [event] = events
    assert(event, 'listed agent event should exist')
    assertEqual(event.schemaVersion, AILA_RUN_EVENT_SCHEMA_VERSION, 'listed event version')
    assertEqual(event.type, 'tool.approval.requested', 'listed event type')
    const runEventEntry = (await readFile(journalPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as runtimeSdk.SessionEntry)
      .find((entry) => entry.type === 'run.event')
    assert(runEventEntry?.type === 'run.event', 'journal should contain the run event')
    assertEqual(
      runEventEntry.data.event.schemaVersion,
      AILA_RUN_EVENT_SCHEMA_VERSION,
      'journal run event version',
    )

    const runtimeEvent = createWorkbenchEvent('run:event', event)
    assertEqual(runtimeEvent.type, 'run:event', 'agent event runtime wrapper type')
  })
}

async function testMessageUpsertPreventsDuplicatePersistedMessages(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'assistant-message',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'first answer' }],
      status: 'done',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await upsertMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'assistant-message',
      role: 'assistant',
      blocks: [],
      status: 'error',
      error: 'replacement error',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    const record = await getConversation(conversation.id)
    assertEqual(record.messages.length, 1, 'upsert should not duplicate message ids')
    assertEqual(record.messages[0]?.id, 'assistant-message', 'upserted message id')
    assertEqual(record.messages[0]?.status, 'error', 'upserted message status')
    assertEqual(record.messages[0]?.error, 'replacement error', 'upserted message error')

    const rawMessages = (
      await readFile(
        join(getConversationsDir(), encodeURIComponent(conversation.id), 'entries.jsonl'),
        'utf-8',
      )
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as runtimeSdk.SessionEntry)
      .filter((entry) => entry.type === 'message.committed')
    assertEqual(rawMessages.length, 2, 'message updates should remain as immutable journal facts')
  })
}

async function testRunEventReplayDeduplicatesExactDuplicates(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const event = {
      eventId: 'deduplicated-run-event',
      timestamp: 42,
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'tool.execution.started' as const,
      data: { toolCallId: 'tool-call', toolName: 'read_file' },
    }

    await appendRunEvent(conversation.id, event)
    await appendRunEvent(conversation.id, event)

    const events = await listRunEvents(conversation.id)
    assertEqual(events.length, 1, 'duplicate agent events should collapse during replay')
    assertEqual(events[0]?.type, 'tool.execution.started', 'deduped event type')
    assertEqual(events[0]?.data?.toolName, 'read_file', 'deduped event data')
    assertEqual(events[0]?.seq, 2, 'run event should follow the session-created entry')
    assert(
      typeof events[0]?.eventId === 'string' && events[0].eventId.length > 0,
      'journal should allocate an event id for legacy producers',
    )

    const rawEvents = (
      await readFile(
        join(getConversationsDir(), encodeURIComponent(conversation.id), 'entries.jsonl'),
        'utf-8',
      )
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as runtimeSdk.SessionEntry)
      .filter((entry) => entry.type === 'run.event')
    assertEqual(rawEvents.length, 1, 'idempotent append should not duplicate durable event entries')
  })
}

async function testRunEventReplayPreservesAppendOrderForSameTimestamp(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const timestamp = 100
    const events: RunEvent[] = [
      {
        eventId: 'same-timestamp-started',
        timestamp,
        conversationId: conversation.id,
        messageId: 'assistant-same-timestamp',
        type: 'turn.started',
        data: { providerId: 'openrouter', modelId: 'contract/mock' },
      },
      {
        eventId: 'same-timestamp-approval',
        timestamp,
        conversationId: conversation.id,
        messageId: 'assistant-same-timestamp',
        type: 'tool.approval.requested',
        data: {
          requestId: 'approval-same-timestamp',
          toolCallId: 'tool-call',
          toolName: 'write',
        },
      },
      {
        eventId: 'same-timestamp-approval',
        timestamp,
        conversationId: conversation.id,
        messageId: 'assistant-same-timestamp',
        type: 'tool.approval.requested',
        data: {
          requestId: 'approval-same-timestamp',
          toolCallId: 'tool-call',
          toolName: 'write',
        },
      },
      {
        eventId: 'same-timestamp-resolved',
        timestamp,
        conversationId: conversation.id,
        messageId: 'assistant-same-timestamp',
        type: 'tool.approval.resolved',
        data: { requestId: 'approval-same-timestamp', approved: true, reason: 'user' },
      },
      {
        eventId: 'same-timestamp-completed',
        timestamp,
        conversationId: conversation.id,
        messageId: 'assistant-same-timestamp',
        type: 'turn.completed',
        data: { outputBlockCount: 1 },
      },
    ]

    for (const event of events) await appendRunEvent(conversation.id, event)

    const listed = await listRunEvents(conversation.id)
    assertEqual(listed.length, 4, 'same-timestamp replay should deduplicate exact duplicates')
    assertEqual(
      listed.map((event) => event.type).join(','),
      'turn.started,tool.approval.requested,tool.approval.resolved,turn.completed',
      'same-timestamp replay should preserve append order after sorting',
    )

    const runtimeState = replayConversationRuntimeState(listed)
    assertEqual(runtimeState.phase, 'completed', 'same-timestamp replay terminal phase')
    assertEqual(runtimeState.active, false, 'same-timestamp terminal replay should be inactive')
    assertEqual(
      runtimeState.turn?.pendingApproval,
      undefined,
      'same-timestamp approval resolution should clear pending approval before terminal replay',
    )
    assertEqual(
      replayConversationActivity(listed)?.eventType,
      'turn.completed',
      'same-timestamp activity should use the last replay event',
    )

    const recovered = await recoverInterruptedConversationActivities('same timestamp restart')
    assert(
      !recovered.some((summary) => summary.id === conversation.id),
      'same-timestamp completed replay should not recover as interrupted',
    )
    assert(
      !(await listRunEvents(conversation.id)).some((event) => event.type === 'turn.interrupted'),
      'same-timestamp completed replay should not append interrupted recovery',
    )
  })
}

function testRunEventReplayDerivesLatestActivity(): void {
  const events: PersistedRunEvent[] = [
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 30,
      conversationId: 'conversation-replay',
      messageId: 'assistant-replay',
      type: 'turn.completed' as const,
    },
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 10,
      conversationId: 'conversation-replay',
      messageId: 'assistant-replay',
      type: 'turn.started' as const,
      data: { modelId: 'contract/mock' },
    },
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 20,
      conversationId: 'conversation-replay',
      messageId: 'assistant-replay',
      type: 'tool.input.delta' as const,
      data: { deltaSize: 20 },
    },
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 30,
      conversationId: 'conversation-replay',
      messageId: 'assistant-replay',
      type: 'turn.completed' as const,
    },
  ]

  const activity = replayConversationActivity(events)
  assert(activity, 'event replay should derive an activity')
  assertEqual(activity.state, 'completed', 'event replay should use latest non-delta activity')
  assertEqual(activity.eventType, 'turn.completed', 'event replay activity event type')
  assertEqual(activity.updatedAt, 30, 'event replay activity timestamp')
}

function testRunEventReplayDerivesRuntimeState(): void {
  const baseEvents: PersistedRunEvent[] = [
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 10,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'turn.started',
      data: {
        providerId: 'openrouter',
        modelId: 'contract/mock',
        inputMessageCount: 2,
      },
    },
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 20,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'tool.approval.requested',
      data: {
        requestId: 'approval-request',
        toolCallId: 'tool-call',
        toolName: 'write',
      },
    },
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 20,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'tool.approval.requested',
      data: {
        requestId: 'approval-request',
        toolCallId: 'tool-call',
        toolName: 'write',
      },
    },
  ]

  const approvalState = replayConversationRuntimeState(baseEvents)
  assertEqual(approvalState.phase, 'approval', 'approval request should be active runtime state')
  assertEqual(approvalState.active, true, 'approval request should be active')
  assertEqual(
    approvalState.turn?.assistantMessageId,
    'assistant-runtime-replay',
    'runtime replay assistant message id',
  )
  assertEqual(
    approvalState.turn?.selection?.modelId,
    'contract/mock',
    'runtime replay should preserve model selection',
  )
  assertEqual(
    approvalState.turn?.pendingApproval?.requestId,
    'approval-request',
    'runtime replay should preserve pending approval',
  )

  const resolvedState = replayConversationRuntimeState([
    ...baseEvents,
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 30,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'tool.approval.resolved',
      data: { requestId: 'approval-request', approved: false, reason: 'user' },
    },
  ])
  assertEqual(
    resolvedState.phase,
    'running',
    'approval resolution should not be treated as a turn terminal',
  )
  assertEqual(resolvedState.active, true, 'resolved approval should remain active')
  assertEqual(
    resolvedState.turn?.pendingApproval,
    undefined,
    'resolved approval should clear pending approval',
  )

  const cancellingState = replayConversationRuntimeState([
    ...baseEvents,
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 40,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'turn.cancelled',
      data: { phase: 'requested', reason: 'user' },
    },
  ])
  assertEqual(cancellingState.phase, 'cancelling', 'requested cancellation should not be terminal')
  assertEqual(cancellingState.active, true, 'requested cancellation should remain active')

  const cancelledState = replayConversationRuntimeState([
    ...baseEvents,
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 40,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'turn.cancelled',
      data: { phase: 'requested', reason: 'user' },
    },
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 50,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'turn.cancelled',
      data: { phase: 'completed', reason: 'abort_signal' },
    },
  ])
  assertEqual(cancelledState.phase, 'cancelled', 'completed cancellation should be terminal')
  assertEqual(cancelledState.active, false, 'completed cancellation should not be active')
}

function testRunEventReplayKeepsToolFailureActive(): void {
  const events: PersistedRunEvent[] = [
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 10,
      conversationId: 'conversation-tool-failure-replay',
      messageId: 'assistant-tool-failure-replay',
      type: 'turn.started',
      data: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 20,
      conversationId: 'conversation-tool-failure-replay',
      messageId: 'assistant-tool-failure-replay',
      type: 'tool.execution.failed',
      data: {
        toolCallId: 'tool-call',
        toolName: 'write',
        error: 'contract tool failure',
      },
    },
  ]

  const activity = replayConversationActivity(events)
  const runtimeState = replayConversationRuntimeState(events)
  assertEqual(activity?.state, 'failed', 'tool failure should remain visible in activity')
  assertEqual(
    runtimeState.phase,
    'running',
    'tool failure should not be treated as a turn terminal',
  )
  assertEqual(runtimeState.active, true, 'tool failure should remain active until a turn terminal')
}

function testInterruptedRecoveryEventHelper(): void {
  const activeEvents: PersistedRunEvent[] = [
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 10,
      conversationId: 'conversation-recovery-helper',
      messageId: 'assistant-recovery-helper',
      type: 'turn.started',
      data: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 20,
      conversationId: 'conversation-recovery-helper',
      messageId: 'assistant-recovery-helper',
      type: 'tool.execution.failed',
      data: {
        toolCallId: 'tool-call',
        toolName: 'write',
        error: 'contract tool failure',
      },
    },
  ]

  const recoveryEvent = createInterruptedConversationRecoveryEvent(activeEvents, {
    reason: 'contract restart',
    timestamp: 30,
    activity: {
      state: 'failed',
      title: 'Tool failed: write',
      updatedAt: 20,
      eventType: 'tool.execution.failed',
      messageId: 'assistant-recovery-helper',
      toolName: 'write',
    },
  })

  assert(recoveryEvent, 'active runtime state should create interrupted recovery event')
  assertEqual(recoveryEvent.timestamp, 30, 'recovery helper timestamp')
  assertEqual(recoveryEvent.conversationId, 'conversation-recovery-helper', 'recovery conversation')
  assertEqual(recoveryEvent.messageId, 'assistant-recovery-helper', 'recovery assistant message')
  assertEqual(recoveryEvent.type, 'turn.interrupted', 'recovery event type')
  assertEqual(recoveryEvent.data?.previousState, 'running', 'recovery previous state')
  assertEqual(recoveryEvent.data?.providerId, 'openrouter', 'recovery provider id')
  assertEqual(recoveryEvent.data?.modelId, 'contract/mock', 'recovery model id')
  assertEqual(
    recoveryEvent.data?.previousEventType,
    'tool.execution.failed',
    'recovery previous event type',
  )
  assertEqual(recoveryEvent.data?.previousTitle, 'Tool failed: write', 'recovery previous title')

  const terminalEvent = createInterruptedConversationRecoveryEvent([
    ...activeEvents,
    {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 40,
      conversationId: 'conversation-recovery-helper',
      messageId: 'assistant-recovery-helper',
      type: 'turn.completed',
    },
  ])
  assertEqual(terminalEvent, null, 'terminal runtime state should not create recovery event')
}

async function testInterruptedRecoveryUsesEventReplayOverStaleMeta(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendRunEventAndTouchConversation(conversation.id, {
      timestamp: 10,
      conversationId: conversation.id,
      messageId: 'assistant-stale-meta',
      type: 'turn.started',
      data: { modelId: 'contract/mock' },
    })
    await appendRunEvent(conversation.id, {
      timestamp: 20,
      conversationId: conversation.id,
      messageId: 'assistant-stale-meta',
      type: 'turn.completed',
    })

    const before = await getConversation(conversation.id)
    assertEqual(
      before.meta.activity?.state,
      'completed',
      'journal projection should never expose stale activity meta',
    )

    const recovered = await recoverInterruptedConversationActivities('contract restart')
    assertEqual(
      recovered.some((summary) => summary.id === conversation.id),
      false,
      'completed replay should not be recovered as interrupted',
    )

    const events = await listRunEvents(conversation.id)
    assert(
      !events.some((event) => event.type === 'turn.interrupted'),
      'completed replay should not append interrupted event',
    )
    const after = await getConversation(conversation.id)
    assertEqual(
      after.meta.activity?.state,
      'completed',
      'recovery should preserve terminal activity',
    )
    assertEqual(
      after.meta.activity?.eventType,
      'turn.completed',
      'recovery should preserve activity projected from replay',
    )
  })
}

async function testInterruptedRecoveryUsesRuntimeReplayForNonTerminalToolFailure(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendRunEventAndTouchConversation(conversation.id, {
      timestamp: 10,
      conversationId: conversation.id,
      messageId: 'assistant-tool-failure-recovery',
      type: 'turn.started',
      data: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await appendRunEventAndTouchConversation(conversation.id, {
      timestamp: 20,
      conversationId: conversation.id,
      messageId: 'assistant-tool-failure-recovery',
      type: 'tool.execution.failed',
      data: {
        toolCallId: 'tool-call',
        toolName: 'write',
        error: 'contract tool failure',
      },
    })

    const before = await getConversation(conversation.id)
    assertEqual(before.meta.activity?.state, 'failed', 'fixture should have failed activity')

    const recovered = await recoverInterruptedConversationActivities('contract restart')
    assert(
      recovered.some((summary) => summary.id === conversation.id),
      'non-terminal tool failure should be recovered as interrupted',
    )

    const events = await listRunEvents(conversation.id)
    const interrupted = events.find((event) => event.type === 'turn.interrupted')
    assert(interrupted, 'runtime replay recovery should append interrupted event')
    assertEqual(
      interrupted.data?.previousEventType,
      'tool.execution.failed',
      'interrupted event should preserve previous runtime event',
    )
    assertEqual(
      interrupted.data?.previousState,
      'running',
      'interrupted event should use runtime lifecycle state',
    )
    assertEqual(
      interrupted.data?.modelId,
      'contract/mock',
      'runtime replay recovery should preserve model id',
    )
  })
}

async function testImmediateToolApprovalActivityHelper(): Promise<void> {
  const recorded: RunEvent[] = []
  const request: ToolApprovalRequest = {
    name: 'write',
    args: {
      path: '/workspace/contract.md',
      content: 'approval helper',
      nested: { value: 'original' },
    },
    metadata: {
      name: 'write',
      readOnly: false,
      destructive: true,
      requiresApproval: true,
      access: ['write'],
      scope: ['workspace'],
    },
    conversationId: 'conversation-approval-helper',
    messageId: 'assistant-approval-helper',
    toolCallId: 'tool-call-approval-helper',
  }

  let approveSawOriginal = false
  const approved = await requestToolApprovalWithActivity({
    request,
    createId: () => 'approval-contract-id',
    approve: async (approvalRequest) => {
      approveSawOriginal =
        approvalRequest.args.path === '/workspace/contract.md' &&
        (approvalRequest.args.nested as { value?: unknown }).value === 'original' &&
        approvalRequest.metadata.access.includes('write')
      approvalRequest.args.path = '/workspace/approval-mutated.md'
      const nested = approvalRequest.args.nested as { value?: string }
      nested.value = 'approval-mutated'
      approvalRequest.metadata.access.push('shell')
      return true
    },
    recordRunEvent: async (_conversationId, event) => {
      recorded.push(event)
    },
  })

  assertEqual(approved, true, 'approval helper should return host approval result')
  assertEqual(approveSawOriginal, true, 'approval helper should pass an approval snapshot')
  assertEqual(request.args.path, '/workspace/contract.md', 'approval helper should isolate args')
  assertEqual(
    (request.args.nested as { value?: unknown }).value,
    'original',
    'approval helper should isolate nested args',
  )
  assertEqual(
    request.metadata.access.includes('shell'),
    false,
    'approval helper should isolate metadata',
  )
  assertEqual(recorded.length, 2, 'approval helper should record requested and resolved events')
  assertEqual(recorded[0]?.type, 'tool.approval.requested', 'approval helper requested event')
  assertEqual(recorded[1]?.type, 'tool.approval.resolved', 'approval helper resolved event')
  assertEqual(
    recorded[0]?.conversationId,
    'conversation-approval-helper',
    'approval helper requested conversation',
  )
  assertEqual(recorded[0]?.messageId, 'assistant-approval-helper', 'approval helper message id')
  assertEqual(recorded[0]?.data?.toolCallId, 'tool-call-approval-helper', 'approval helper call id')
  assertEqual(recorded[0]?.data?.toolName, 'write', 'approval helper tool name')
  assertEqual(recorded[0]?.data?.requestId, 'approval-contract-id', 'approval helper request id')
  assertEqual(recorded[0]?.data?.risk, 'destructive write', 'approval helper risk')
  assertEqual(
    (recorded[0]?.data?.target as { preview?: unknown } | undefined)?.preview,
    '/workspace/contract.md',
    'approval helper target snapshot',
  )
  assertEqual(recorded[1]?.data?.approved, true, 'approval helper resolved approved flag')
  assertEqual(recorded[1]?.data?.reason, 'user', 'approval helper resolved reason')

  const failedRecorded: RunEvent[] = []
  try {
    await requestToolApprovalWithActivity({
      request,
      createId: () => 'approval-failed-contract-id',
      approve: async () => {
        throw new Error('approval prompt failed')
      },
      recordRunEvent: async (_conversationId, event) => {
        failedRecorded.push(event)
      },
    })
    throw new Error('failed approval unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('approval prompt failed'),
      'approval helper should rethrow prompt failures',
    )
  }
  assertEqual(
    failedRecorded[0]?.type,
    'tool.approval.requested',
    'failed approval helper requested event',
  )
  assertEqual(
    failedRecorded[1]?.type,
    'tool.approval.resolved',
    'failed approval helper resolved event',
  )
  assertEqual(
    failedRecorded[1]?.data?.approved,
    false,
    'failed approval helper resolved should deny',
  )
  assertEqual(
    failedRecorded[1]?.data?.reason,
    'cancelled',
    'failed approval helper resolved reason',
  )
}

async function testExecutionModeToolPolicyContract(): Promise<void> {
  assertEqual(AILA_EXECUTION_MODES.join(','), 'chat,agent', 'execution modes should stay minimal')
  const readRequest: ToolApprovalRequest = {
    name: 'read',
    args: { path: '/workspace/file.txt' },
    metadata: {
      name: 'read',
      readOnly: true,
      destructive: false,
      requiresApproval: false,
      access: ['read'],
      scope: ['workspace'],
    },
  }
  const writeRequest: ToolApprovalRequest = {
    name: 'write',
    args: { path: '/workspace/file.txt', content: 'new content' },
    metadata: {
      name: 'write',
      readOnly: false,
      destructive: true,
      requiresApproval: true,
      access: ['write'],
      scope: ['workspace'],
    },
  }

  assertEqual(
    isReadOnlyToolMetadata(readRequest.metadata),
    true,
    'read-only workspace tools should pass the read-only gate',
  )
  assertEqual(
    isReadOnlyToolMetadata(writeRequest.metadata),
    false,
    'write tools should not pass the read-only gate',
  )
  assertEqual(
    evaluateExecutionModeToolPolicy('chat', readRequest),
    undefined,
    'read-only tools should pass the chat execution mode gate',
  )
  assertEqual(
    evaluateExecutionModeToolPolicy('chat', writeRequest)?.action,
    'deny',
    'chat mode should deny write tools',
  )

  let nextPolicyCalls = 0
  const chatPolicy = createExecutionModeToolPolicy('chat', () => {
    nextPolicyCalls += 1
    return { action: 'allow', reason: 'host allow' }
  })
  assertEqual(
    (await chatPolicy(writeRequest))?.action,
    'deny',
    'chat mode should deny before host policy can allow writes',
  )
  assertEqual(nextPolicyCalls, 0, 'denied chat-mode writes should not call host policy')
  assertEqual(
    (await chatPolicy(readRequest))?.action,
    'allow',
    'read-only tools should continue to host policy',
  )
  assertEqual(nextPolicyCalls, 1, 'read-only tools should call host policy')
}

async function testToolRegistryContract(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }
  let ran = false
  const projectToolPack: ToolPack = {
    id: 'contract',
    name: 'Contract',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'contract_echo',
            description: 'Echo contract smoke input.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
          metadata: {
            name: 'contract_echo',
            readOnly: true,
            destructive: false,
            requiresApproval: false,
            access: ['read'],
            scope: ['workspace'],
          },
        },
        async run(args) {
          ran = true
          return JSON.stringify({ ok: true, value: args.value })
        },
      },
    ],
  }

  const registry = createDefaultToolRegistry([projectToolPack])
  assert(registry.specsByName.has('contract_echo'), 'custom tool should be registered')
  assert(
    getToolDefinitions(registry).some((definition) => definition.function.name === 'contract_echo'),
    'custom tool should be exposed in tool definitions',
  )
  const callerDefinitions = getToolDefinitions(registry)
  const callerDefinition = callerDefinitions.find(
    (definition) => definition.function.name === 'contract_echo',
  )
  assert(callerDefinition, 'custom tool definition should be listed')
  callerDefinition.function.description = 'caller-mutated definition'
  assertEqual(
    getToolDefinitions(registry).find((definition) => definition.function.name === 'contract_echo')
      ?.function.description,
    'Echo contract smoke input.',
    'tool definitions should be isolated from caller mutation',
  )
  const sourceEntry = projectToolPack.tools[0]
  assert(sourceEntry, 'custom tool source entry should exist')
  sourceEntry.spec.metadata.requiresApproval = true
  sourceEntry.spec.function.description = 'source-mutated definition'
  assertEqual(
    registry.specsByName.get('contract_echo')?.metadata.requiresApproval,
    false,
    'tool registry should snapshot source metadata at registration',
  )
  assertEqual(
    getToolDefinitions(registry).find((definition) => definition.function.name === 'contract_echo')
      ?.function.description,
    'Echo contract smoke input.',
    'tool registry should snapshot source definitions at registration',
  )
  const result = await executeTool('contract_echo', { value: 'hello' }, { settings }, registry)
  assert(ran, 'custom tool runner should execute')
  assertEqual(JSON.parse(result).value, 'hello', 'custom tool result')

  const approvalPack: ToolPack = {
    id: 'approval-contract',
    name: 'Approval Contract',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'contract_destructive',
            description: 'Exercise approval flow.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          metadata: {
            name: 'contract_destructive',
            readOnly: false,
            destructive: true,
            requiresApproval: true,
            access: ['write'],
            scope: ['workspace'],
          },
        },
        async run() {
          throw new Error('approval rejected tool should not run')
        },
      },
    ],
  }
  const approvalRegistry = createDefaultToolRegistry([approvalPack])
  let approvalRequested = false
  try {
    await executeTool(
      'contract_destructive',
      {},
      {
        settings,
        conversationId: 'conversation-approval',
        messageId: 'assistant-approval',
        toolCallId: 'tool-call-approval',
        async onToolApproval(request) {
          approvalRequested = true
          assertEqual(
            request.conversationId,
            'conversation-approval',
            'approval request conversation id',
          )
          assertEqual(request.messageId, 'assistant-approval', 'approval request message id')
          assertEqual(request.toolCallId, 'tool-call-approval', 'approval request tool call id')
          return false
        },
      },
      approvalRegistry,
    )
    throw new Error('rejected tool unexpectedly succeeded')
  } catch (error) {
    assert(approvalRequested, 'approval hook should be called')
    assert(
      error instanceof Error && error.message.includes('rejected by user'),
      'rejected approval should return policy error',
    )
  }

  let policyAllowedRunnerCalled = false
  let policyRunnerMode: unknown = null
  let policyRunnerNestedValue: unknown = null
  const policyPack: ToolPack = {
    id: 'policy-contract',
    name: 'Policy Contract',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'contract_policy_tool',
            description: 'Exercise policy flow.',
            parameters: {
              type: 'object',
              properties: { mode: { type: 'string' } },
              required: ['mode'],
              additionalProperties: false,
            },
          },
          metadata: {
            name: 'contract_policy_tool',
            readOnly: false,
            destructive: true,
            requiresApproval: true,
            access: ['write'],
            scope: ['workspace'],
          },
        },
        async run(args, ctx) {
          policyAllowedRunnerCalled = true
          policyRunnerMode = args.mode
          const nested = args.nested as { value?: unknown } | undefined
          policyRunnerNestedValue = nested?.value ?? null
          args.mode = 'runner-mutated'
          if (nested) nested.value = 'runner-mutated'
          ctx.settings.apiKeys.openrouter = 'runner-mutated'
          const root = ctx.workspaceRoots?.[0]
          if (root && typeof root !== 'string') root.label = 'runner-mutated'
          return 'policy ok'
        },
      },
    ],
  }
  const policyRegistry = createDefaultToolRegistry([policyPack])

  policyAllowedRunnerCalled = false
  try {
    await executeTool(
      'contract_policy_tool',
      { mode: 'missing-approval-host' },
      { settings },
      policyRegistry,
    )
    throw new Error('approval-required tool unexpectedly succeeded without approval host')
  } catch (error) {
    assertEqual(policyAllowedRunnerCalled, false, 'missing approval host should not run handler')
    assert(
      error instanceof Error && error.message.includes('requires approval but no approval host'),
      'approval-required tool should fail closed without approval host',
    )
  }

  const allowed = await executeTool(
    'contract_policy_tool',
    { mode: 'allow' },
    {
      settings,
      onToolPolicy: () => ({ action: 'allow' }),
      onToolApproval: async () => {
        throw new Error('allow policy should not ask approval')
      },
    },
    policyRegistry,
  )
  assertEqual(allowed, 'policy ok', 'allow policy should execute tool')
  assertEqual(policyAllowedRunnerCalled, true, 'allow policy should run handler')

  let askApprovalRequested = false
  await executeTool(
    'contract_policy_tool',
    { mode: 'ask' },
    {
      settings,
      onToolPolicy: (request) => {
        assertEqual(request.metadata.destructive, true, 'policy request metadata')
        return { action: 'ask', reason: 'contract asks' }
      },
      onToolApproval: async (request) => {
        askApprovalRequested = request.name === 'contract_policy_tool'
        return true
      },
    },
    policyRegistry,
  )
  assertEqual(askApprovalRequested, true, 'ask policy should call approval hook')

  policyAllowedRunnerCalled = false
  policyRunnerMode = null
  policyRunnerNestedValue = null
  let immutableApprovalRequested = false
  const immutableArgs: Record<string, unknown> = {
    mode: 'immutable-boundary',
    nested: { value: 'original-nested' },
  }
  const immutableWorkspaceRoots = [{ path: '/contract/tool-root', label: 'contract-root' }]
  const immutableContext = {
    settings,
    workspaceRoots: immutableWorkspaceRoots,
    onToolPolicy: (request) => {
      request.args.mode = 'policy-mutated'
      const nested = request.args.nested as { value?: unknown } | undefined
      if (nested) nested.value = 'policy-mutated'
      request.metadata.requiresApproval = false
      return undefined
    },
    onToolApproval: async (request) => {
      immutableApprovalRequested = true
      request.args.mode = 'approval-mutated'
      const nested = request.args.nested as { value?: unknown } | undefined
      if (nested) nested.value = 'approval-mutated'
      return true
    },
  }
  await executeTool('contract_policy_tool', immutableArgs, immutableContext, policyRegistry)
  assertEqual(
    immutableApprovalRequested,
    true,
    'policy request mutation should not bypass approval',
  )
  assertEqual(policyAllowedRunnerCalled, true, 'immutable boundary should still run handler')
  assertEqual(
    policyRunnerMode,
    'immutable-boundary',
    'policy and approval request mutation should not change runner args',
  )
  assertEqual(
    policyRunnerNestedValue,
    'original-nested',
    'policy and approval request mutation should not change nested runner args',
  )
  assertEqual(
    immutableArgs.mode,
    'immutable-boundary',
    'runner mutation should not change caller tool args',
  )
  assertEqual(
    (immutableArgs.nested as { value?: unknown }).value,
    'original-nested',
    'runner mutation should not change caller nested tool args',
  )
  assertEqual(
    settings.apiKeys.openrouter,
    undefined,
    'runner mutation should not change caller tool settings context',
  )
  assertEqual(
    immutableWorkspaceRoots[0]?.label,
    'contract-root',
    'runner mutation should not change caller workspace roots context',
  )

  policyAllowedRunnerCalled = false
  try {
    await executeTool(
      'contract_policy_tool',
      { mode: 'deny' },
      {
        settings,
        onToolPolicy: () => ({ action: 'deny', reason: 'contract denied' }),
        onToolApproval: async () => {
          throw new Error('deny policy should not ask approval')
        },
      },
      policyRegistry,
    )
    throw new Error('denied tool unexpectedly succeeded')
  } catch (error) {
    assertEqual(policyAllowedRunnerCalled, false, 'deny policy should not run handler')
    assert(
      error instanceof Error && error.message.includes('contract denied'),
      'deny policy should expose reason',
    )
  }

  policyAllowedRunnerCalled = false
  try {
    await executeTool(
      'contract_policy_tool',
      { mode: 'invalid-policy' },
      {
        settings,
        onToolPolicy: () => ({ action: 'bypass' }) as never,
        onToolApproval: async () => true,
      },
      policyRegistry,
    )
    throw new Error('invalid policy unexpectedly succeeded')
  } catch (error) {
    assertEqual(policyAllowedRunnerCalled, false, 'invalid policy should not run handler')
    assert(
      error instanceof Error && error.message.includes('invalid tool policy decision'),
      'invalid policy should fail closed',
    )
  }

  policyAllowedRunnerCalled = false
  try {
    await executeTool(
      'contract_policy_tool',
      { mode: 'non-boolean-approval' },
      {
        settings,
        onToolPolicy: () => ({ action: 'ask' }),
        onToolApproval: async () => 'yes' as never,
      },
      policyRegistry,
    )
    throw new Error('non-boolean approval unexpectedly succeeded')
  } catch (error) {
    assertEqual(policyAllowedRunnerCalled, false, 'non-boolean approval should not run handler')
    assert(
      error instanceof Error && error.message.includes('rejected by user'),
      'non-boolean approval should fail closed',
    )
  }
}

async function testRuntimeExecuteToolUsesHostBoundary(): Promise<void> {
  const settings: Settings = { apiKeys: { openrouter: 'runtime-key' }, defaultModel: null }
  const workspaceRoots = [{ path: '/contract@aila/agent-root', label: 'contract' }]
  let loadSettingsCalled = false
  let policySawRuntimeRequest = false
  let approvalSawRuntimeRequest = false
  let runnerSawRuntimeContext = false

  const toolPack: ToolPack = {
    id: 'runtime-execute-contract',
    name: 'Runtime Execute Contract',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'contract_runtime_execute',
            description: 'Exercise runtime-managed tool execution.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
          metadata: {
            name: 'contract_runtime_execute',
            readOnly: false,
            destructive: true,
            requiresApproval: true,
            access: ['write'],
            scope: ['workspace'],
          },
        },
        async run(args, ctx) {
          const root = ctx.workspaceRoots?.[0]
          const nested = args.nested as { value?: unknown } | undefined
          const originalValue = args.value
          runnerSawRuntimeContext =
            args.value === 'runtime' &&
            nested?.value === 'caller-nested' &&
            ctx.settings !== settings &&
            ctx.settings.apiKeys.openrouter === 'runtime-key' &&
            ctx.conversationId === 'conversation-runtime-tool' &&
            ctx.messageId === 'assistant-runtime-tool' &&
            ctx.toolCallId === 'tool-call-runtime-tool' &&
            ctx.workspaceRoots !== workspaceRoots &&
            typeof root === 'object' &&
            root.path === '/contract@aila/agent-root' &&
            root.label === 'contract' &&
            root !== workspaceRoots[0]
          args.value = 'runner-mutated'
          if (nested) nested.value = 'runner-mutated'
          ctx.settings.apiKeys.openrouter = 'mutated'
          if (root && typeof root !== 'string') root.label = 'mutated'
          return JSON.stringify({ ok: true, value: originalValue })
        },
      },
    ],
  }

  const runtime = new WorkbenchRuntime({
    loadSettings: () => {
      loadSettingsCalled = true
      return settings
    },
    loadToolPacks: async () => [toolPack],
    workspaceRoots: () => workspaceRoots,
    onToolPolicy: (request) => {
      const nested = request.args.nested as { value?: unknown } | undefined
      policySawRuntimeRequest =
        request.name === 'contract_runtime_execute' &&
        request.args.value === 'runtime' &&
        nested?.value === 'caller-nested' &&
        request.conversationId === 'conversation-runtime-tool' &&
        request.messageId === 'assistant-runtime-tool' &&
        request.toolCallId === 'tool-call-runtime-tool' &&
        request.metadata.requiresApproval
      request.args.value = 'policy-mutated'
      if (nested) nested.value = 'policy-mutated'
      request.metadata.requiresApproval = false
      return { action: 'ask' }
    },
    onToolApproval: async (request) => {
      const nested = request.args.nested as { value?: unknown } | undefined
      approvalSawRuntimeRequest =
        request.name === 'contract_runtime_execute' &&
        request.args.value === 'runtime' &&
        nested?.value === 'caller-nested' &&
        request.metadata.destructive
      request.args.value = 'approval-mutated'
      if (nested) nested.value = 'approval-mutated'
      return true
    },
  })

  const runtimeArgs: Record<string, unknown> = {
    value: 'runtime',
    nested: { value: 'caller-nested' },
  }
  const result = await runtime.executeTool({
    name: 'contract_runtime_execute',
    args: runtimeArgs,
    conversationId: 'conversation-runtime-tool',
    messageId: 'assistant-runtime-tool',
    toolCallId: 'tool-call-runtime-tool',
  })

  assertEqual(JSON.parse(result).value, 'runtime', 'runtime execute tool result')
  assertEqual(loadSettingsCalled, true, 'runtime execute should load host settings')
  assertEqual(policySawRuntimeRequest, true, 'runtime execute should use host tool policy')
  assertEqual(approvalSawRuntimeRequest, true, 'runtime execute should use host tool approval')
  assertEqual(runnerSawRuntimeContext, true, 'runtime execute should pass runtime tool context')
  assertEqual(
    runtimeArgs.value,
    'runtime',
    'runtime execute should isolate caller args from policy and runner mutation',
  )
  assertEqual(
    (runtimeArgs.nested as { value?: unknown }).value,
    'caller-nested',
    'runtime execute should isolate caller nested args from policy and runner mutation',
  )
  assertEqual(
    settings.apiKeys.openrouter,
    'runtime-key',
    'runtime execute should isolate host settings from tool mutation',
  )
  assertEqual(
    workspaceRoots[0]?.label,
    'contract',
    'runtime execute should isolate host workspace roots from tool mutation',
  )
}

async function testGenerateImageToolUsesInjectedImageDependencies(): Promise<void> {
  const imageBlocks: Array<{ url: string; mime: string; prompt: string }> = []
  let generatedPrompt: string | null = null
  let savedFilename: string | null = null
  let savedBytesLength = 0

  const result = await executeTool(
    'generate_image',
    { prompt: 'contract image' },
    {
      settings: {
        apiKeys: {},
        defaultModel: null,
        defaultImageModel: { providerId: 'openrouter', modelId: 'openai/gpt-image-1' },
      },
      generateImage: async (request) => {
        generatedPrompt = request.prompt
        return { bytes: Buffer.from([1, 2, 3, 4]), mime: 'image/webp' }
      },
      saveImage: async (bytes, filename) => {
        savedFilename = filename
        savedBytesLength = bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteLength
        return { url: 'aila-image://i/contract.webp' }
      },
      onImage: (block) => imageBlocks.push(block),
    },
  )

  const parsed = JSON.parse(result) as { ok?: unknown; model?: unknown }
  assertEqual(parsed.ok, true, 'generate_image injected dependency result ok')
  assertEqual(
    parsed.model,
    'openrouter:openai/gpt-image-1',
    'generate_image injected dependency model',
  )
  assertEqual(generatedPrompt, 'contract image', 'injected image generator prompt')
  assertEqual(savedFilename, 'image.webp', 'injected image saver filename')
  assertEqual(savedBytesLength, 4, 'injected image saver bytes')
  assertEqual(imageBlocks.length, 1, 'generate_image should emit image side channel')
  assertEqual(imageBlocks[0]?.url, 'aila-image://i/contract.webp', 'image side channel url')
  assertEqual(imageBlocks[0]?.mime, 'image/webp', 'image side channel mime')
  assertEqual(imageBlocks[0]?.prompt, 'contract image', 'image side channel prompt')
}

async function testGenerateImageToolRequiresHostImageDependencies(): Promise<void> {
  const settings: Settings = {
    apiKeys: {},
    defaultModel: null,
    defaultImageModel: { providerId: 'openrouter', modelId: 'openai/gpt-image-1' },
  }

  try {
    await executeTool('generate_image', { prompt: 'missing image host' }, { settings })
    throw new Error('generate_image unexpectedly succeeded without image host')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('image generation host is not available'),
      'generate_image should fail closed without an injected image generator',
    )
  }

  try {
    await executeTool(
      'generate_image',
      { prompt: 'missing image storage host' },
      {
        settings,
        generateImage: async () => ({ bytes: Buffer.from([1, 2, 3]), mime: 'image/png' }),
      },
    )
    throw new Error('generate_image unexpectedly succeeded without image storage host')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('image storage host is not available'),
      'generate_image should fail closed without an injected image saver',
    )
  }
}

async function testWebSearchToolUsesInjectedHostDependency(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }
  const abortController = new AbortController()
  const requestSeen: { current?: ToolWebSearchRequest } = {}

  const result = await executeTool(
    'web_search',
    {
      query: 'Aila runtime',
      search_depth: 'advanced',
      topic: 'news',
      time_range: 'week',
      max_results: 99,
    },
    {
      settings,
      signal: abortController.signal,
      webSearch: async (request) => {
        requestSeen.current = { ...request }
        return {
          answer: 'Injected search answer',
          results: [
            {
              title: 'Injected result',
              url: 'https://example.com@aila/agent',
              content: 'Injected snippet',
            },
          ],
        }
      },
    },
  )

  const parsed = JSON.parse(result) as {
    answer?: unknown
    results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>
  }
  const firstResult = parsed.results?.[0]
  assertEqual(parsed.answer, 'Injected search answer', 'web_search injected dependency answer')
  assert(firstResult, 'web_search injected dependency should return a result')
  assertEqual(firstResult.title, 'Injected result', 'web_search injected dependency result title')
  assertEqual(
    firstResult.url,
    'https://example.com@aila/agent',
    'web_search injected dependency url',
  )
  assertEqual(firstResult.content, 'Injected snippet', 'web_search injected dependency content')

  const seenRequest = requestSeen.current
  assert(seenRequest, 'web_search should call the injected host dependency')
  assertEqual(seenRequest.query, 'Aila runtime', 'web_search request query')
  assertEqual(seenRequest.searchDepth, 'advanced', 'web_search request search depth')
  assertEqual(seenRequest.topic, 'news', 'web_search request topic')
  assertEqual(seenRequest.timeRange, 'week', 'web_search request time range')
  assertEqual(seenRequest.maxResults, 10, 'web_search request max results should be clamped')
  assertEqual(seenRequest.signal, abortController.signal, 'web_search request abort signal')
}

async function testWebSearchToolRequiresHostDependency(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }

  try {
    await executeTool('web_search', { query: 'Aila runtime' }, { settings })
    throw new Error('web_search unexpectedly succeeded without a host dependency')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('web search host is not available'),
      'web_search should fail closed without an injected host dependency',
    )
  }
}

async function testNodeWebSearchRegistryFallbacksAndMerge(): Promise<void> {
  const fallbackCalls: string[] = []
  const fallbackSearch = runtimePackageNodeSdk.createDefaultWebSearch({
    providers: {
      tavily: { apiKey: '' },
      duckduckgo: {},
      wikimedia: {},
    },
    order: ['tavily', 'duckduckgo', 'wikimedia'],
    fetch: async (url) => {
      const href = String(url)
      fallbackCalls.push(href)
      if (href.includes('api.duckduckgo.com')) {
        return new Response(JSON.stringify({ RelatedTopics: [] }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          pages: [
            {
              key: 'Aila',
              title: 'Aila',
              excerpt: 'Aila runtime search result',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    },
  })
  const fallback = await fallbackSearch({
    query: 'Aila',
    searchDepth: 'basic',
    topic: 'general',
    maxResults: 3,
  })
  assert(
    fallbackCalls.some((url) => url.includes('api.duckduckgo.com')) &&
      fallbackCalls.some((url) => url.includes('api.wikimedia.org')),
    'node web search should fallback from empty DuckDuckGo result to Wikimedia without Tavily key',
  )
  assertEqual(fallback.results?.[0]?.source, 'wikimedia', 'fallback result source')

  let searxngSignal: AbortSignal | undefined
  const controller = new AbortController()
  const searxngSearch = runtimePackageNodeSdk.createDefaultWebSearch({
    providers: {
      searxng: { baseUrl: 'https://searx.example' },
      duckduckgo: {},
    },
    order: ['searxng', 'duckduckgo'],
    fetch: async (url, init) => {
      assert(String(url).startsWith('https://searx.example/search?'), 'SearXNG should be first')
      searxngSignal = init?.signal ?? undefined
      return new Response(
        JSON.stringify({
          results: [{ title: 'SearXNG result', url: 'https://example.com/a', content: 'Snippet' }],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    },
  })
  const searxng = await searxngSearch({
    query: 'Aila runtime',
    searchDepth: 'basic',
    topic: 'general',
    maxResults: 5,
    signal: controller.signal,
  })
  assertEqual(searxng.results?.[0]?.source, 'searxng', 'SearXNG result source')
  assertEqual(searxngSignal, controller.signal, 'SearXNG provider receives abort signal')

  const tavilyCalls: string[] = []
  const tavilyFallbackSearch = runtimePackageNodeSdk.createDefaultWebSearch({
    providers: {
      tavily: { apiKey: 'contract-key' },
      duckduckgo: {},
    },
    order: ['tavily', 'duckduckgo'],
    fetch: async (url) => {
      const href = String(url)
      tavilyCalls.push(href)
      if (href.includes('api.tavily.com')) return new Response('boom', { status: 500 })
      return new Response(
        JSON.stringify({
          RelatedTopics: [
            {
              Text: 'Fallback result - from DuckDuckGo',
              FirstURL: 'https://example.com/fallback',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    },
  })
  const tavilyFallback = await tavilyFallbackSearch({
    query: 'Aila runtime',
    searchDepth: 'basic',
    topic: 'general',
    maxResults: 5,
  })
  assert(
    tavilyCalls.some((url) => url.includes('api.tavily.com')) &&
      tavilyCalls.some((url) => url.includes('api.duckduckgo.com')),
    'node web search should fallback when Tavily provider fails',
  )
  assertEqual(tavilyFallback.results?.[0]?.source, 'duckduckgo', 'Tavily fallback source')

  const mergeRegistry = runtimePackageNodeSdk.createWebSearchRegistry({
    adapters: [
      {
        id: 'one',
        search: async () => ({
          results: [
            { title: 'One', url: 'https://example.com/shared#fragment', source: 'one' },
            { title: 'Only one', url: 'https://example.com/one', source: 'one' },
          ],
        }),
      },
      {
        id: 'two',
        search: async () => ({
          results: [
            { title: 'Two', url: 'https://example.com/shared', source: 'two' },
            { title: 'Only two', url: 'https://example.com/two', source: 'two' },
          ],
        }),
      },
    ],
    order: ['one', 'two'],
    advancedMode: 'merge',
  })
  const merged = await mergeRegistry.search({
    query: 'Aila runtime',
    searchDepth: 'advanced',
    topic: 'general',
    maxResults: 2,
  })
  assertEqual(merged.results?.length, 2, 'advanced merge should respect maxResults')
  assertEqual(
    merged.results?.filter((result) => result.url?.includes('/shared')).length,
    1,
    'advanced merge should dedupe URLs',
  )
}

async function testNodeContextTokenCounterContract(): Promise<void> {
  const anthropicRequests: { url: string; body: Record<string, unknown> }[] = []
  const anthropicCounter = runtimePackageNodeSdk.createNodeContextTokenCounter({
    providers: {
      anthropic: { api: 'anthropic-messages', apiKey: 'anthropic-key' },
    },
    fetch: async (url, init) => {
      anthropicRequests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(JSON.stringify({ input_tokens: 321 }), {
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  const anthropicCount = await anthropicCounter({
    conversationId: 'ctx-counter',
    assistantMessageId: 'asst-counter',
    selection: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
    messages: [
      { role: 'system', content: 'system instructions' },
      { role: 'user', content: 'count this' },
    ],
    contextPlan: runtimeSdk.assembleAgentContext({
      messages: [],
      modelInfo: { model: 'counter', contextLength: 100_000 },
    }).plan,
  })
  assertEqual(
    anthropicCount.method,
    'anthropic_count_tokens',
    'node context token counter should use Anthropic count_tokens when available',
  )
  assertEqual(anthropicCount.inputTokens, 321, 'Anthropic token counter should return input_tokens')
  assert(
    anthropicRequests[0]?.url.includes('/messages/count_tokens') &&
      anthropicRequests[0]?.body.model === 'claude-haiku-4-5',
    'Anthropic token counter should call the provider count endpoint',
  )

  const googleCounter = runtimePackageNodeSdk.createNodeContextTokenCounter({
    providers: {
      google: { api: 'google-generative-ai', apiKey: 'google-key' },
    },
    fetch: async () =>
      new Response(JSON.stringify({ totalTokens: 222 }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  })
  const googleCount = await googleCounter({
    conversationId: 'ctx-counter',
    assistantMessageId: 'asst-counter',
    selection: { providerId: 'google', modelId: 'gemini-2.5-pro' },
    messages: [{ role: 'user', content: 'count this' }],
    contextPlan: runtimeSdk.assembleAgentContext({
      messages: [],
      modelInfo: { model: 'counter', contextLength: 100_000 },
    }).plan,
  })
  assertEqual(
    googleCount.method,
    'google_count_tokens',
    'node context token counter should use Google countTokens when available',
  )
  assertEqual(googleCount.inputTokens, 222, 'Google token counter should return totalTokens')

  const fallbackCounter = runtimePackageNodeSdk.createNodeContextTokenCounter({
    providers: {
      openai: { api: 'openai-chat-completions' },
    },
  })
  const fallbackCount = await fallbackCounter({
    conversationId: 'ctx-counter',
    assistantMessageId: 'asst-counter',
    selection: { providerId: 'openai', modelId: 'gpt-5.4-mini' },
    messages: [{ role: 'user', content: 'fallback count' }],
    contextPlan: runtimeSdk.assembleAgentContext({
      messages: [],
      modelInfo: { model: 'counter', contextLength: 100_000 },
    }).plan,
  })
  assertEqual(
    fallbackCount.method,
    'provider_char_ratio_fallback',
    'node context token counter should fallback when exact provider counting is unavailable',
  )
  assert(
    fallbackCount.inputTokens > 0,
    'fallback token counter should still return a token estimate',
  )
}

async function testNodeSemanticCompactGeneratorContract(): Promise<void> {
  let compactRequestMessages: ChatMessage[] = []
  const generator = runtimePackageNodeSdk.createNodeSemanticCompactGenerator({
    providers: {
      openai: { api: 'openai-chat-completions', apiKey: 'compact-key' },
    },
    modelStreamClient: {
      async *stream(input) {
        compactRequestMessages = input.messages
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            summary: 'semantic summary from model',
            userRequests: ['continue context work'],
            decisions: ['use a model pass for semantic compact'],
            files: [{ path: 'packages/agent/src/context.ts', mentions: 1 }],
            toolActivity: [{ name: 'read', count: 2 }],
            toolResults: [],
            nextSteps: ['wire default host'],
          }),
        }
        yield { type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      },
    },
  })
  const recommended = runtimeSdk.assembleAgentContext({
    messages: Array.from({ length: 24 }, (_, index) => ({
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: `compact-source-user-${index}`,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, content: `continue context work ${'x'.repeat(900)}` }],
      status: 'done' as const,
    })),
    modelInfo: { model: 'tiny', contextLength: 4_000 },
  }).plan.compaction.recommendedCheckpoint
  assert(recommended, 'contract should produce a checkpoint recommendation')
  const result = await generator({
    conversationId: 'compact-conversation',
    selection: { providerId: 'openai', modelId: 'gpt-5.4-mini' },
    recommendedCheckpoint: recommended,
    sourceMessages: [
      {
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: 'compact-source-user',
        role: 'user',
        blocks: [{ type: 'text', content: 'continue context work' }],
        status: 'done',
      },
    ],
  })
  assertEqual(
    result?.artifact.summary,
    'semantic summary from model',
    'node semantic compact generator should parse model JSON into an artifact',
  )
  assert(
    compactRequestMessages.some(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('Existing heuristic artifact'),
    ),
    'node semantic compact generator should provide heuristic artifact context to the model pass',
  )

  const invalidJsonGenerator = runtimePackageNodeSdk.createNodeSemanticCompactGenerator({
    providers: {
      openai: { api: 'openai-chat-completions', apiKey: 'compact-key' },
    },
    modelStreamClient: {
      async *stream() {
        yield {
          type: 'text-delta',
          text: '{"summary":"truncated compact artifact"',
        }
        yield { type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      },
    },
  })
  const invalidResult = await invalidJsonGenerator({
    conversationId: 'compact-conversation',
    selection: { providerId: 'openai', modelId: 'gpt-5.4-mini' },
    recommendedCheckpoint: recommended,
    sourceMessages: [],
  })
  assertEqual(
    invalidResult,
    null,
    'node semantic compact generator should ignore invalid JSON and let runtime fallback',
  )
}

async function testNativeOpenAiChatModelStreamContract(): Promise<void> {
  const requests: unknown[] = []
  const streamBodies = [
    sse([
      {
        choices: [
          {
            delta: {
              content: 'Checking ',
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_contract',
                  type: 'function',
                  function: {
                    name: 'contract_echo',
                    arguments: '{"message"',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: ':"hello"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 3,
          total_tokens: 10,
          prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      },
    ]),
  ]
  const fetchImpl: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as unknown)
    const body = streamBodies.shift()
    assert(body, 'native OpenAI chat test should have a fake stream body')
    return new Response(textStream(body), { status: 200 })
  }
  const client = runtimePackageNodeSdk.createOpenAiChatModelStreamClient({ fetch: fetchImpl })
  const events: runtimePackageNodeSdk.ModelStreamEvent[] = []

  for await (const event of client.stream({
    descriptor: {
      provider: 'openrouter',
      modelId: 'contract/mock',
      api: 'openai-chat-completions',
    },
    apiKey: 'contract-key',
    conversationId: 'native-openai-contract',
    cache: { mode: 'auto', ttl: '5m', openRouterStickySession: true },
    messages: [{ role: 'user', content: 'hello' }],
    signal: new AbortController().signal,
    tools: [
      {
        name: 'contract_echo',
        description: 'Echo a message.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
          additionalProperties: false,
        },
        execute: async (args) => `echo:${String(args.message ?? '')}`,
      },
    ],
  })) {
    events.push(event)
  }

  assertEqual(requests.length, 1, 'native OpenAI chat should perform one transport request')
  assertEqual(
    (requests[0] as Record<string, unknown>).session_id,
    'native-openai-contract',
    'OpenRouter chat should include sticky session id when cache is enabled',
  )
  assert(
    events.some((event) => event.type === 'tool-input-start' && event.toolName === 'contract_echo'),
    'native OpenAI chat should emit tool input start',
  )
  assert(
    events.some((event) => event.type === 'tool-call' && event.toolCallId === 'call_contract'),
    'native OpenAI chat should emit parsed tool call',
  )
  assert(
    !events.some((event) => event.type === 'tool-result'),
    'native OpenAI chat should not execute tools inside the transport client',
  )
  const finishStep = events.find((event) => event.type === 'finish-step')
  assert(finishStep?.type === 'finish-step', 'native OpenAI chat should finish the provider step')
  assertEqual(finishStep.usage?.totalTokens, 10, 'native OpenAI chat should report step usage')
  assertEqual(
    finishStep.usage?.cacheReadTokens,
    4,
    'native OpenAI chat should report cached prompt reads',
  )
  assertEqual(
    finishStep.usage?.cacheWriteTokens,
    1,
    'native OpenAI chat should report cached prompt writes',
  )
  assertEqual(
    finishStep.usage?.cacheMissTokens,
    2,
    'native OpenAI chat should report prompt cache misses',
  )
  assertEqual(
    finishStep.usage?.reasoningTokens,
    2,
    'native OpenAI chat should report reasoning tokens',
  )
}

async function testNativeOpenAiChatRequiredImageContract(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aila-runtime-required-image-'))
  let transportCalled = false
  try {
    const client = runtimePackageNodeSdk.createOpenAiChatModelStreamClient({
      imageDir: dir,
      fetch: async () => {
        transportCalled = true
        return new Response(textStream(sse([])), { status: 200 })
      },
    })
    let failure: Error | null = null

    try {
      for await (const event of client.stream({
        descriptor: {
          provider: 'openrouter',
          modelId: 'contract/vision',
          api: 'openai-chat-completions',
        },
        apiKey: 'contract-key',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', url: 'aila-image://i/missing.png', mime: 'image/png' },
            ],
          },
        ],
        signal: new AbortController().signal,
        tools: [],
        requireImages: true,
      })) {
        throw new Error(`required image stream should not yield ${event.type}`)
      }
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err))
    }

    assert(failure, 'required image stream should fail when the local image is missing')
    assert(
      failure.message.includes('Unable to load attached image aila-image://i/missing.png'),
      'required image failure should identify the missing attachment',
    )
    assertEqual(
      transportCalled,
      false,
      'required image stream should not call the provider when local image loading fails',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testNativeDeepSeekProviderContract(): Promise<void> {
  const registry = runtimePackageNodeSdk.createModelRegistry()
  const descriptor = registry.resolve({
    providerId: 'deepseek',
    modelId: 'deepseek-v4-pro',
  })
  assertEqual(descriptor.api, 'openai-chat-completions', 'DeepSeek should use chat completions')
  assertEqual(descriptor.baseUrl, 'https://api.deepseek.com', 'DeepSeek base URL')
  assertEqual(
    runtimeSdk.PROVIDER_LABELS.deepseek,
    'DeepSeek',
    'DeepSeek should be a known provider',
  )
  assert(
    runtimePackageNodeSdk
      .configuredProviders(
        { apiKeys: {}, defaultModel: null },
        { env: { DEEPSEEK_API_KEY: 'deepseek-key' } },
      )
      .includes('deepseek'),
    'configuredProviders should recognize DEEPSEEK_API_KEY',
  )

  let requestUrl = ''
  let authHeader = ''
  let requestBody: Record<string, unknown> = {}
  const fetchImpl: typeof fetch = async (url, init) => {
    requestUrl = String(url)
    const headers = init?.headers as Record<string, string> | undefined
    authHeader = headers?.Authorization ?? ''
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(
      textStream(
        sse([
          {
            choices: [{ delta: { content: 'ok' } }],
            usage: {
              prompt_tokens: 6,
              completion_tokens: 4,
              total_tokens: 10,
              prompt_cache_hit_tokens: 3,
              prompt_cache_miss_tokens: 3,
            },
          },
        ]),
      ),
      {
        status: 200,
      },
    )
  }
  const client = runtimePackageNodeSdk.createOpenAiChatModelStreamClient({ fetch: fetchImpl })
  const events: runtimePackageNodeSdk.ModelStreamEvent[] = []

  for await (const event of client.stream({
    descriptor,
    apiKey: 'deepseek-key',
    messages: [{ role: 'user', content: 'hello' }],
    signal: new AbortController().signal,
    tools: [],
  })) {
    events.push(event)
  }

  assertEqual(
    requestUrl,
    'https://api.deepseek.com/chat/completions',
    'DeepSeek should target native chat completions endpoint',
  )
  assertEqual(authHeader, 'Bearer deepseek-key', 'DeepSeek should use bearer auth')
  assertEqual(requestBody.model, 'deepseek-v4-pro', 'DeepSeek request should keep model id')
  assert(
    events.some((event) => event.type === 'text-delta'),
    'DeepSeek stream should reuse OpenAI-compatible SSE parsing',
  )
  const finishStep = events.find((event) => event.type === 'finish-step')
  assert(finishStep?.type === 'finish-step', 'DeepSeek stream should finish the provider step')
  assertEqual(
    finishStep.usage?.cacheReadTokens,
    3,
    'DeepSeek stream should report prompt cache hits',
  )
  assertEqual(
    finishStep.usage?.cacheMissTokens,
    3,
    'DeepSeek stream should report prompt cache misses',
  )
}

function testOpenRouterVisionModelCatalogContract(): void {
  const openRouterVisionModels = runtimeSdk.VISION_MODEL_CATALOG.filter(
    (model) => model.providerId === 'openrouter',
  )
  assert(
    openRouterVisionModels.some((model) => model.modelId === 'openrouter/free'),
    'OpenRouter should expose at least one vision fallback model',
  )
  assert(
    openRouterVisionModels.every((model) => runtimeSdk.modelSupportsVision(model)),
    'OpenRouter vision fallback models should be marked vision-capable',
  )

  const descriptor = runtimePackageNodeSdk.createModelRegistry().resolve({
    providerId: 'openrouter',
    modelId: 'openrouter/free',
  })
  assert(
    runtimeSdk.modelSupportsVision(descriptor),
    'OpenRouter vision fallback models should remain vision-capable after registry resolution',
  )
}

async function testNativeAnthropicModelStreamContract(): Promise<void> {
  const requests: unknown[] = []
  const streamBodies = [
    sse([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'anthropic_contract',
          name: 'contract_echo',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"message"' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: ':"hello"}' },
      },
      {
        type: 'message_delta',
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    ]),
  ]
  const fetchImpl: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as unknown)
    const body = streamBodies.shift()
    assert(body, 'native Anthropic test should have a fake stream body')
    return new Response(textStream(body), { status: 200 })
  }
  const client = runtimePackageNodeSdk.createAnthropicModelStreamClient({ fetch: fetchImpl })
  const events: runtimePackageNodeSdk.ModelStreamEvent[] = []

  for await (const event of client.stream({
    descriptor: {
      provider: 'anthropic',
      modelId: 'claude-contract',
      api: 'anthropic-messages',
    },
    apiKey: 'contract-key',
    cache: { mode: 'explicit', ttl: '1h' },
    messages: [
      { role: 'system', content: 'stable system prefix' },
      { role: 'user', content: 'hello' },
    ],
    signal: new AbortController().signal,
    tools: [
      {
        name: 'contract_echo',
        description: 'Echo a message.',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
        execute: async (args) => `echo:${String(args.message ?? '')}`,
      },
    ],
  })) {
    events.push(event)
  }

  assertEqual(requests.length, 1, 'native Anthropic should perform one transport request')
  const request = requests[0] as Record<string, unknown>
  assert(Array.isArray(request.system), 'native Anthropic explicit cache should use system blocks')
  const [systemBlock] = request.system as Array<Record<string, unknown>>
  assertEqual(
    (systemBlock.cache_control as Record<string, unknown> | undefined)?.ttl,
    '1h',
    'native Anthropic explicit cache should include one-hour TTL when selected',
  )
  assert(
    events.some((event) => event.type === 'tool-input-start' && event.toolName === 'contract_echo'),
    'native Anthropic should emit tool input start',
  )
  assert(
    events.some((event) => event.type === 'tool-call' && event.toolCallId === 'anthropic_contract'),
    'native Anthropic should emit parsed tool call',
  )
  assert(
    !events.some((event) => event.type === 'tool-result'),
    'native Anthropic should not execute tools inside the transport client',
  )
  const finishStep = events.find((event) => event.type === 'finish-step')
  assert(finishStep?.type === 'finish-step', 'native Anthropic should finish the provider step')
  assertEqual(finishStep.usage?.totalTokens, 10, 'native Anthropic should report step usage')
  assertEqual(
    finishStep.usage?.cacheWriteTokens,
    5,
    'native Anthropic should report cache creation tokens',
  )
  assertEqual(
    finishStep.usage?.cacheReadTokens,
    0,
    'native Anthropic should report cache read tokens',
  )
  assertEqual(
    finishStep.usage?.cacheMissTokens,
    2,
    'native Anthropic should report uncached prompt tokens',
  )
}

async function testNativeGoogleModelStreamContract(): Promise<void> {
  const requests: unknown[] = []
  const streamBodies = [
    sse([
      {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'contract_echo', args: { message: 'hello' } } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 3,
          totalTokenCount: 10,
          cachedContentTokenCount: 4,
          thoughtsTokenCount: 2,
        },
      },
    ]),
  ]
  const fetchImpl: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as unknown)
    const body = streamBodies.shift()
    assert(body, 'native Google test should have a fake stream body')
    return new Response(textStream(body), { status: 200 })
  }
  const client = runtimePackageNodeSdk.createGoogleModelStreamClient({ fetch: fetchImpl })
  const events: runtimePackageNodeSdk.ModelStreamEvent[] = []

  for await (const event of client.stream({
    descriptor: {
      provider: 'google',
      modelId: 'gemini-contract',
      api: 'google-generative-ai',
    },
    apiKey: 'contract-key',
    messages: [{ role: 'user', content: 'hello' }],
    signal: new AbortController().signal,
    tools: [
      {
        name: 'contract_echo',
        description: 'Echo a message.',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
        execute: async (args) => `echo:${String(args.message ?? '')}`,
      },
    ],
  })) {
    events.push(event)
  }

  assertEqual(requests.length, 1, 'native Google should perform one transport request')
  assert(
    events.some((event) => event.type === 'tool-input-start' && event.toolName === 'contract_echo'),
    'native Google should emit tool input start',
  )
  assert(
    events.some((event) => event.type === 'tool-call' && event.toolName === 'contract_echo'),
    'native Google should emit parsed tool call',
  )
  assert(
    !events.some((event) => event.type === 'tool-result'),
    'native Google should not execute tools inside the transport client',
  )
  const finishStep = events.find((event) => event.type === 'finish-step')
  assert(finishStep?.type === 'finish-step', 'native Google should finish the provider step')
  assertEqual(finishStep.usage?.totalTokens, 10, 'native Google should report step usage')
  assertEqual(
    finishStep.usage?.cacheReadTokens,
    4,
    'native Google should report cached content tokens',
  )
  assertEqual(
    finishStep.usage?.cacheMissTokens,
    3,
    'native Google should report uncached prompt tokens',
  )
  assertEqual(finishStep.usage?.reasoningTokens, 2, 'native Google should report thinking tokens')
}

async function testProviderStreamChatOwnsToolLoopContract(): Promise<void> {
  const modelRequests: ChatMessage[][] = []
  const agentEvents: RunEvent[] = []
  const toolResults: string[] = []
  const doneMessages: PersistedMessage[] = []
  let toolRunCount = 0
  let doneUsage:
    | {
        promptTokens: number
        completionTokens: number
        totalTokens: number
        modelCallCount?: number
        maxInputTokens?: number
        lastInputTokens?: number
        lastOutputTokens?: number
        lastCacheReadTokens?: number
        lastCacheMissTokens?: number
        cacheReadTokens?: number
        cacheMissTokens?: number
      }
    | undefined

  const modelStreamClient: runtimePackageNodeSdk.ModelStreamClient = {
    async *stream(input) {
      modelRequests.push(structuredClone(input.messages))
      if (modelRequests.length === 1) {
        yield { type: 'text-delta', text: 'Checking ' }
        yield { type: 'tool-input-start', id: 'loop_tool', toolName: 'contract_echo' }
        yield { type: 'tool-input-delta', id: 'loop_tool', delta: '{"message":"hello"}' }
        yield {
          type: 'finish-step',
          usage: {
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 10,
            cacheReadTokens: 4,
            cacheMissTokens: 3,
          },
        }
        yield {
          type: 'tool-call',
          toolCallId: 'loop_tool',
          toolName: 'contract_echo',
          input: { message: 'hello' },
        }
        return
      }

      assert(
        input.messages.some(
          (message) =>
            message.role === 'tool' &&
            message.tool_call_id === 'loop_tool' &&
            message.content === 'echo:hello',
        ),
        'provider stream loop should append tool output before second model request',
      )
      yield { type: 'text-delta', text: 'done' }
      yield {
        type: 'finish-step',
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
          cacheReadTokens: 4,
          cacheMissTokens: 1,
        },
      }
    },
  }

  const toolPack: ToolPack = {
    id: 'provider-loop-contract',
    name: 'Provider Loop Contract',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'contract_echo',
            description: 'Echo model loop input.',
            parameters: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
              additionalProperties: false,
            },
          },
          metadata: {
            name: 'contract_echo',
            readOnly: true,
            destructive: false,
            requiresApproval: false,
            access: ['read'],
            scope: ['workspace'],
          },
        },
        async run(args) {
          toolRunCount += 1
          return `echo:${String(args.message ?? '')}`
        },
      },
    ],
  }

  const runAgent = runtimePackageNodeSdk.createDurableRunExecutor({
    modelStreamClient,
    settings: { apiKeys: { openrouter: 'contract-key' }, defaultModel: null },
  })

  await runAgent(
    {
      conversationId: 'provider-loop-conversation',
      assistantMessageId: 'provider-loop-assistant',
      run: {
        conversationId: 'provider-loop-conversation',
        turnId: 'provider-loop-turn',
        runId: 'provider-loop-run',
      },
      messages: [{ role: 'user', content: 'hello' }],
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      signal: new AbortController().signal,
      onRunEvent: (event) => agentEvents.push(event),
      toolRegistry: createDefaultToolRegistry([toolPack]),
    },
    {
      onTextDelta() {},
      onReasoningDelta() {},
      onToolCallStart() {},
      onToolCallArgsDelta() {},
      onToolCallResult(event) {
        toolResults.push(event.result)
      },
      onImageBlock() {},
      onDone(event) {
        doneMessages.push(event.message)
        doneUsage = event.usage
      },
      onError(event) {
        throw new Error(event.error)
      },
    },
  )

  assertEqual(modelRequests.length, 2, 'provider stream loop should perform the second model step')
  assertEqual(toolRunCount, 1, 'provider stream loop should execute each tool once')
  assertEqual(toolResults[0], 'echo:hello', 'provider stream loop should emit the tool result')
  assertEqual(doneUsage?.totalTokens, 17, 'provider stream loop should accumulate step usage')
  assertEqual(doneUsage?.modelCallCount, 2, 'provider stream loop should count model calls')
  assertEqual(doneUsage?.maxInputTokens, 7, 'provider stream loop should keep max input tokens')
  assertEqual(doneUsage?.lastInputTokens, 5, 'provider stream loop should keep last input tokens')
  assertEqual(doneUsage?.lastOutputTokens, 2, 'provider stream loop should keep last output tokens')
  assertEqual(
    doneUsage?.lastCacheReadTokens,
    4,
    'provider stream loop should keep last cache read tokens',
  )
  assertEqual(
    doneUsage?.lastCacheMissTokens,
    1,
    'provider stream loop should keep last cache miss tokens',
  )
  assertEqual(doneUsage?.cacheReadTokens, 8, 'provider stream loop should total cache read tokens')
  assertEqual(doneUsage?.cacheMissTokens, 4, 'provider stream loop should total cache miss tokens')
  const completedMessage = doneMessages[0]
  assert(completedMessage, 'provider stream loop should produce a done message')
  assertEqual(
    completedMessage.status,
    'done',
    'provider stream loop should finish the assistant message',
  )
  assert(
    completedMessage.blocks.some(
      (block) => block.type === 'tool_call' && block.id === 'loop_tool' && block.status === 'done',
    ),
    'provider stream loop should persist the completed tool block',
  )
  assert(
    agentEvents.some((event) => event.type === 'tool.execution.completed'),
    'provider stream loop should emit tool execution completion',
  )
  assert(
    agentEvents.every(
      (event) =>
        event.turnId === 'provider-loop-turn' &&
        event.runId === 'provider-loop-run' &&
        typeof event.eventId === 'string' &&
        event.seq === undefined,
    ) && new Set(agentEvents.map((event) => event.eventId)).size === agentEvents.length,
    'provider stream loop should attach stable run identity and idempotency event IDs',
  )
  assert(
    agentEvents.some((event) => event.type === 'run.started') &&
      agentEvents.some((event) => event.type === 'run.completed'),
    'provider stream loop should emit run lifecycle boundaries',
  )
  const completedToolEvent = agentEvents.find((event) => event.type === 'tool.execution.completed')
  const toolStepEvent = agentEvents.find(
    (event) => event.type === 'step.started' && event.data?.kind === 'tool',
  )
  assert(
    completedToolEvent?.stepId !== undefined && completedToolEvent.stepId === toolStepEvent?.stepId,
    'tool execution events should belong to the individual tool step',
  )
  const replayed = replayRunState(agentEvents, 'provider-loop-run')
  assertEqual(replayed?.status, 'completed', 'run state should replay from emitted events')
  assertEqual(
    replayed?.steps.length,
    3,
    'replayed run should contain model, tools, and final model',
  )
  assertEqual(replayed?.steps[0]?.kind, 'model', 'replayed first step should be the model')
  assertEqual(replayed?.steps[1]?.kind, 'tool', 'replayed second step should be one tool call')
  assertEqual(replayed?.steps[2]?.kind, 'model', 'replayed final step should be the model')
}

async function testProviderToolApprovalPausesBeforeSideEffectContract(): Promise<void> {
  let modelCallCount = 0
  let toolRunCount = 0
  let resolveApproval: ((approved: boolean) => void) | undefined
  const snapshots: runtimeSdk.RunSnapshot[] = []
  const sessionEntries: runtimeSdk.SessionEntry[] = []
  const events: RunEvent[] = []

  const modelStreamClient: runtimePackageNodeSdk.ModelStreamClient = {
    async *stream() {
      modelCallCount += 1
      if (modelCallCount === 1) {
        yield {
          type: 'tool-call',
          toolCallId: 'approval-tool',
          toolName: 'approval_contract_tool',
          input: {},
        }
        yield {
          type: 'finish-step',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }
        return
      }
      yield { type: 'text-delta', text: 'approved' }
      yield {
        type: 'finish-step',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }
    },
  }
  const toolPack: ToolPack = {
    id: 'approval-runtime-contract',
    name: 'Approval Runtime Contract',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'approval_contract_tool',
            description: 'Exercise durable approval.',
            parameters: { type: 'object', additionalProperties: false },
          },
          metadata: {
            name: 'approval_contract_tool',
            readOnly: false,
            destructive: true,
            requiresApproval: true,
            access: ['write'],
            scope: ['workspace'],
          },
        },
        async run() {
          toolRunCount += 1
          return 'approved-result'
        },
      },
    ],
  }
  const runAgent = runtimePackageNodeSdk.createDurableRunExecutor({
    modelStreamClient,
    settings: { apiKeys: { openrouter: 'contract-key' }, defaultModel: null },
  })
  const running = runAgent(
    {
      conversationId: 'approval-runtime-conversation',
      assistantMessageId: 'approval-runtime-assistant',
      run: {
        conversationId: 'approval-runtime-conversation',
        turnId: 'approval-runtime-turn',
        runId: 'approval-runtime-run',
      },
      runContextRef: {
        schemaVersion: runtimeSdk.AILA_BLOB_SCHEMA_VERSION,
        blobId: 'approval-runtime-context',
        contentType: 'application/json',
        sizeBytes: 0,
      },
      messages: [{ role: 'user', content: 'approve it' }],
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      signal: new AbortController().signal,
      toolRegistry: createDefaultToolRegistry([toolPack]),
      onToolApproval: () =>
        new Promise<boolean>((resolve) => {
          resolveApproval = resolve
        }),
      onRunEvent: (event) => events.push(structuredClone(event)),
      saveRunSnapshot: (snapshot) => {
        snapshots.push(structuredClone(snapshot))
        return snapshot
      },
      appendSessionEntry: (entry) => {
        const prepared = runtimeSdk.prepareSessionEntry(
          'approval-runtime-conversation',
          sessionEntries,
          entry,
          () => `approval-entry-${sessionEntries.length + 1}`,
        )
        if (!prepared.duplicate) sessionEntries.push(prepared.entry)
        return prepared.entry
      },
      putBlob: (blob) => {
        const data = structuredClone(blob.data)
        return {
          schemaVersion: runtimeSdk.AILA_BLOB_SCHEMA_VERSION,
          blobId: blob.blobId ?? `approval-blob-${sessionEntries.length + 1}`,
          contentType: blob.contentType,
          sizeBytes: new TextEncoder().encode(JSON.stringify(data)).byteLength,
          ...(blob.preview ? { preview: blob.preview } : {}),
        }
      },
    },
    {
      onTextDelta() {},
      onReasoningDelta() {},
      onToolCallStart() {},
      onToolCallArgsDelta() {},
      onToolCallResult() {},
      onImageBlock() {},
      onDone() {},
      onError(event) {
        throw new Error(event.error)
      },
    },
  )

  await waitFor(
    () =>
      resolveApproval !== undefined &&
      snapshots.some(
        (snapshot) =>
          snapshot.loop.state.status === 'paused' &&
          snapshot.loop.state.wait?.reason === 'approval',
      ),
    'approval should persist a paused checkpoint',
  )
  assertEqual(toolRunCount, 0, 'approval pause must happen before the tool side effect')
  const paused = snapshots.find(
    (snapshot) =>
      snapshot.loop.state.status === 'paused' && snapshot.loop.state.wait?.reason === 'approval',
  )
  assertEqual(
    paused?.loop.state.steps.filter((step) => step.kind === 'tool').length,
    0,
    'approval checkpoint should not mark the tool as started',
  )

  resolveApproval?.(true)
  await running
  assertEqual(toolRunCount, 1, 'approved tool should execute exactly once')
  const pauseIndex = events.findIndex((event) => event.type === 'run.paused')
  const toolStartIndex = events.findIndex(
    (event) => event.type === 'step.started' && event.data?.kind === 'tool',
  )
  assert(
    pauseIndex >= 0 && toolStartIndex > pauseIndex,
    'durable approval pause should precede the tool step',
  )
}

function chatMessagesContainImage(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image'),
  )
}

function chatMessagesAsText(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      if (typeof message.content === 'string') return message.content
      return message.content
        .map((part) => (part.type === 'text' ? part.text : `[image:${part.url}]`))
        .join('\n')
    })
    .join('\n')
}

function imageUrlsInChatMessages(messages: ChatMessage[]): string[] {
  const urls: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'image') urls.push(part.url)
    }
  }
  return urls
}

function createVisionBridgeContractModelRegistry(): runtimePackageNodeSdk.ModelRegistry {
  return runtimePackageNodeSdk.createModelRegistry({
    builtinModels: false,
    providers: {
      deepseek: { api: 'openai-chat-completions' },
      openai: { api: 'openai-chat-completions' },
    },
    models: [
      {
        provider: 'deepseek',
        modelId: 'deepseek-contract-text',
        api: 'openai-chat-completions',
      },
      {
        provider: 'openai',
        modelId: 'gpt-contract-vision',
        api: 'openai-chat-completions',
        input: ['text', 'image'],
        capabilities: { vision: true },
      },
    ],
  })
}

async function testProviderStreamChatVisionFallbackContract(): Promise<void> {
  const requests: Array<{
    provider: string
    messages: ChatMessage[]
    step?: number
    requireImages?: boolean
  }> = []
  const agentEvents: RunEvent[] = []
  let doneUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined

  const modelStreamClient: runtimePackageNodeSdk.ModelStreamClient = {
    async *stream(input) {
      requests.push({
        provider: input.descriptor.provider,
        messages: structuredClone(input.messages),
        step: input.step,
        requireImages: input.requireImages,
      })

      if (input.descriptor.provider === 'openai') {
        assertEqual(input.step, -1, 'vision fallback should call the vision model as a bridge step')
        assertEqual(
          input.requireImages,
          true,
          'vision fallback should require local image loading before provider transport',
        )
        assert(
          chatMessagesContainImage(input.messages),
          'vision fallback should send original image content to the vision model',
        )
        yield { type: 'text-delta', text: 'Summary: chart with revenue.' }
        yield { type: 'finish-step', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }
        return
      }

      assertEqual(
        input.descriptor.provider,
        'deepseek',
        'vision fallback should send the final request to the selected text model',
      )
      assert(
        !chatMessagesContainImage(input.messages),
        'vision fallback should not send image parts to the text-only model',
      )
      const text = chatMessagesAsText(input.messages)
      assert(
        text.includes('what is in this image?') &&
          text.includes('<image-analysis') &&
          text.includes('Summary: chart with revenue.'),
        'vision fallback should inject the vision model analysis into text-only model context',
      )
      yield { type: 'text-delta', text: 'answered' }
      yield { type: 'finish-step', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }
    },
  }

  const runAgent = runtimePackageNodeSdk.createDurableRunExecutor({
    modelRegistry: createVisionBridgeContractModelRegistry(),
    modelStreamClient,
    settings: {
      apiKeys: { deepseek: 'text-key', openai: 'vision-key' },
      defaultModel: null,
      defaultVisionModel: { providerId: 'openai', modelId: 'gpt-contract-vision' },
      visionFallbackMode: 'auto',
    },
  })

  await runAgent(
    {
      conversationId: 'provider-vision-fallback-conversation',
      assistantMessageId: 'provider-vision-fallback-assistant',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this image?' },
            { type: 'image', url: 'aila-image://contract/chart.png', mime: 'image/png' },
          ],
        },
      ],
      selection: { providerId: 'deepseek', modelId: 'deepseek-contract-text' },
      signal: new AbortController().signal,
      onRunEvent(event) {
        agentEvents.push(event)
      },
    },
    {
      onTextDelta() {},
      onReasoningDelta() {},
      onToolCallStart() {},
      onToolCallArgsDelta() {},
      onToolCallResult() {},
      onImageBlock() {},
      onDone(event) {
        doneUsage = event.usage
      },
      onError(event) {
        throw new Error(event.error)
      },
    },
  )

  assertEqual(requests.length, 2, 'vision fallback should make one vision and one text request')
  assertEqual(requests[0]?.provider, 'openai', 'vision fallback should inspect images first')
  assertEqual(
    requests[0]?.requireImages,
    true,
    'vision fallback bridge request should require images',
  )
  assertEqual(requests[1]?.provider, 'deepseek', 'vision fallback should call the text model last')
  assert(
    agentEvents.some((event) => event.type === 'vision.bridge.started'),
    'vision fallback should emit a bridge started event',
  )
  assert(
    agentEvents.some((event) => event.type === 'vision.bridge.completed'),
    'vision fallback should emit a bridge completed event',
  )
  assertEqual(
    doneUsage?.totalTokens,
    14,
    'vision fallback should include bridge usage in turn usage',
  )
}

async function testProviderStreamChatVisionFallbackUsesLatestImageContract(): Promise<void> {
  const requests: Array<{
    provider: string
    messages: ChatMessage[]
    step?: number
    requireImages?: boolean
  }> = []

  const modelStreamClient: runtimePackageNodeSdk.ModelStreamClient = {
    async *stream(input) {
      requests.push({
        provider: input.descriptor.provider,
        messages: structuredClone(input.messages),
        step: input.step,
        requireImages: input.requireImages,
      })

      if (input.descriptor.provider === 'openai') {
        assertEqual(
          input.requireImages,
          true,
          'latest-image vision bridge should require local image loading',
        )
        const imageUrls = imageUrlsInChatMessages(input.messages)
        assertEqual(imageUrls.length, 1, 'vision bridge should analyze one user turn image set')
        assertEqual(
          imageUrls[0],
          'aila-image://contract/current-lab.png',
          'vision bridge should analyze the latest image, not an older context image',
        )
        yield { type: 'text-delta', text: 'Summary: optical lab table with lenses.' }
        yield { type: 'finish-step', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }
        return
      }

      const text = chatMessagesAsText(input.messages)
      assert(
        text.includes('Summary: optical lab table with lenses.'),
        'main text model should receive the latest image analysis',
      )
      assert(
        !text.includes('cute kitten loading screen'),
        'main text model should not receive stale analysis for older images',
      )
      assert(
        !chatMessagesContainImage(input.messages),
        'main text model should not receive raw image parts after bridging',
      )
      yield { type: 'text-delta', text: 'answered latest image' }
      yield { type: 'finish-step', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }
    },
  }

  const runAgent = runtimePackageNodeSdk.createDurableRunExecutor({
    modelRegistry: createVisionBridgeContractModelRegistry(),
    modelStreamClient,
    settings: {
      apiKeys: { deepseek: 'text-key', openai: 'vision-key' },
      defaultModel: null,
      defaultVisionModel: { providerId: 'openai', modelId: 'gpt-contract-vision' },
      visionFallbackMode: 'auto',
    },
  })

  await runAgent(
    {
      conversationId: 'provider-vision-latest-image-conversation',
      assistantMessageId: 'provider-vision-latest-image-assistant',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'older image' },
            { type: 'image', url: 'aila-image://contract/old-kitten.png', mime: 'image/png' },
          ],
        },
        { role: 'assistant', content: 'Earlier answer acknowledged the older image.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '看看' },
            { type: 'image', url: 'aila-image://contract/current-lab.png', mime: 'image/png' },
          ],
        },
      ],
      selection: { providerId: 'deepseek', modelId: 'deepseek-contract-text' },
      signal: new AbortController().signal,
    },
    {
      onTextDelta() {},
      onReasoningDelta() {},
      onToolCallStart() {},
      onToolCallArgsDelta() {},
      onToolCallResult() {},
      onImageBlock() {},
      onDone() {},
      onError(event) {
        throw new Error(event.error)
      },
    },
  )

  assertEqual(
    requests.filter((request) => request.provider === 'openai').length,
    1,
    'vision bridge should not re-analyze older image messages',
  )
  assertEqual(
    requests.at(-1)?.provider,
    'deepseek',
    'latest-image flow should finish on text model',
  )
}

async function testProviderStreamChatVisionFallbackCachesAnalysisContract(): Promise<void> {
  await withTempDataDir(async (dir) => {
    const imageDir = join(dir, 'images')
    await mkdir(imageDir, { recursive: true })
    await writeFile(join(imageDir, 'cache-lab.png'), 'contract image bytes')

    let visionCalls = 0
    const finalPrompts: string[] = []
    const agentEvents: RunEvent[] = []
    const modelStreamClient: runtimePackageNodeSdk.ModelStreamClient = {
      async *stream(input) {
        if (input.descriptor.provider === 'openai') {
          visionCalls += 1
          yield { type: 'text-delta', text: 'Cached summary: optical table with lenses.' }
          yield { type: 'finish-step', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }
          return
        }

        finalPrompts.push(chatMessagesAsText(input.messages))
        yield { type: 'text-delta', text: 'answered from cached analysis' }
        yield { type: 'finish-step', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }
      },
    }

    const runAgent = runtimePackageNodeSdk.createDurableRunExecutor({
      modelRegistry: createVisionBridgeContractModelRegistry(),
      modelStreamClient,
      dataDir: dir,
      imageDir,
      settings: {
        apiKeys: { deepseek: 'text-key', openai: 'vision-key' },
        defaultModel: null,
        defaultVisionModel: { providerId: 'openai', modelId: 'gpt-contract-vision' },
        visionFallbackMode: 'auto',
      },
    })
    const imageMessage: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: '看看' },
        { type: 'image', url: 'aila-image://i/cache-lab.png', mime: 'image/png' },
      ],
    }

    for (const [index, messages] of [
      [imageMessage],
      [
        imageMessage,
        { role: 'assistant' as const, content: 'First answer.' },
        { role: 'user' as const, content: '继续解释一下' },
      ],
    ].entries()) {
      await runAgent(
        {
          conversationId: `provider-vision-cache-conversation-${index}`,
          assistantMessageId: `provider-vision-cache-assistant-${index}`,
          messages,
          selection: { providerId: 'deepseek', modelId: 'deepseek-contract-text' },
          signal: new AbortController().signal,
          onRunEvent(event) {
            agentEvents.push(event)
          },
        },
        {
          onTextDelta() {},
          onReasoningDelta() {},
          onToolCallStart() {},
          onToolCallArgsDelta() {},
          onToolCallResult() {},
          onImageBlock() {},
          onDone() {},
          onError(event) {
            throw new Error(event.error)
          },
        },
      )
    }

    assertEqual(visionCalls, 1, 'cached image analysis should avoid repeated vision calls')
    assertEqual(finalPrompts.length, 2, 'both turns should reach the text model')
    assert(
      finalPrompts.every((prompt) => prompt.includes('Cached summary: optical table with lenses.')),
      'text model prompts should include the cached image analysis on follow-up turns',
    )
    assert(
      agentEvents.some(
        (event) => event.type === 'vision.bridge.completed' && event.data?.cacheHitCount === 1,
      ),
      'follow-up bridge completion should report a cache hit',
    )
    const cacheFiles = await readdir(join(dir, 'vision-analysis'))
    assertEqual(cacheFiles.length, 1, 'vision analysis should be persisted once per cache key')
  })
}

async function testProviderStreamChatVisionPassThroughContract(): Promise<void> {
  const requests: Array<{ provider: string; messages: ChatMessage[]; step?: number }> = []

  const modelStreamClient: runtimePackageNodeSdk.ModelStreamClient = {
    async *stream(input) {
      requests.push({
        provider: input.descriptor.provider,
        messages: structuredClone(input.messages),
        step: input.step,
      })
      assertEqual(
        input.descriptor.provider,
        'openai',
        'native vision pass-through should use the selected vision model',
      )
      assert(
        chatMessagesContainImage(input.messages),
        'native vision pass-through should preserve image parts',
      )
      yield { type: 'text-delta', text: 'native answer' }
      yield { type: 'finish-step', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }
    },
  }

  const runAgent = runtimePackageNodeSdk.createDurableRunExecutor({
    modelRegistry: createVisionBridgeContractModelRegistry(),
    modelStreamClient,
    settings: {
      apiKeys: { openai: 'vision-key' },
      defaultModel: null,
      defaultVisionModel: { providerId: 'openai', modelId: 'gpt-contract-vision' },
      visionFallbackMode: 'auto',
    },
  })

  await runAgent(
    {
      conversationId: 'provider-vision-native-conversation',
      assistantMessageId: 'provider-vision-native-assistant',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'read this screenshot' },
            { type: 'image', url: 'aila-image://contract/screenshot.png', mime: 'image/png' },
          ],
        },
      ],
      selection: { providerId: 'openai', modelId: 'gpt-contract-vision' },
      signal: new AbortController().signal,
    },
    {
      onTextDelta() {},
      onReasoningDelta() {},
      onToolCallStart() {},
      onToolCallArgsDelta() {},
      onToolCallResult() {},
      onImageBlock() {},
      onDone() {},
      onError(event) {
        throw new Error(event.error)
      },
    },
  )

  assertEqual(requests.length, 1, 'native vision model should not use the fallback bridge')
  assertEqual(requests[0]?.step, 0, 'native vision model should use the normal first model step')
}

async function testProviderStreamChatVisionFallbackDisabledContract(): Promise<void> {
  const requests: ChatMessage[][] = []

  const modelStreamClient: runtimePackageNodeSdk.ModelStreamClient = {
    async *stream(input) {
      requests.push(structuredClone(input.messages))
      assertEqual(
        input.descriptor.provider,
        'deepseek',
        'disabled vision fallback should only call the selected text model',
      )
      assert(
        !chatMessagesContainImage(input.messages),
        'disabled vision fallback should remove image parts before provider dispatch',
      )
      assert(
        chatMessagesAsText(input.messages).includes('Vision fallback is disabled.'),
        'disabled vision fallback should explain why the image was omitted',
      )
      yield { type: 'text-delta', text: 'no image' }
      yield { type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    },
  }

  const runAgent = runtimePackageNodeSdk.createDurableRunExecutor({
    modelRegistry: createVisionBridgeContractModelRegistry(),
    modelStreamClient,
    settings: {
      apiKeys: { deepseek: 'text-key', openai: 'vision-key' },
      defaultModel: null,
      defaultVisionModel: { providerId: 'openai', modelId: 'gpt-contract-vision' },
      visionFallbackMode: 'disabled',
    },
  })

  await runAgent(
    {
      conversationId: 'provider-vision-disabled-conversation',
      assistantMessageId: 'provider-vision-disabled-assistant',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image', url: 'aila-image://contract/disabled.png', mime: 'image/png' },
          ],
        },
      ],
      selection: { providerId: 'deepseek', modelId: 'deepseek-contract-text' },
      signal: new AbortController().signal,
    },
    {
      onTextDelta() {},
      onReasoningDelta() {},
      onToolCallStart() {},
      onToolCallArgsDelta() {},
      onToolCallResult() {},
      onImageBlock() {},
      onDone() {},
      onError(event) {
        throw new Error(event.error)
      },
    },
  )

  assertEqual(requests.length, 1, 'disabled vision fallback should skip the vision model')
}

async function testProviderStreamChatVisionFallbackMissingConfigContract(): Promise<void> {
  let requestCount = 0
  let errorMessage = ''

  const modelStreamClient: runtimePackageNodeSdk.ModelStreamClient = {
    async *stream() {
      requestCount += 1
      yield { type: 'text-delta', text: 'unexpected' }
    },
  }

  const runAgent = runtimePackageNodeSdk.createDurableRunExecutor({
    modelRegistry: createVisionBridgeContractModelRegistry(),
    modelStreamClient,
    settings: {
      apiKeys: { deepseek: 'text-key' },
      defaultModel: null,
      defaultVisionModel: null,
      visionFallbackMode: 'auto',
    },
  })

  await runAgent(
    {
      conversationId: 'provider-vision-missing-config-conversation',
      assistantMessageId: 'provider-vision-missing-config-assistant',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image', url: 'aila-image://contract/missing.png', mime: 'image/png' },
          ],
        },
      ],
      selection: { providerId: 'deepseek', modelId: 'deepseek-contract-text' },
      signal: new AbortController().signal,
    },
    {
      onTextDelta() {},
      onReasoningDelta() {},
      onToolCallStart() {},
      onToolCallArgsDelta() {},
      onToolCallResult() {},
      onImageBlock() {},
      onDone() {
        throw new Error('missing vision config should not complete the turn')
      },
      onError(event) {
        errorMessage = event.error
      },
    },
  )

  assertEqual(requestCount, 0, 'missing vision config should fail before provider dispatch')
  assert(
    errorMessage.includes('Configure a Default Vision Model'),
    'missing vision config should explain how to fix the fallback',
  )
}

async function testProviderStreamChatPersistsLargeToolResultsContract(): Promise<void> {
  const largeOutput = 'abcdefghijklmnopqrstuvwxyz'
  const modelRequests: ChatMessage[][] = []
  const storedInputs: runtimePackageNodeSdk.ToolResultStorePersistInput[] = []
  const toolResults: string[] = []
  const doneMessages: PersistedMessage[] = []

  const toolResultStore: runtimePackageNodeSdk.ToolResultStore = {
    async persist(input) {
      storedInputs.push(structuredClone(input))
      return {
        kind: 'file',
        path: '/tmp/aila-large-tool-result.txt',
        relativePath: 'provider-large/large_tool.txt',
        sizeChars: input.content.length,
        preview: input.content.slice(0, input.previewChars),
      }
    },
  }

  const modelStreamClient: runtimePackageNodeSdk.ModelStreamClient = {
    async *stream(input) {
      modelRequests.push(structuredClone(input.messages))
      if (modelRequests.length === 1) {
        yield {
          type: 'tool-call',
          toolCallId: 'large_tool',
          toolName: 'contract_large',
          input: {},
        }
        yield { type: 'finish-step', usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } }
        return
      }

      const toolMessage = input.messages.find(
        (message) => message.role === 'tool' && message.tool_call_id === 'large_tool',
      )
      assert(toolMessage?.role === 'tool', 'large tool result should be appended as a tool message')
      assert(
        typeof toolMessage.content === 'string' &&
          toolMessage.content.includes('persisted="true"') &&
          toolMessage.content.includes('/tmp/aila-large-tool-result.txt') &&
          toolMessage.content.includes('Preview (4 of 26 chars):') &&
          toolMessage.content.includes('abcd') &&
          !toolMessage.content.includes(largeOutput),
        'large tool result should be replaced with persisted reference plus preview for the model',
      )
      yield { type: 'text-delta', text: 'used reference' }
      yield { type: 'finish-step', usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 } }
    },
  }

  const toolPack: ToolPack = {
    id: 'provider-large-tool-result-contract',
    name: 'Provider Large Tool Result Contract',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'contract_large',
            description: 'Return a large model loop output.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          metadata: {
            name: 'contract_large',
            readOnly: true,
            destructive: false,
            requiresApproval: false,
            access: ['read'],
            scope: ['workspace'],
          },
        },
        async run() {
          return largeOutput
        },
      },
    ],
  }

  const runAgent = runtimePackageNodeSdk.createDurableRunExecutor({
    modelStreamClient,
    toolResultStore,
    maxInlineToolResultChars: 10,
    toolResultPreviewChars: 4,
    settings: { apiKeys: { openrouter: 'contract-key' }, defaultModel: null },
  })

  await runAgent(
    {
      conversationId: 'provider-large-result-conversation',
      assistantMessageId: 'provider-large-result-assistant',
      messages: [{ role: 'user', content: 'large please' }],
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      signal: new AbortController().signal,
      toolRegistry: createDefaultToolRegistry([toolPack]),
    },
    {
      onTextDelta() {},
      onReasoningDelta() {},
      onToolCallStart() {},
      onToolCallArgsDelta() {},
      onToolCallResult(event) {
        toolResults.push(event.result)
      },
      onImageBlock() {},
      onDone(event) {
        doneMessages.push(event.message)
      },
      onError(event) {
        throw new Error(event.error)
      },
    },
  )

  assertEqual(storedInputs.length, 1, 'large tool result should be persisted once')
  assertEqual(storedInputs[0]?.content, largeOutput, 'tool store should receive the full output')
  assertEqual(storedInputs[0]?.previewChars, 4, 'tool store should receive preview budget')
  assertEqual(modelRequests.length, 2, 'large tool result flow should continue to the second step')
  assert(
    toolResults[0]?.includes('persisted="true"') === true,
    'streamed tool result should expose the persisted reference marker',
  )
  const completedMessage = doneMessages[0]
  assert(completedMessage, 'large tool result flow should produce a done message')
  const block = completedMessage.blocks.find(
    (candidate) => candidate.type === 'tool_call' && candidate.id === 'large_tool',
  )
  assert(block?.type === 'tool_call', 'large tool result should persist a tool call block')
  assertEqual(
    block.resultRef?.path,
    '/tmp/aila-large-tool-result.txt',
    'tool block should keep ref',
  )
  assert(
    block.result?.includes('persisted="true"') === true && !block.result.includes(largeOutput),
    'tool block result should keep the reference marker instead of the full output',
  )
}

async function testNodeToolResultStorePersistsAndCleansUpContract(): Promise<void> {
  await withTempDataDir(async (dir) => {
    const runtimeStore = runtimePackageNodeSdk.createFileRuntimeStore({ dataDir: dir })
    assert(runtimeStore.createConversation, 'file runtime store should support createConversation')
    const conversation = await runtimeStore.createConversation()
    const toolResultStore = runtimePackageNodeSdk.createNodeToolResultStore({ dataDir: dir })
    const ref = await toolResultStore.persist({
      conversationId: conversation.id,
      messageId: 'message-1',
      toolCallId: 'tool-call-1',
      toolName: 'contract_large',
      content: 'large-output-content',
      previewChars: 5,
    })

    assertEqual(
      await readFile(ref.path, 'utf-8'),
      'large-output-content',
      'store should write file',
    )
    assertEqual(ref.preview, 'large', 'store should return bounded preview')
    assert(
      ref.relativePath.includes(conversation.id),
      'store relative path should include the conversation directory',
    )
    assert(runtimeStore.deleteConversation, 'file runtime store should support deleteConversation')
    await runtimeStore.deleteConversation(conversation.id)

    try {
      await readFile(ref.path, 'utf-8')
      throw new Error('tool result file unexpectedly remained after conversation delete')
    } catch (error) {
      assert(
        error instanceof Error && 'code' in error && error.code === 'ENOENT',
        'conversation delete should remove persisted tool result files',
      )
    }
  })
}

function sse(items: unknown[]): string {
  return `${items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('')}data: [DONE]\n\n`
}

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function testToolActivityTargetContract(): void {
  assertEqual(
    summarizeToolTarget('read', { path: '/workspace/src/app.ts' })?.preview,
    '/workspace/src/app.ts',
    'read target path',
  )
  assertEqual(
    summarizeToolTarget('write', { path: '/workspace/src/app.ts', content: 'next' })?.kind,
    'file',
    'write target kind',
  )
  assertEqual(
    summarizeToolTarget('edit', { path: '/workspace/src/app.ts', oldText: 'a', newText: 'b' })
      ?.preview,
    '/workspace/src/app.ts',
    'edit target path',
  )
  assertEqual(
    summarizeToolTarget('bash', { command: 'bun run test' })?.preview,
    'bun run test',
    'bash target command',
  )
  assertEqual(
    summarizeToolTarget('web_search', { query: 'Aila runtime' })?.kind,
    'query',
    'web search target kind',
  )
  assertEqual(
    summarizeToolTarget('generate_image', { prompt: 'quiet desktop workbench' })?.kind,
    'prompt',
    'image target kind',
  )
  assertEqual(
    summarizeToolTarget('contract_echo', { value: 'hello' }),
    null,
    'unknown custom tool should not invent target metadata',
  )
}

async function testFilesystemToolWorkspaceRootsContract(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }
  const dir = join(tmpdir(), 'aila-tool-workspace-contract')
  const sourcePath = join(dir, 'source.md')
  const writePath = join(dir, 'created.md')
  const files = new Map<string, string>([[sourcePath, 'hello workspace roots']])
  const fileSystem: ToolFileSystem = {
    readTextFile: async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`missing test file: ${path}`)
      return content
    },
    writeTextFile: async (path, content) => {
      files.set(path, content)
    },
  }

  try {
    await executeTool(
      'read',
      { path: sourcePath },
      { settings, fileSystem, path: runtimePackageNodeSdk.nodePath },
    )
    throw new Error('read without workspace roots unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('no workspace roots configured'),
      'read without configured roots should be denied',
    )
  }

  try {
    await executeTool(
      'read',
      { path: sourcePath },
      { settings, workspaceRoots: [dir], path: runtimePackageNodeSdk.nodePath },
    )
    throw new Error('read without filesystem host unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('filesystem host is not available'),
      'read inside roots should fail closed without an injected filesystem host',
    )
  }

  const readResult = await executeTool(
    'read',
    { path: sourcePath },
    {
      settings,
      workspaceRoots: [{ path: dir, label: 'contract' }],
      fileSystem,
      path: runtimePackageNodeSdk.nodePath,
    },
  )
  assertEqual(readResult, 'hello workspace roots', 'read should allow configured workspace root')

  await executeTool(
    'write',
    { path: writePath, content: 'draft' },
    {
      settings,
      workspaceRoots: [dir],
      fileSystem,
      path: runtimePackageNodeSdk.nodePath,
      onToolApproval: async () => true,
    },
  )
  assertEqual(files.get(writePath), 'draft', 'write should target extra root')

  await executeTool(
    'edit',
    { path: writePath, oldText: 'draft', newText: 'final' },
    {
      settings,
      workspaceRoots: [dir],
      fileSystem,
      path: runtimePackageNodeSdk.nodePath,
      onToolApproval: async () => true,
    },
  )
  assertEqual(files.get(writePath), 'final', 'edit should target extra root')
}

async function testDefaultRuntimeHostOwnsFilesystemTools(): Promise<void> {
  await withTempDataDir(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aila-default-host-filesystem-'))
    try {
      const sourcePath = join(dir, 'source.md')
      const writePath = join(dir, 'created.md')
      await writeFile(sourcePath, 'default host filesystem', 'utf-8')

      const runtime = runtimeNodeSdk.createPersistedWorkbench({
        host: {
          workspaceRoots: () => [dir],
          onToolApproval: async () => true,
        },
      })

      assertEqual(
        await runtime.executeTool({ name: 'read', args: { path: sourcePath } }),
        'default host filesystem',
        'default host should read through its filesystem adapter',
      )
      await runtime.executeTool({ name: 'write', args: { path: writePath, content: 'draft' } })
      assertEqual(await readFile(writePath, 'utf-8'), 'draft', 'default host should write files')
      await runtime.executeTool({
        name: 'edit',
        args: { path: writePath, oldText: 'draft', newText: 'final' },
      })
      assertEqual(await readFile(writePath, 'utf-8'), 'final', 'default host should edit files')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

async function testBashToolShellCwdContract(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }
  const abortController = new AbortController()
  const dir = join(tmpdir(), 'aila-tool-shell-contract')
  const requestSeen: { current?: ToolShellRequest } = {}

  const result = await executeTool(
    'bash',
    { command: 'printf shell-cwd' },
    {
      settings,
      shellCwd: dir,
      path: runtimePackageNodeSdk.nodePath,
      signal: abortController.signal,
      onToolApproval: async () => true,
      runShell: async (request) => {
        requestSeen.current = { ...request }
        return { exitCode: 0, stdout: 'shell-cwd', stderr: '' }
      },
    },
  )

  const parsed = JSON.parse(result) as { exit_code?: unknown; stdout?: unknown; stderr?: unknown }
  assertEqual(parsed.exit_code, 0, 'bash shell cwd command should succeed')
  assertEqual(parsed.stdout, 'shell-cwd', 'bash tool should return injected shell stdout')
  assertEqual(parsed.stderr, '', 'bash tool should return injected shell stderr')

  const seenRequest = requestSeen.current
  assert(seenRequest, 'bash should call the injected shell host dependency')
  assertEqual(seenRequest.command, 'printf shell-cwd', 'bash shell request command')
  assertEqual(seenRequest.cwd, dir, 'bash shell request cwd')
  assertEqual(seenRequest.timeoutMs, 30_000, 'bash shell request timeout')
  assertEqual(seenRequest.maxBufferBytes, 128 * 1024, 'bash shell request max buffer')
  assertEqual(seenRequest.signal, abortController.signal, 'bash shell request abort signal')
}

async function testBashToolRequiresHostDependency(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }

  try {
    await executeTool(
      'bash',
      { command: 'printf should-not-run' },
      { settings, onToolApproval: async () => true },
    )
    throw new Error('bash unexpectedly succeeded without a host dependency')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('shell host is not available'),
      'bash should fail closed without an injected shell host dependency',
    )
  }
}

async function testRuntimeCoreHasNoDocToolContract(): Promise<void> {
  const registry = createDefaultToolRegistry()
  assert(!registry.specsByName.has('edit_doc'), 'runtime core must not register edit_doc')

  for (const spec of registry.specs) {
    assert(
      !(spec.metadata.access as readonly string[]).includes('doc'),
      `tool ${spec.metadata.name} must not use doc access`,
    )
    assert(
      !(spec.metadata.scope as readonly string[]).includes('current_doc'),
      `tool ${spec.metadata.name} must not use current_doc scope`,
    )
  }

  try {
    await executeTool('edit_doc', {}, { settings: { apiKeys: {}, defaultModel: null } }, registry)
    throw new Error('edit_doc unexpectedly executed')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('unknown tool'),
      'edit_doc should be unknown in runtime core',
    )
  }
}

async function testRuntimeSdkDoesNotExportDocsContract(): Promise<void> {
  const sdk = runtimeSdk as Record<string, unknown>
  for (const name of [
    'createDoc',
    'getDoc',
    'updateDoc',
    'deleteDoc',
    'listAll',
    'createFolder',
    'deleteFolder',
    'moveFolder',
    'renameFolder',
    'listDocConversations',
    'rewriteDocRefs',
  ]) {
    assert(!(name in sdk), `runtime SDK must not export Desktop docs API: ${name}`)
  }

  for (const name of [
    'appendRunEvent',
    'appendRunEventAndTouchConversation',
    'appendMessage',
    'createConversation',
    'deleteConversation',
    'getConversation',
    'listRunEvents',
    'listConversations',
    'recoverInterruptedConversationActivities',
    'recoverInterruptedConversationActivityResults',
    'renameConversation',
    'setConversationUsage',
    'upsertMessage',
  ]) {
    assert(!(name in sdk), `runtime SDK must not export raw persistence helper: ${name}`)
  }
  for (const name of [
    'BUILTIN_TOOL_PACKS',
    'TOOL_DEFINITIONS',
    'TOOL_SPECS',
    'applyFindReplace',
    'createDefaultToolRegistry',
    'createToolRegistry',
    'evaluateToolPolicy',
    'executeTool',
    'formatFindReplaceErrors',
    'getToolDefinitions',
    'summarizeToolTarget',
  ]) {
    assert(!(name in sdk), `runtime SDK must not export internal helper: ${name}`)
  }

  assertEqual(
    typeof runtimeNodeSdk.createPersistedRuntimeStore,
    'function',
    'runtime SDK should expose the persisted store adapter factory',
  )
  assertEqual(
    typeof runtimeNodeSdk.createDefaultRuntimeHost,
    'function',
    'runtime SDK should expose the default runtime host factory',
  )
  assertEqual(
    typeof runtimeNodeSdk.createPersistedWorkbench,
    'function',
    'runtime SDK should expose the persisted WorkbenchRuntime factory',
  )
  const store = runtimeNodeSdk.createPersistedRuntimeStore()
  assertEqual(typeof store.getConversation, 'function', 'persisted store should read records')
  assertEqual(
    typeof store.appendSessionEntry,
    'function',
    'persisted store should append session journal entries',
  )
  assert(
    !('saveMessage' in store) && !('recordRunEvent' in store) && !('recordUsage' in store),
    'persisted store should not expose split legacy write repositories',
  )
  assertEqual(
    typeof store.listSessionEntries,
    'function',
    'persisted store should replay session journal entries',
  )
  assertEqual(typeof store.saveRunSnapshot, 'function', 'persisted store should save run snapshots')
  assertEqual(typeof store.getRunSnapshot, 'function', 'persisted store should load run snapshots')
  assertEqual(typeof store.putBlob, 'function', 'persisted store should write immutable blobs')
  assertEqual(typeof store.getBlob, 'function', 'persisted store should read immutable blobs')
  assert(
    !('upsertMessage' in store) &&
      !('appendRunEventAndTouchConversation' in store) &&
      !('setConversationUsage' in store),
    'persisted store should not expose raw persistence helper names',
  )
  assert(
    !('recoverInterruptedConversationActivities' in store),
    'persisted runtime store adapter should not expose raw persisted recovery helper names',
  )

  assertEqual(
    typeof runtimeSdk.createInMemoryRuntimeStore,
    'function',
    'runtime SDK should expose the in-memory store factory',
  )
  const memoryStore = runtimeSdk.createInMemoryRuntimeStore()
  const memoryConversation = await memoryStore.createConversation?.()
  assert(memoryConversation, 'in-memory store should create conversations')
  assertEqual(
    (await memoryStore.getConversation(memoryConversation.id)).meta.id,
    memoryConversation.id,
    'in-memory store should keep records without a host adapter',
  )

  const coreSdk = runtimeCoreSdk as Record<string, unknown>
  for (const name of [
    'configureDataDir',
    'getDataDir',
    'getImagesDir',
    'getSettingsPath',
    'loadSettings',
    'saveSettings',
    'configuredProviders',
    'createPersistedRuntimeStore',
    'createDefaultRuntimeHost',
    'createPersistedWorkbench',
    'loadSkillsFromDir',
    'getExtensionReport',
    'getModelInfo',
  ]) {
    assert(!(name in coreSdk), `runtime core SDK must not export node adapter API: ${name}`)
  }
  assertEqual(typeof coreSdk.WorkbenchRuntime, 'function', 'runtime core SDK should export runtime')
  assertEqual(
    typeof coreSdk.createInMemoryRuntimeStore,
    'function',
    'runtime core SDK should export in-memory store',
  )
  for (const name of [
    'BUILTIN_TOOL_PACKS',
    'TOOL_DEFINITIONS',
    'TOOL_SPECS',
    'applyFindReplace',
    'createDefaultToolRegistry',
    'createToolRegistry',
    'evaluateToolPolicy',
    'executeTool',
    'formatFindReplaceErrors',
    'getToolDefinitions',
    'summarizeToolTarget',
  ]) {
    assert(!(name in coreSdk), `runtime core SDK must not export internal helper: ${name}`)
  }
  const internalSdk = runtimeInternalSdk as Record<string, unknown>
  for (const name of [
    'applyFindReplace',
    'createDefaultToolRegistry',
    'createToolRegistry',
    'evaluateToolPolicy',
    'executeTool',
    'formatFindReplaceErrors',
    'getToolDefinitions',
    'summarizeToolTarget',
  ]) {
    assert(name in internalSdk, `runtime internal SDK should export helper: ${name}`)
  }
  assertEqual(
    typeof coreSdk.requestToolApprovalWithActivity,
    'function',
    'runtime core SDK should export host-agnostic approval activity helper',
  )
  assertEqual(
    typeof coreSdk.ToolApprovalStore,
    'function',
    'runtime core SDK should export the host-agnostic approval store',
  )
  assertEqual(
    typeof coreSdk.createToolPolicy,
    'function',
    'runtime core SDK should export tool approval mode policy helper',
  )
  const writePolicyRequest = {
    name: 'write',
    args: { path: '/workspace/file.txt' },
    metadata: {
      name: 'write',
      readOnly: false,
      destructive: true,
      requiresApproval: true,
      access: ['write'],
      scope: ['workspace'],
    },
  } satisfies runtimeSdk.ToolPolicyRequest
  assertEqual(
    (await runtimeSdk.createToolPolicy('safe')(writePolicyRequest))?.action,
    'ask',
    'safe tool policy should ask before destructive writes',
  )
  assertEqual(
    (await runtimeSdk.createToolPolicy('yolo')(writePolicyRequest))?.action,
    'allow',
    'yolo tool policy should allow destructive writes without approval',
  )
  const runtimeCoreSurfaceSource = await readFile(
    join(process.cwd(), 'scripts/runtime-core-surface-contract.ts'),
    'utf-8',
  )
  for (const name of [
    'Workbench',
    'WorkbenchHost',
    'WorkbenchStore',
    'AgentContextPlan',
    'AgentContextPlanSection',
    'AgentContextBudgetPlan',
    'AgentContextCompactionPlan',
    'AgentContextMicrocompactPlan',
    'AgentContextRecommendedCheckpoint',
    'AgentContextTokenLedger',
    'AgentContextTokenLedgerEntry',
    'AgentContextTokenPreflight',
    'ContextBudgetManagerInput',
    'ContextBudgetSnapshot',
    'ContextTokenEstimate',
    'ContextTokenEstimateMethod',
    'ContextTokenEstimatorSnapshot',
    'AgentContextSectionCachePolicy',
    'AgentContextSectionMetadata',
    'AgentContextSectionSource',
    'DurableRunExecutor',
    'RuntimeModelInfoResolver',
    'RuntimeStableInstructionsInput',
    'Settings',
    'ToolPack',
    'ToolApprovalMode',
    'ToolApprovalRequest',
    'ToolApprovalRequestPayload',
    'ConversationRecord',
    'ConversationSummary',
    'ConversationUsage',
    'ConversationCompactArtifact',
    'ConversationCompactFileArtifact',
    'ConversationCompactToolActivity',
    'ConversationCompactToolResultArtifact',
    'ConversationContextCheckpoint',
    'ConversationContextLedgerSection',
    'ConversationContextState',
    'ConversationContextTokenPreflight',
    'ConversationContextTurnLedgerEntry',
    'PersistedToolResultRef',
    'RuntimeCompactConversationInput',
    'RuntimeCompactConversationResult',
    'RuntimeContextCompactArtifactInput',
    'RuntimeContextCompactArtifactResult',
    'RuntimeContextTokenCountInput',
    'RuntimeContextTokenCountResult',
    'RunEvent',
    'WorkbenchEvent',
  ]) {
    assert(
      runtimeCoreSurfaceSource.includes(`type ${name}`) &&
        runtimeCoreSurfaceSource.includes("from '@aila/agent'"),
      `runtime core SDK should export public type: ${name}`,
    )
  }

  const nodeSdk = runtimeNodeSdk as Record<string, unknown>
  for (const name of [
    'configureDataDir',
    'getDataDir',
    'loadSettings',
    'createPersistedRuntimeStore',
    'createDefaultRuntimeHost',
    'createPersistedWorkbench',
    'loadSkillsFromDir',
    'getExtensionReport',
  ]) {
    assert(name in nodeSdk, `runtime node SDK should export node adapter API: ${name}`)
  }
  for (const name of ['getToolPacksDir', 'loadToolPacksFromDir']) {
    assert(!(name in nodeSdk), `runtime node SDK must not export local tool pack API: ${name}`)
  }

  const packageNodeSdk = runtimePackageNodeSdk as Record<string, unknown>
  for (const name of [
    'createDefaultNodeRuntimeHost',
    'createNodeWorkbench',
    'createDurableRunExecutor',
    'createNodeContextTokenCounter',
    'createNodeSemanticCompactGenerator',
    'createModelRegistry',
    'createProtocolRegistry',
    'createFileRuntimeStore',
    'createNodeToolResultStore',
    'getNodeToolResultsDir',
    'loadNodeSettings',
    'createDefaultWebSearch',
    'createWebSearchRegistry',
    'WebSearchRegistry',
    'registerBuiltInWebSearchProviders',
  ]) {
    assert(name in packageNodeSdk, `@aila/agent-node should export node adapter API: ${name}`)
  }
}

async function testRuntimeCoreHostBoundarySourceContract(): Promise<void> {
  const [runtimeSource, toolsSource, coreSource, hostEntrySource, nodeHostSource, appHostSource] =
    await Promise.all([
      readFile(join(process.cwd(), 'packages/agent/src/runtime.ts'), 'utf-8'),
      readFile(join(process.cwd(), 'packages/agent/src/tools.ts'), 'utf-8'),
      readFile(join(process.cwd(), 'packages/agent/src/core.ts'), 'utf-8'),
      readFile(join(process.cwd(), 'packages/agent/src/host.ts'), 'utf-8'),
      readFile(join(process.cwd(), 'packages/agent-node/src/node/runtime-host.ts'), 'utf-8'),
      readFile(join(process.cwd(), 'packages/agent-node/src/app/runtime-host.ts'), 'utf-8'),
    ])

  assert(
    !runtimeSource.includes("from 'node:") &&
      !toolsSource.includes("from 'node:") &&
      runtimeSource.includes("path?: ToolContext['path']") &&
      runtimeSource.includes('path: this.host.path'),
    'agent core should stay Node-free and receive path behavior through its host boundary',
  )
  assert(
    toolsSource.includes('export interface ToolPath') &&
      toolsSource.includes('path host is not available') &&
      toolsSource.includes('new TextEncoder()') &&
      !toolsSource.includes('Buffer.'),
    'tool core should use host path semantics and platform-neutral byte encoding',
  )
  for (const helper of [
    'createToolRegistry',
    'executeTool',
    'getToolDefinitions',
    'summarizeToolTarget',
  ]) {
    assert(
      hostEntrySource.includes(helper),
      `@aila/agent/host should expose host integration helper: ${helper}`,
    )
    assert(
      !coreSource.includes(`  ${helper},`),
      `@aila/agent main entry should not expose host integration helper: ${helper}`,
    )
  }

  assert(
    nodeHostSource.includes("from './path'") &&
      nodeHostSource.includes('path: nodePath') &&
      appHostSource.includes("from '../node/runtime-host'"),
    '@aila/agent-node should own Node path/runtime composition without importing through itself',
  )

  const packageNodeSource = await readFile(
    join(process.cwd(), 'packages/agent-node/src/index.ts'),
    'utf-8',
  )
  assert(
    packageNodeSource.includes("from './node/runtime-host'") &&
      packageNodeSource.includes("from './node/path'"),
    '@aila/agent-node should expose the Node runtime host and path adapter',
  )

  const mainSource = await readFile(join(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf-8')
  assert(
    mainSource.includes("from '@aila/agent-node/app'") &&
      !mainSource.includes('packages/agent-node/src'),
    'Desktop should consume the agent Node app host through its workspace export',
  )

  const rootPackage = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>
    workspaces?: string[]
  }
  assertEqual(
    JSON.stringify(rootPackage.workspaces),
    JSON.stringify(['apps/*', 'packages/*']),
    'root package should orchestrate apps and packages workspaces',
  )
  assert(!rootPackage.dependencies, 'root package should not own application runtime dependencies')

  const packageConsumerSource = await readFile(
    join(process.cwd(), 'scripts/runtime-package-consumer-contract.ts'),
    'utf-8',
  )
  assert(
    packageConsumerSource.includes("from '@aila/agent/host'") &&
      packageConsumerSource.includes("from '@aila/agent-node'"),
    'package consumer contract should compile the core host and Node entrypoints',
  )

  const rootEntries = await readdir(process.cwd())
  assert(!rootEntries.includes('src'), 'application source should live under apps/*, not root src')
}

async function testPersistedWorkbenchFactoryContract(): Promise<void> {
  await withTempDataDir(async () => {
    const emitted: WorkbenchEvent[] = []
    const runtime = runtimeNodeSdk.createPersistedWorkbench({
      host: {
        onEvent: (event) => emitted.push(event),
      },
    })

    const conversation = await runtime.createConversation()
    const record = await runtime.getConversation(conversation.id)
    assertEqual(
      record.meta.id,
      conversation.id,
      'persisted runtime factory should use persisted store by default',
    )
    assert(
      emitted.some(
        (event) => event.type === 'conversations:updated' && event.data.id === conversation.id,
      ),
      'persisted runtime factory should preserve host event overrides',
    )
  })
}

async function testPersistedRuntimeFactoryPersistsImageAttachmentsThroughDefaultHost(): Promise<void> {
  await withTempDataDir(async () => {
    const runtime = runtimeNodeSdk.createPersistedWorkbench({
      host: {
        runAgent: async (req, handlers) => {
          await handlers.onDone({
            conversationId: req.conversationId,
            messageId: req.assistantMessageId,
            message: {
              schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
              id: req.assistantMessageId,
              role: 'assistant',
              blocks: [{ type: 'text', content: 'default host image attachment done' }],
              status: 'done',
              model: req.selection,
            },
          })
        },
      },
    })
    const conversation = await runtime.createConversation()

    await runtime.send({
      conversationId: conversation.id,
      userText: 'default host should persist image attachments',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      attachments: [
        {
          kind: 'image',
          name: 'default-host.png',
          mime: 'image/png',
          data: Buffer.from('default-host-image').toString('base64'),
        },
      ],
    })
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'default host image attachment stream should settle',
    )

    const record = await runtime.getConversation(conversation.id)
    const imageBlock = record.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'image')
    assert(imageBlock, 'default host should persist an image block')
    assert(
      imageBlock.type === 'image' && imageBlock.url.startsWith('aila-image://i/'),
      'default host image block should use the Desktop image protocol',
    )
    const imageFiles = await readdir(getImagesDir())
    assertEqual(imageFiles.length, 1, 'default host should write one image asset')
  })
}

async function testExtensionReportContract(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const legacyToolPackDir = join(dataDir, 'tool-packs', 'legacy')
    await mkdir(legacyToolPackDir, { recursive: true })
    await writeFile(
      join(legacyToolPackDir, 'aila-tool-pack.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'legacy',
        name: 'Legacy',
        entry: 'index.mjs',
      })}\n`,
      'utf-8',
    )
    await writeFile(
      join(legacyToolPackDir, 'index.mjs'),
      "throw new Error('legacy tool pack must not be loaded')\n",
      'utf-8',
    )

    const report = await getExtensionReport()
    assertEqual(report.ok, true, 'extension report should be ok')
    assertEqual(report.dataDir, dataDir, 'extension report data dir')
    assert(!('toolPacks' in report), 'extension report must not expose local tool packs')
    assert(!('toolPacksDir' in report), 'extension report must not expose a tool packs directory')
    assertEqual(report.errors.length, 0, 'extension report should not include errors')
  })
}

function skillDocument(name: string, description: string, body = 'Do the thing.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

async function writeSkill(skillsDir: string, dirName: string, contents: string): Promise<string> {
  const directory = join(skillsDir, dirName)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, AILA_SKILL_FILE), contents, 'utf-8')
  return directory
}

function testSkillDocumentParsingContract(): void {
  const parsed = parseSkillDocument(
    `---
name: pdf-processing
description: Extract text and tables from PDF files.
license: MIT
compatibility: Requires Python 3.
metadata:
  category: documents
allowed-tools: read, bash
---

# Steps

Use pdfplumber.
`,
  )
  assertEqual(parsed.definition.name, 'pdf-processing', 'skill name parsed')
  assertEqual(
    parsed.definition.description,
    'Extract text and tables from PDF files.',
    'skill description parsed',
  )
  assertEqual(parsed.definition.license, 'MIT', 'skill license parsed')
  assertEqual(parsed.definition.compatibility, 'Requires Python 3.', 'skill compatibility parsed')
  assertEqual(parsed.definition.metadata?.category, 'documents', 'skill metadata parsed')
  assert(
    parsed.definition.allowedTools?.includes('read') &&
      parsed.definition.allowedTools?.includes('bash'),
    'skill allowed-tools parsed from comma list',
  )
  assert(parsed.body.includes('Use pdfplumber.'), 'skill body excludes frontmatter')

  const expectFailure = (raw: string, label: string) => {
    let threw = false
    try {
      parseSkillDocument(raw)
    } catch {
      threw = true
    }
    assert(threw, label)
  }

  expectFailure('no frontmatter here', 'skill without frontmatter is rejected')
  expectFailure('---\nname: only-name\n---\n\nbody\n', 'skill without description is rejected')
  expectFailure(
    '---\nname: Bad_Name\ndescription: x\n---\n\nbody\n',
    'skill with invalid name characters is rejected',
  )
  expectFailure(
    `---\nname: empty-body\ndescription: ${'a'.repeat(2000)}\n---\n\nbody\n`,
    'skill with over-long description is rejected',
  )
  expectFailure(
    '---\nname: empty-body\ndescription: valid\n---\n\n   \n',
    'skill without body instructions is rejected',
  )
}

async function testSkillLoaderGracefulErrorsContract(): Promise<void> {
  await withTempDataDir(async () => {
    const skillsDir = getSkillsDir()
    await writeSkill(skillsDir, 'good-skill', skillDocument('good-skill', 'A working skill.'))
    // name must match directory name.
    await writeSkill(skillsDir, 'mismatch', skillDocument('other-name', 'Mismatched name.'))
    // Stray non-directory entry must be ignored, not fail the whole load.
    await writeFile(join(skillsDir, 'README.txt'), 'not a skill', 'utf-8')

    const result = await loadSkillsFromDir(skillsDir)
    assertEqual(result.skills.length, 1, 'loader returns only valid skills')
    assertEqual(result.skills[0]?.definition.name, 'good-skill', 'loader keeps valid skill')
    assertEqual(result.errors.length, 1, 'loader collects per-skill errors')
    assert(
      result.errors[0]?.message.includes('must match its directory name'),
      'loader reports name/directory mismatch',
    )

    const single = await loadSkillFromDir(join(skillsDir, 'good-skill'))
    assertEqual(single.definition.name, 'good-skill', 'loadSkillFromDir returns the skill')
  })
}

async function testSkillToolProgressiveDisclosureContract(): Promise<void> {
  await withTempDataDir(async () => {
    const skillsDir = getSkillsDir()
    await writeSkill(
      skillsDir,
      'brand-voice',
      skillDocument('brand-voice', 'Apply the company brand voice to copy.', 'Write warmly.'),
    )
    const referencePath = join(skillsDir, 'brand-voice', 'references', 'tone.md')
    await mkdir(join(skillsDir, 'brand-voice', 'references'), { recursive: true })
    await writeFile(referencePath, '# Tone\nFriendly.\n', 'utf-8')

    const runtime = new WorkbenchRuntime({
      loadSkills: async () => (await loadSkillsFromDir()).skills,
      fileSystem: {
        readTextFile: (path) => readFile(path, 'utf-8'),
        writeTextFile: (path, content) => writeFile(path, content, 'utf-8'),
      },
      path: runtimePackageNodeSdk.nodePath,
      logger: { warn() {}, error() {} },
    })

    const registry = await runtime.getToolRegistry()
    const skillSpec = registry.specsByName.get(SKILL_TOOL_NAME)
    assert(skillSpec, 'runtime registers the skill tool when skills exist')
    // Level 1 disclosure: name + description embedded in the tool description.
    assert(
      skillSpec?.function.description.includes('brand-voice') &&
        skillSpec?.function.description.includes('Apply the company brand voice'),
      'skill tool description embeds skill name and description',
    )
    const skillParams = skillSpec?.function.parameters as {
      properties?: { name?: { enum?: string[] } }
    }
    assert(
      skillParams.properties?.name?.enum?.includes('brand-voice'),
      'skill tool constrains name to known skills',
    )

    const context = { settings: { apiKeys: {}, defaultModel: null } satisfies Settings }
    const output = await executeTool(SKILL_TOOL_NAME, { name: 'brand-voice' }, context, registry)
    // Level 2 disclosure: SKILL.md body returned on invocation.
    assert(output.includes('Write warmly.'), 'skill invocation returns the SKILL.md body')
    // Level 3 disclosure: bundled files listed for on-demand reading.
    assert(output.includes(referencePath), 'skill invocation lists bundled files')

    let unknownThrew = false
    try {
      await executeTool(SKILL_TOOL_NAME, { name: 'missing' }, context, registry)
    } catch {
      unknownThrew = true
    }
    assert(unknownThrew, 'skill invocation rejects unknown skill names')
  })
}

async function testSkillBundledFilesAreReadableContract(): Promise<void> {
  await withTempDataDir(async () => {
    const skillsDir = getSkillsDir()
    await writeSkill(
      skillsDir,
      'data-helper',
      skillDocument('data-helper', 'Helps with data.', 'See scripts/run.py.'),
    )
    const scriptPath = join(skillsDir, 'data-helper', 'scripts', 'run.py')
    await mkdir(join(skillsDir, 'data-helper', 'scripts'), { recursive: true })
    await writeFile(scriptPath, 'print("hi")\n', 'utf-8')

    const runtime = new WorkbenchRuntime({
      loadSkills: async () => (await loadSkillsFromDir()).skills,
      fileSystem: {
        readTextFile: (path) => readFile(path, 'utf-8'),
        writeTextFile: (path, content) => writeFile(path, content, 'utf-8'),
      },
      path: runtimePackageNodeSdk.nodePath,
      logger: { warn() {}, error() {} },
    })

    // The skill directory is added as a workspace root, so the read tool can
    // open bundled files even though they live under the data dir.
    const readOutput = await runtime.executeTool({ name: 'read', args: { path: scriptPath } })
    assert(readOutput.includes('print("hi")'), 'read tool can open bundled skill files')
  })
}

async function testSkillReloadPicksUpNewSkillsContract(): Promise<void> {
  await withTempDataDir(async () => {
    const skillsDir = getSkillsDir()
    await writeSkill(skillsDir, 'first', skillDocument('first', 'The first skill.'))

    const runtime = new WorkbenchRuntime({
      loadSkills: async () => (await loadSkillsFromDir()).skills,
      logger: { warn() {}, error() {} },
    })

    let registry = await runtime.getToolRegistry()
    let params = registry.specsByName.get(SKILL_TOOL_NAME)?.function.parameters as {
      properties?: { name?: { enum?: string[] } }
    }
    assert(params.properties?.name?.enum?.includes('first'), 'initial skill is registered')
    assert(!params.properties?.name?.enum?.includes('second'), 'second skill not yet present')

    await writeSkill(skillsDir, 'second', skillDocument('second', 'The second skill.'))
    registry = await runtime.reloadToolPacks()
    params = registry.specsByName.get(SKILL_TOOL_NAME)?.function.parameters as {
      properties?: { name?: { enum?: string[] } }
    }
    assert(
      params.properties?.name?.enum?.includes('first') &&
        params.properties?.name?.enum?.includes('second'),
      'reload picks up newly added skills',
    )
  })
}

async function testPersistedRuntimeLoadsSkillsContract(): Promise<void> {
  await withTempDataDir(async () => {
    await writeSkill(
      getSkillsDir(),
      'factory-skill',
      skillDocument('factory-skill', 'Loaded through the default host.'),
    )
    const runtime = runtimeNodeSdk.createPersistedWorkbench()
    const registry = await runtime.getToolRegistry()
    assert(
      registry.specsByName.has(SKILL_TOOL_NAME),
      'persisted runtime factory loads skills through the default host',
    )
    const skills = await runtime.getSkills()
    assertEqual(
      skills[0]?.definition.name,
      'factory-skill',
      'default host loads skills from dataDir',
    )
  })
}

async function testSkillExtensionReportContract(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const skillsDir = getSkillsDir()
    await writeSkill(skillsDir, 'reportable', skillDocument('reportable', 'Shows up in reports.'))
    await writeSkill(skillsDir, 'broken', skillDocument('different', 'Name mismatch error.'))

    const report = await getExtensionReport()
    assertEqual(report.skillsDir, skillsDir, 'extension report exposes skills dir')
    assert(
      report.skills.some((skill) => skill.name === 'reportable'),
      'extension report lists loaded skills',
    )
    const skillError = report.errors.find((error) => error.kind === 'skills')
    assert(skillError, 'extension report surfaces skill load errors')
    assertEqual(report.ok, false, 'extension report is not ok when a skill fails to load')
    assertEqual(report.dataDir, dataDir, 'extension report data dir')
  })
}

async function main(): Promise<void> {
  await testRunMachineStepModePausesBeforeToolStep()
  await testRunCursorResumesOneActionAtATime()
  await testRunCheckpointAndArtifactStoreContract()
  await testRuntimeRunInspectionForkAndAbortContract()
  testRunCheckpointRecoverySafetyContract()
  testRunCheckpointV1MigrationContract()
  await testProviderModelCallExecutesExactlyOneRequest()
  await testProviderStreamStepCheckpointResumeContract()
  await testProviderStreamPreflightFailureCheckpointContract()
  await testSettingsInfersOpenRouterVisionDefault()
  await testRuntimeEventContract()
  await testRuntimeEmitsVersionedEvents()
  await testRuntimeWithoutStreamHostFailsAtSetupBoundary()
  await testRuntimeHostBoundaryContract()
  await testRuntimeSettingsFallbackIsHostAgnostic()
  await testRuntimeStreamAndModelInfoUseHostBoundary()
  await testRuntimeAttachmentPersistenceUsesHostBoundary()
  await testRuntimeTextAttachmentFallbackIsHostAgnostic()
  await testRuntimeImageAttachmentRequiresHostBoundary()
  await testRuntimeRejectsInvalidHostAttachmentBlocks()
  await testRuntimeHostStaticExtensionContract()
  await testRuntimeDynamicExtensionLoaderSnapshots()
  await testRuntimeInjectableStoreContract()
  await testConversationUsageAccumulatorContract()
  await testFileRunPersistenceSurvivesRestart()
  await testDesktopRunPersistenceSurvivesRestart()
  await testRuntimeHostTransientContextUsesInjectedRecord()
  await testRuntimeHostStableInstructionsUsesInjectedRecord()
  testContextAssemblerSectionsContract()
  await testRuntimePersistsAutoContextCheckpoint()
  await testRuntimeManualCompactConversation()
  await testRuntimeStreamHandlerSnapshots()
  await testRuntimeConversationStoreFacadeContract()
  await testRuntimeConversationRuntimeStateApiUsesEventReplay()
  await testRuntimeOptionalStoreCapabilitiesFailClosed()
  await testInMemoryRuntimeStoreEventListContract()
  await testRuntimeEnvironmentContract()
  await testRuntimeAppendUserMessageUsesInjectedStore()
  await testRuntimeRecordRunEventUsesInjectedStore()
  await testRuntimeRecoveryDelegatesToInjectedStore()
  await testRuntimeRecoveryUsesInjectedStoreReplay()
  await testRuntimeDeleteAssetCleanupHostBoundary()
  await testRuntimeRetriesDanglingUserTurn()
  await testRuntimeRetriesFailedAssistantTurn()
  await testRuntimeContextSkipsNonDoneAssistantHistory()
  await testRuntimeSerializesConcurrentTurnStarts()
  await testRuntimeAbortCancelsTurnSetupBeforeStreamStarts()
  await testRuntimeSendRecoversTimedOutTurnSetupLock()
  await testRuntimeAbortPersistsCancellationActivity()
  await testRuntimeAbortTimesOutStuckStreamCleanup()
  await testRuntimeRepeatedAbortWaitsForSameCleanup()
  await testRuntimeUnexpectedStreamErrorPersistsFailureActivity()
  await testRuntimeSetupFailurePersistsAssistantError()
  await testRuntimeSetupFailureRejectsWhenConversationDeleted()
  await testRuntimeSetupFailureSuppressesChatErrorAfterDelete()
  await testRuntimeListsActiveAssistantTurns()
  await testRuntimeDeleteRunsAbortCleanupBeforeWaitingForStream()
  await testRuntimeDeleteTimesOutStuckStreamAndSuppressesLateEvents()
  await testRuntimeRejectsNewTurnsAfterDeleteStarts()
  await testRuntimeDeleteFailureReopensConversation()
  await testRuntimeDeleteFailureRecordsCancellationForReopenedTurn()
  await testRuntimeSendRecoversAbortedStuckPreviousStream()
  await testRuntimeAbortAllWaitsForShutdownCleanup()
  await testRuntimeAbortAllTimesOutStuckStreamCleanup()
  await testRuntimeShutdownRejectsNewTurns()
  await testPersistenceContract()
  await testMessageUpsertPreventsDuplicatePersistedMessages()
  await testRunEventReplayDeduplicatesExactDuplicates()
  await testRunEventReplayPreservesAppendOrderForSameTimestamp()
  testRunEventReplayDerivesLatestActivity()
  testRunEventReplayDerivesRuntimeState()
  testRunEventReplayKeepsToolFailureActive()
  testInterruptedRecoveryEventHelper()
  await testInterruptedRecoveryUsesEventReplayOverStaleMeta()
  await testInterruptedRecoveryUsesRuntimeReplayForNonTerminalToolFailure()
  await testImmediateToolApprovalActivityHelper()
  await testExecutionModeToolPolicyContract()
  await testToolRegistryContract()
  await testRuntimeExecuteToolUsesHostBoundary()
  await testGenerateImageToolUsesInjectedImageDependencies()
  await testGenerateImageToolRequiresHostImageDependencies()
  await testWebSearchToolUsesInjectedHostDependency()
  await testWebSearchToolRequiresHostDependency()
  await testNodeWebSearchRegistryFallbacksAndMerge()
  await testNodeContextTokenCounterContract()
  await testNodeSemanticCompactGeneratorContract()
  await testNativeOpenAiChatModelStreamContract()
  await testNativeOpenAiChatRequiredImageContract()
  await testNativeDeepSeekProviderContract()
  testOpenRouterVisionModelCatalogContract()
  await testNativeAnthropicModelStreamContract()
  await testNativeGoogleModelStreamContract()
  await testProviderStreamChatOwnsToolLoopContract()
  await testProviderToolApprovalPausesBeforeSideEffectContract()
  await testProviderStreamChatVisionFallbackContract()
  await testProviderStreamChatVisionFallbackUsesLatestImageContract()
  await testProviderStreamChatVisionFallbackCachesAnalysisContract()
  await testProviderStreamChatVisionPassThroughContract()
  await testProviderStreamChatVisionFallbackDisabledContract()
  await testProviderStreamChatVisionFallbackMissingConfigContract()
  await testProviderStreamChatPersistsLargeToolResultsContract()
  await testNodeToolResultStorePersistsAndCleansUpContract()
  testToolActivityTargetContract()
  await testFilesystemToolWorkspaceRootsContract()
  await testDefaultRuntimeHostOwnsFilesystemTools()
  await testBashToolShellCwdContract()
  await testBashToolRequiresHostDependency()
  await testRuntimeCoreHasNoDocToolContract()
  await testRuntimeSdkDoesNotExportDocsContract()
  await testRuntimeCoreHostBoundarySourceContract()
  await testPersistedWorkbenchFactoryContract()
  await testPersistedRuntimeFactoryPersistsImageAttachmentsThroughDefaultHost()
  await testExtensionReportContract()
  testSkillDocumentParsingContract()
  await testSkillLoaderGracefulErrorsContract()
  await testSkillToolProgressiveDisclosureContract()
  await testSkillBundledFilesAreReadableContract()
  await testSkillReloadPicksUpNewSkillsContract()
  await testPersistedRuntimeLoadsSkillsContract()
  await testSkillExtensionReportContract()
  console.log('runtime contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
