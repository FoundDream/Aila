import {
  appendAgentEventAndTouchConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listAgentEvents,
  listConversations,
  recoverInterruptedConversationActivities,
  renameConversation,
  setConversationUsage,
  upsertMessage,
} from './conversations'
import type { AgentRuntimeStore } from './runtime'

export function createPersistedRuntimeStore(): AgentRuntimeStore {
  return {
    createConversation,
    getConversation,
    upsertMessage,
    appendAgentEventAndTouchConversation,
    listConversations,
    listAgentEvents,
    recoverInterruptedConversationActivities,
    renameConversation,
    setConversationUsage,
    deleteConversation,
  }
}
