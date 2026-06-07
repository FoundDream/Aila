import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  appendAgentEvent,
  appendAgentEventAndTouchConversation,
  appendMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listAgentEvents,
  listChatConversations,
  listDocConversations,
  recoverInterruptedConversationActivities,
} from '../src/main/conversations'
import { createDoc, getDocFilePath, updateDoc } from '../src/main/docs'
import { configureDataDir, getDocumentsDir } from '../src/main/paths'
import {
  type ToolApprovalRequestPayload,
  type ToolApprovalResolvedPayload,
  ToolApprovalStore,
} from '../src/main/tool-approvals'
import {
  buildDesktopWorkspaceContext,
  getDesktopWorkspaceRoots,
} from '../src/main/workspace-context'
import {
  createChatStreamsStateForTest,
  reduceChatStreamsForTest,
} from '../src/renderer/src/pages/chat/useChatStreams'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

async function withTempDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'aila-desktop-workbench-'))
  try {
    configureDataDir(dir)
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

async function testDocConversationWorkspaceContext(): Promise<void> {
  await withTempDataDir(async () => {
    const created = await createDoc(null)
    const doc = await updateDoc(created.path, {
      title: 'Workbench Contract',
      content: 'This note lives in Desktop documents and is edited through file tools.',
    })
    const conversation = await createConversation(doc.path)

    const context = await buildDesktopWorkspaceContext(conversation.id)
    assertEqual(context.length, 1, 'doc-bound conversation should get one context message')
    assertEqual(context[0]?.role, 'system', 'context should be a system message')

    const content = context[0]?.content ?? ''
    assert(content.includes('Desktop workspace context:'), 'context should identify Desktop scope')
    assert(
      content.includes('Active document title: Workbench Contract'),
      'context should include title',
    )
    assert(content.includes(`Vault path: ${doc.path}`), 'context should include vault path')
    assert(content.includes(getDocFilePath(doc.path)), 'context should include absolute file path')
    assert(
      content.includes('This note lives in Desktop documents'),
      'context should include document preview',
    )
    assert(!content.includes('edit_doc'), 'Desktop context must not revive doc-specific tools')
  })
}

async function testDesktopWorkspaceRoots(): Promise<void> {
  await withTempDataDir(async () => {
    const roots = getDesktopWorkspaceRoots()
    assert(roots && roots.length === 1, 'Desktop should expose documents as an extra root')
    const root = roots[0]
    assert(typeof root !== 'string', 'Desktop workspace root should keep a label')
    assertEqual(root.path, getDocumentsDir(), 'Desktop documents root path')
  })
}

async function testConversationPartitionContract(): Promise<void> {
  await withTempDataDir(async () => {
    const chat = await createConversation()
    const created = await createDoc(null)
    const doc = await updateDoc(created.path, { title: 'Partitioned Doc' })
    const docConversation = await createConversation(doc.path)

    const chatList = await listChatConversations()
    assert(
      chatList.some((conversation) => conversation.id === chat.id),
      'chat list should include chat conversations',
    )
    assert(
      !chatList.some((conversation) => conversation.id === docConversation.id),
      'chat list must not include doc-owned conversations',
    )

    const docList = await listDocConversations(doc.path)
    assertEqual(docList.length, 1, 'doc list should include doc-owned conversation')
    assertEqual(docList[0]?.id, docConversation.id, 'doc-owned conversation id')
  })
}

async function testDocConversationFollowsDocRename(): Promise<void> {
  await withTempDataDir(async () => {
    const created = await createDoc(null)
    const doc = await updateDoc(created.path, { title: 'Original Session Doc' })
    const conversation = await createConversation(doc.path)

    const renamed = await updateDoc(doc.path, { title: 'Renamed Session Doc' })
    const record = await getConversation(conversation.id)
    assertEqual(record.meta.docId, renamed.path, 'doc rename should rewrite conversation docId')
    assertEqual(
      (await listDocConversations(doc.path)).length,
      0,
      'old doc path should have no sessions after rename',
    )
    assertEqual(
      (await listDocConversations(renamed.path))[0]?.id,
      conversation.id,
      'renamed doc path should retain session',
    )
  })
}

async function testConversationDeleteCleansActivity(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'message',
      role: 'user',
      blocks: [{ type: 'text', content: 'delete me' }],
      status: 'done',
    })
    await appendAgentEvent(conversation.id, {
      timestamp: 1,
      conversationId: conversation.id,
      messageId: 'message',
      type: 'turn.started',
    })

    await deleteConversation(conversation.id)
    assertEqual(
      (await listAgentEvents(conversation.id)).length,
      0,
      'delete should remove activity log',
    )
    try {
      await getConversation(conversation.id)
      throw new Error('deleted conversation unexpectedly loaded')
    } catch (error) {
      assert(
        error instanceof Error && !error.message.includes('unexpectedly loaded'),
        'deleted conversation should not be recoverable from disk',
      )
    }
  })
}

async function testActivityUpdatesConversationSummary(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const before = await getConversation(conversation.id)

    const { event, summary } = await appendAgentEventAndTouchConversation(conversation.id, {
      timestamp: before.meta.updatedAt,
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'tool.execution.started',
      data: { toolName: 'read' },
    })

    assertEqual(event.schemaVersion, 1, 'activity event should be versioned')
    assert(summary, 'activity append should return refreshed summary')
    assert(
      summary.updatedAt > before.meta.updatedAt,
      'activity append should bump conversation updatedAt',
    )
    assertEqual(summary.activity?.state, 'running', 'activity summary state')
    assertEqual(summary.activity?.title, 'Running: read', 'activity summary title')
    assertEqual(summary.activity?.toolName, 'read', 'activity summary tool')
    assertEqual(
      summary.activity?.eventType,
      'tool.execution.started',
      'activity summary event type',
    )
    assertEqual(
      (await listAgentEvents(conversation.id))[0]?.type,
      'tool.execution.started',
      'activity append should still persist the event log',
    )
    assertEqual(
      (await listChatConversations())[0]?.id,
      conversation.id,
      'activity append should refresh conversation summaries',
    )
  })
}

async function testActivityDeltaDoesNotTouchConversationSummary(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const before = await getConversation(conversation.id)

    const { event, summary } = await appendAgentEventAndTouchConversation(conversation.id, {
      timestamp: before.meta.updatedAt + 10,
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'tool.input.delta',
      data: { deltaSize: 64, toolCallId: 'tool-call' },
    })

    assertEqual(event.schemaVersion, 1, 'delta event should be versioned')
    assertEqual(summary, undefined, 'input deltas should not refresh conversation summaries')
    assertEqual(
      (await listAgentEvents(conversation.id))[0]?.type,
      'tool.input.delta',
      'input deltas should still persist the event log',
    )

    const after = await getConversation(conversation.id)
    assertEqual(
      after.meta.updatedAt,
      before.meta.updatedAt,
      'input deltas should not bump conversation updatedAt',
    )
    assertEqual(after.meta.activity, undefined, 'input deltas should not set activity')
  })
}

async function testStaleActivityDoesNotOverwriteNewerSummary(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendAgentEventAndTouchConversation(conversation.id, {
      timestamp: 200,
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'turn.completed',
    })
    const { summary } = await appendAgentEventAndTouchConversation(conversation.id, {
      timestamp: 100,
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'tool.execution.started',
      data: { toolName: 'read_file' },
    })

    assert(summary, 'stale activity append should still return a summary')
    assertEqual(summary.activity?.state, 'completed', 'newer activity state should be preserved')
    assertEqual(summary.activity?.eventType, 'turn.completed', 'newer activity event should stay')
    assertEqual(summary.activity?.updatedAt, 200, 'newer activity timestamp should stay')
    const events = await listAgentEvents(conversation.id)
    assertEqual(events.length, 2, 'stale activity should still persist in the event log')
    assertEqual(
      events[0]?.type,
      'tool.execution.started',
      'event log should remain timestamp sorted',
    )
  })
}

async function testToolResultActivityKeepsToolName(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const { summary } = await appendAgentEventAndTouchConversation(conversation.id, {
      timestamp: Date.now(),
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'tool.result.returned',
      data: {
        toolCallId: 'tool-call',
        toolName: 'read_file',
        isError: false,
        result: { preview: 'ok', size: 2 },
      },
    })

    assert(summary, 'tool result activity should return refreshed summary')
    assertEqual(summary.activity?.state, 'running', 'tool result activity state')
    assertEqual(
      summary.activity?.title,
      'Tool result returned: read_file',
      'tool result activity title should keep tool name',
    )
    assertEqual(summary.activity?.toolName, 'read_file', 'tool result activity tool name')
    assertEqual(
      summary.activity?.eventType,
      'tool.result.returned',
      'tool result activity event type',
    )
  })
}

function testRendererHydratesActiveAssistantTurn(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'HYDRATE',
    conversationId: 'conversation-active',
    messages: [
      { id: 'user', role: 'user', blocks: [{ type: 'text', content: 'hello' }], status: 'done' },
    ],
    usage: null,
    events: [],
    activeTurn: {
      conversationId: 'conversation-active',
      assistantMessageId: 'assistant-active',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })

  const stream = state.streams.get('conversation-active')
  assert(stream, 'active hydrate should create a stream')
  assertEqual(stream.runningMessageId, 'assistant-active', 'active hydrate running message id')
  const assistant = stream.messages.at(-1)
  assertEqual(assistant?.id, 'assistant-active', 'active hydrate assistant message id')
  assertEqual(assistant?.role, 'assistant', 'active hydrate assistant role')
  assertEqual(assistant?.status, 'streaming', 'active hydrate assistant status')
  assertEqual(assistant?.model?.modelId, 'contract/mock', 'active hydrate assistant model')
}

function testRendererHydratePreservesLocalStreamingMessages(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_STARTED',
    conversationId: 'conversation-hydrate-race',
    userMessage: {
      id: 'user-hydrate-race',
      role: 'user',
      blocks: [{ type: 'text', content: 'draft prompt' }],
      status: 'done',
    },
    assistantMessage: {
      id: 'assistant-hydrate-race',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'partial' }],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'HYDRATE',
    conversationId: 'conversation-hydrate-race',
    messages: [],
    usage: null,
    events: [],
  })

  const stream = state.streams.get('conversation-hydrate-race')
  assert(stream, 'hydrate race should keep stream')
  assertEqual(stream.messages.length, 2, 'hydrate should keep local user and assistant')
  assertEqual(stream.messages[0]?.id, 'user-hydrate-race', 'hydrate should keep local user')
  assertEqual(
    stream.messages[1]?.id,
    'assistant-hydrate-race',
    'hydrate should keep local assistant',
  )
  assertEqual(stream.runningMessageId, 'assistant-hydrate-race', 'hydrate should keep running id')
}

function testRendererHydrateReplacesStreamingWithPersistedTerminal(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_STARTED',
    conversationId: 'conversation-hydrate-terminal',
    userMessage: {
      id: 'user-hydrate-terminal',
      role: 'user',
      blocks: [{ type: 'text', content: 'finish before hydrate' }],
      status: 'done',
    },
    assistantMessage: {
      id: 'assistant-hydrate-terminal',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'partial' }],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'HYDRATE',
    conversationId: 'conversation-hydrate-terminal',
    messages: [
      {
        id: 'user-hydrate-terminal',
        role: 'user',
        blocks: [{ type: 'text', content: 'finish before hydrate' }],
        status: 'done',
      },
      {
        id: 'assistant-hydrate-terminal',
        role: 'assistant',
        blocks: [{ type: 'text', content: 'final answer' }],
        status: 'done',
        model: { providerId: 'openrouter', modelId: 'contract/mock' },
      },
    ],
    usage: null,
    events: [],
  })

  const stream = state.streams.get('conversation-hydrate-terminal')
  assert(stream, 'terminal hydrate should keep stream')
  assertEqual(stream.messages.length, 2, 'terminal hydrate should keep merged messages')
  assertEqual(
    stream.messages[1]?.status,
    'done',
    'terminal hydrate should replace local streaming assistant',
  )
  assertEqual(stream.runningMessageId, null, 'terminal hydrate should clear running id')
}

function testRendererFinishAppendsMissingAssistantMessage(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'FINISH',
    conversationId: 'conversation-finish',
    messageId: 'assistant-finish',
    message: {
      id: 'assistant-finish',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'final answer' }],
      status: 'done',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })

  const stream = state.streams.get('conversation-finish')
  assert(stream, 'finish should create a stream for late renderer events')
  assertEqual(stream.messages.length, 1, 'finish should append missing assistant message')
  assertEqual(stream.messages[0]?.id, 'assistant-finish', 'finish appended assistant id')
  assertEqual(stream.messages[0]?.status, 'done', 'finish appended assistant status')
}

function testRendererRunStartedDoesNotDuplicateFinishedAssistant(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'FINISH',
    conversationId: 'conversation-early-error',
    messageId: 'assistant-early-error',
    message: {
      id: 'assistant-early-error',
      role: 'assistant',
      blocks: [],
      status: 'error',
      error: 'workspace roots unavailable',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_STARTED',
    conversationId: 'conversation-early-error',
    userMessage: {
      id: 'user-early-error',
      role: 'user',
      blocks: [{ type: 'text', content: 'fail before stream starts' }],
      status: 'done',
    },
    assistantMessage: {
      id: 'assistant-early-error',
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })

  const stream = state.streams.get('conversation-early-error')
  assert(stream, 'early error should create a stream')
  assertEqual(
    stream.messages.filter((message) => message.id === 'assistant-early-error').length,
    1,
    'RUN_STARTED should not duplicate an already finished assistant',
  )
  assertEqual(
    stream.messages.find((message) => message.id === 'assistant-early-error')?.status,
    'error',
    'RUN_STARTED should not downgrade an early error to streaming',
  )
  assertEqual(stream.runningMessageId, null, 'early error should not become running')
}

function testRendererToolResultAppendsMissingAssistantMessage(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'TOOL_CALL_RESULT',
    conversationId: 'conversation-tool',
    messageId: 'assistant-tool',
    toolCallId: 'tool-call',
    name: 'read_file',
    result: 'file contents',
    isError: false,
  })

  const stream = state.streams.get('conversation-tool')
  assert(stream, 'tool result should create a stream for late renderer events')
  assertEqual(stream.runningMessageId, 'assistant-tool', 'tool result running message id')
  const assistant = stream.messages[0]
  assertEqual(assistant?.id, 'assistant-tool', 'tool result assistant id')
  const block = assistant?.blocks[0]
  assertEqual(block?.type, 'tool_call', 'tool result should create a tool block')
  assertEqual(
    block?.type === 'tool_call' ? block.name : undefined,
    'read_file',
    'tool result should keep tool name',
  )
  assertEqual(
    block?.type === 'tool_call' ? block.status : undefined,
    'done',
    'tool result should mark tool done',
  )
}

async function testInterruptedActivityRecovery(): Promise<void> {
  await withTempDataDir(async () => {
    const running = await createConversation()
    await appendMessage(running.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'running-user',
      role: 'user',
      blocks: [{ type: 'text', content: 'recover interrupted running turn' }],
      status: 'done',
    })
    await appendAgentEventAndTouchConversation(running.id, {
      timestamp: Date.now(),
      conversationId: running.id,
      messageId: 'running-assistant',
      type: 'turn.started',
    })

    const approval = await createConversation()
    await appendAgentEventAndTouchConversation(approval.id, {
      timestamp: Date.now(),
      conversationId: approval.id,
      messageId: 'approval-assistant',
      type: 'tool.approval.requested',
      data: { toolName: 'write_file', requestId: 'approval-request' },
    })

    const completed = await createConversation()
    await appendAgentEventAndTouchConversation(completed.id, {
      timestamp: Date.now(),
      conversationId: completed.id,
      messageId: 'completed-assistant',
      type: 'turn.completed',
    })

    const recovered = await recoverInterruptedConversationActivities('contract restart')
    assertEqual(recovered.length, 2, 'recovery should update active runtime activities only')

    const runningRecord = await getConversation(running.id)
    assertEqual(
      runningRecord.meta.activity?.state,
      'interrupted',
      'running activity should recover as interrupted',
    )
    assertEqual(
      runningRecord.meta.activity?.title,
      'Interrupted',
      'running recovery activity title',
    )
    assertEqual(
      runningRecord.meta.activity?.messageId,
      'running-assistant',
      'running recovery should keep assistant message id',
    )

    const approvalRecord = await getConversation(approval.id)
    assertEqual(
      approvalRecord.meta.activity?.state,
      'interrupted',
      'approval activity should recover as interrupted',
    )

    const completedRecord = await getConversation(completed.id)
    assertEqual(
      completedRecord.meta.activity?.state,
      'completed',
      'completed activity should not be recovered',
    )

    const events = await listAgentEvents(running.id)
    assertEqual(events.at(-1)?.type, 'turn.interrupted', 'recovery should append event log entry')
    assertEqual(
      events.at(-1)?.data?.previousState,
      'running',
      'recovery event should include previous state',
    )
  })
}

async function testToolApprovalsCanHydrateAndResolvePendingRequests(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const requested: ToolApprovalRequestPayload[] = []
    const resolved: ToolApprovalResolvedPayload[] = []
    const store = new ToolApprovalStore({
      timeoutMs: 1000,
      onRequest: (payload) => requested.push(payload),
      onResolved: (payload) => resolved.push(payload),
    })

    const approval = store.request({
      name: 'write_file',
      args: { path: '/workspace/note.md', content: 'approved write' },
      metadata: {
        name: 'write_file',
        readOnly: false,
        destructive: true,
        requiresApproval: true,
        access: ['write'],
        scope: ['workspace'],
        allowedProfiles: ['coding'],
      },
      conversationId: conversation.id,
      messageId: 'assistant-message',
      toolCallId: 'tool-call',
    })

    assertEqual(requested.length, 1, 'approval store should emit request payload')
    const pending = store.list()
    assertEqual(pending.length, 1, 'approval store should list pending request')
    assertEqual(
      pending[0]?.requestId,
      requested[0]?.requestId,
      'listed approval should match emitted request',
    )
    assertEqual(pending[0]?.name, 'write_file', 'listed approval tool name')
    assert(
      typeof pending[0]?.requestedAt === 'number' && pending[0].requestedAt <= pending[0].expiresAt,
      'listed approval should include timing metadata',
    )

    store.resolve(requested[0]?.requestId ?? '', true, 'user')
    assertEqual(await approval, true, 'resolved approval promise')
    assertEqual(store.list().length, 0, 'resolved approval should leave pending list')
    await waitFor(() => resolved.length === 1, 'approval store should emit resolved payload')
    assertEqual(resolved[0]?.approved, true, 'resolved approval approved flag')
    assertEqual(resolved[0]?.reason, 'user', 'resolved approval reason')

    await store.flushActivity()
    const events = await listAgentEvents(conversation.id)
    assertEqual(events[0]?.type, 'tool.approval.requested', 'approval requested event')
    assertEqual(events[1]?.type, 'tool.approval.resolved', 'approval resolved event')
    assertEqual(events[1]?.data?.approved, true, 'approval resolved event approved flag')

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'running', 'approved activity state')
    assertEqual(record.meta.activity?.title, 'Approved: write_file', 'approved activity title')
  })
}

async function testToolApprovalTimeoutClearsPendingRequests(): Promise<void> {
  const resolved: ToolApprovalResolvedPayload[] = []
  const store = new ToolApprovalStore({
    timeoutMs: 10,
    onResolved: (payload) => resolved.push(payload),
  })

  const approval = store.request({
    name: 'run_shell',
    args: { command: 'echo timeout' },
    metadata: {
      name: 'run_shell',
      readOnly: false,
      destructive: false,
      requiresApproval: true,
      access: ['shell'],
      scope: ['workspace'],
      allowedProfiles: ['coding'],
    },
  })

  assertEqual(store.list().length, 1, 'timed approval should start pending')
  assertEqual(await approval, false, 'timed approval should resolve denied')
  assertEqual(store.list().length, 0, 'timed approval should clear pending list')
  await waitFor(() => resolved.length === 1, 'timed approval should emit resolved payload')
  assertEqual(resolved[0]?.approved, false, 'timed approval resolved approved flag')
  assertEqual(resolved[0]?.reason, 'timeout', 'timed approval resolved reason')
}

async function testToolApprovalCancellationClearsConversationRequests(): Promise<void> {
  await withTempDataDir(async () => {
    const cancelledConversation = await createConversation()
    const otherConversation = await createConversation()
    const resolved: ToolApprovalResolvedPayload[] = []
    const store = new ToolApprovalStore({
      timeoutMs: 1000,
      onResolved: (payload) => resolved.push(payload),
    })

    const cancelledApproval = store.request({
      name: 'write_file',
      args: { path: '/workspace/cancelled.md', content: 'cancelled write' },
      metadata: {
        name: 'write_file',
        readOnly: false,
        destructive: true,
        requiresApproval: true,
        access: ['write'],
        scope: ['workspace'],
        allowedProfiles: ['coding'],
      },
      conversationId: cancelledConversation.id,
      messageId: 'cancelled-assistant',
      toolCallId: 'cancelled-tool-call',
    })
    const otherApproval = store.request({
      name: 'write_file',
      args: { path: '/workspace/other.md', content: 'other write' },
      metadata: {
        name: 'write_file',
        readOnly: false,
        destructive: true,
        requiresApproval: true,
        access: ['write'],
        scope: ['workspace'],
        allowedProfiles: ['coding'],
      },
      conversationId: otherConversation.id,
      messageId: 'other-assistant',
      toolCallId: 'other-tool-call',
    })

    assertEqual(
      store.resolveForConversation(cancelledConversation.id, false, 'cancelled'),
      1,
      'conversation cancellation should resolve matching approvals only',
    )
    assertEqual(await cancelledApproval, false, 'cancelled approval promise')
    assertEqual(store.list().length, 1, 'conversation cancellation should keep other approvals')
    assertEqual(
      store.list()[0]?.conversationId,
      otherConversation.id,
      'remaining approval conversation id',
    )
    await waitFor(() => resolved.length === 1, 'cancelled approval should emit resolved payload')
    assertEqual(resolved[0]?.approved, false, 'cancelled approval resolved approved flag')
    assertEqual(resolved[0]?.reason, 'cancelled', 'cancelled approval resolved reason')

    await store.flushActivity()
    const events = await listAgentEvents(cancelledConversation.id)
    assertEqual(events.at(-1)?.type, 'tool.approval.resolved', 'cancelled approval event type')
    assertEqual(events.at(-1)?.data?.reason, 'cancelled', 'cancelled approval event reason')

    const record = await getConversation(cancelledConversation.id)
    assertEqual(record.meta.activity?.state, 'failed', 'cancelled approval activity state')
    assertEqual(record.meta.activity?.title, 'Denied: write_file', 'cancelled approval title')

    store.shutdown()
    assertEqual(await otherApproval, false, 'shutdown should clear remaining approval')
  })
}

async function main(): Promise<void> {
  await testDocConversationWorkspaceContext()
  await testDesktopWorkspaceRoots()
  await testConversationPartitionContract()
  await testDocConversationFollowsDocRename()
  await testConversationDeleteCleansActivity()
  await testActivityUpdatesConversationSummary()
  await testActivityDeltaDoesNotTouchConversationSummary()
  await testStaleActivityDoesNotOverwriteNewerSummary()
  await testToolResultActivityKeepsToolName()
  testRendererHydratesActiveAssistantTurn()
  testRendererHydratePreservesLocalStreamingMessages()
  testRendererHydrateReplacesStreamingWithPersistedTerminal()
  testRendererFinishAppendsMissingAssistantMessage()
  testRendererRunStartedDoesNotDuplicateFinishedAssistant()
  testRendererToolResultAppendsMissingAssistantMessage()
  await testInterruptedActivityRecovery()
  await testToolApprovalsCanHydrateAndResolvePendingRequests()
  await testToolApprovalTimeoutClearsPendingRequests()
  await testToolApprovalCancellationClearsConversationRequests()
  console.log('desktop workbench contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
