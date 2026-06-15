import type { AgentRuntimeStore } from '@aila/agent'
import {
  appendAgentEventAndTouchConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listAgentEvents,
  listConversations,
  recordConversationContextTurnLedger,
  recoverInterruptedConversationActivityResults,
  renameConversation,
  setConversationContextCheckpoint,
  setConversationUsage,
  upsertMessage,
} from './conversations'

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
    saveContextCheckpoint: setConversationContextCheckpoint,
    recordContextTurnLedger: recordConversationContextTurnLedger,
    deleteConversation,
  }
}
