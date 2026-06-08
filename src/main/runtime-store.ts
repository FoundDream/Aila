import {
  appendAgentEventAndTouchConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listAgentEvents,
  listConversations,
  recoverInterruptedConversationActivityResults,
  renameConversation,
  setConversationUsage,
  upsertMessage,
} from './conversations'
import type { AgentRuntimeStore } from './runtime'

export function createPersistedRuntimeStore(): AgentRuntimeStore {
  return {
    createConversation,
    getConversation,
    saveMessage: upsertMessage,
    recordAgentEvent: appendAgentEventAndTouchConversation,
    listConversations,
    listAgentEvents,
    recoverInterruptedActivities: recoverInterruptedConversationActivityResults,
    renameConversation,
    recordUsage: setConversationUsage,
    deleteConversation,
  }
}
