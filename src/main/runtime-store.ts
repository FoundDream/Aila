import type { AgentRuntimeStore } from '@aila/agent'
import {
  appendAgentEventAndTouchConversation,
  appendPlanRevision,
  createConversation,
  createPlan,
  deleteConversation,
  getConversation,
  getPlan,
  listAgentEvents,
  listConversations,
  listPlans,
  recordConversationContextTurnLedger,
  recoverInterruptedConversationActivityResults,
  renameConversation,
  setConversationContextCheckpoint,
  setConversationUsage,
  updatePlan,
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
    createPlan,
    getPlan,
    listPlans,
    updatePlan,
    appendPlanRevision,
    deleteConversation,
  }
}
