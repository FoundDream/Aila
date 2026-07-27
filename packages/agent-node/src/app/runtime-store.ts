import type { WorkbenchStore } from '@aila/agent'
import {
  appendRunEventAndTouchConversation,
  createConversation,
  deleteConversation,
  getConversation,
  getRunCheckpoint,
  listConversations,
  listRunArtifacts,
  listRunCheckpoints,
  listRunEvents,
  recordConversationContextTurnLedger,
  recoverInterruptedConversationActivityResults,
  renameConversation,
  saveRunArtifact,
  saveRunCheckpoint,
  setConversationContextCheckpoint,
  setConversationUsage,
  upsertMessage,
} from './conversations'

export function createPersistedRuntimeStore(): WorkbenchStore {
  return {
    createConversation,
    getConversation,
    saveMessage: upsertMessage,
    recordRunEvent: appendRunEventAndTouchConversation,
    listConversations,
    listRunEvents,
    recoverInterruptedActivities: recoverInterruptedConversationActivityResults,
    renameConversation,
    recordUsage: setConversationUsage,
    saveContextCheckpoint: setConversationContextCheckpoint,
    recordContextTurnLedger: recordConversationContextTurnLedger,
    saveRunCheckpoint: saveRunCheckpoint,
    getRunCheckpoint: getRunCheckpoint,
    listRunCheckpoints: listRunCheckpoints,
    saveRunArtifact: saveRunArtifact,
    listRunArtifacts: listRunArtifacts,
    deleteConversation,
  }
}
