import {
  type ConversationSummary,
  listConversations as listPersistedConversations,
} from './conversations'
import { listAll } from './docs'

export interface DocConversationCleanupRuntime {
  listConversations: () => Promise<readonly ConversationSummary[]>
  deleteConversation: (conversationId: string) => Promise<void>
}

export async function listOrphanedDocConversations(
  input: Pick<DocConversationCleanupRuntime, 'listConversations'> = {
    listConversations: listPersistedConversations,
  },
): Promise<ConversationSummary[]> {
  const [{ docs }, conversations] = await Promise.all([listAll(), input.listConversations()])
  const liveDocPaths = new Set(docs.map((doc) => doc.path))
  return conversations.filter(
    (conversation) => conversation.docId && !liveDocPaths.has(conversation.docId),
  )
}

export async function sweepOrphanedDocConversations(
  runtime: DocConversationCleanupRuntime,
): Promise<ConversationSummary[]> {
  const orphans = await listOrphanedDocConversations(runtime)
  await Promise.all(orphans.map((orphan) => runtime.deleteConversation(orphan.id)))
  return orphans
}
