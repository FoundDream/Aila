import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  appendAgentEvent,
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

async function main(): Promise<void> {
  await testDocConversationWorkspaceContext()
  await testDesktopWorkspaceRoots()
  await testConversationPartitionContract()
  await testDocConversationFollowsDocRename()
  await testConversationDeleteCleansActivity()
  console.log('desktop workbench contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
