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

async function main(): Promise<void> {
  await testDocConversationWorkspaceContext()
  await testDesktopWorkspaceRoots()
  await testConversationPartitionContract()
  await testDocConversationFollowsDocRename()
  await testConversationDeleteCleansActivity()
  await testActivityUpdatesConversationSummary()
  await testActivityDeltaDoesNotTouchConversationSummary()
  await testToolApprovalsCanHydrateAndResolvePendingRequests()
  await testToolApprovalTimeoutClearsPendingRequests()
  console.log('desktop workbench contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
