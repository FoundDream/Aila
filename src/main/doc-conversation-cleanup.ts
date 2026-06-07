import { type ConversationSummary, listConversations } from './conversations'
import { listAll } from './docs'

export async function listOrphanedDocConversations(): Promise<ConversationSummary[]> {
  const [{ docs }, conversations] = await Promise.all([listAll(), listConversations()])
  const liveDocPaths = new Set(docs.map((doc) => doc.path))
  return conversations.filter(
    (conversation) => conversation.docId && !liveDocPaths.has(conversation.docId),
  )
}

export async function sweepOrphanedDocConversations(
  deleteConversation: (conversationId: string) => Promise<void>,
): Promise<ConversationSummary[]> {
  const orphans = await listOrphanedDocConversations()
  await Promise.all(orphans.map((orphan) => deleteConversation(orphan.id)))
  return orphans
}
