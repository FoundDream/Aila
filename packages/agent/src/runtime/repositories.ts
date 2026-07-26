import type { RunEvent, UsageInfo } from '../agent-protocol'
import type {
  ConversationContextCheckpoint,
  ConversationContextTurnLedgerEntry,
  ConversationRecord,
  ConversationSummary,
  ConversationWorkspaceRef,
  PersistedMessage,
  PersistedRunEvent,
  RunEventAppendResult,
} from '../conversation-core'
import type { PlanArtifact, PlanRevisionInput } from '../plan-core'
import type { RunArtifact, RunCheckpoint } from '../run-persistence'

export interface SessionRepository {
  createConversation?: (workspace?: ConversationWorkspaceRef | null) => Promise<ConversationSummary>
  getConversation: (conversationId: string) => Promise<ConversationRecord>
  listConversations?: () => Promise<readonly ConversationSummary[]>
  saveMessage: (conversationId: string, message: PersistedMessage) => Promise<ConversationSummary>
  renameConversation?: (conversationId: string, title: string) => Promise<ConversationSummary>
  recordUsage: (conversationId: string, usage: UsageInfo) => Promise<ConversationSummary>
  saveContextCheckpoint?: (
    conversationId: string,
    checkpoint: ConversationContextCheckpoint,
  ) => Promise<ConversationSummary>
  recordContextTurnLedger?: (
    conversationId: string,
    entry: ConversationContextTurnLedgerEntry,
  ) => Promise<ConversationSummary>
  deleteConversation: (conversationId: string) => Promise<void>
}

export interface EventRepository {
  recordRunEvent: (conversationId: string, event: RunEvent) => Promise<RunEventAppendResult>
  listRunEvents?: (conversationId: string) => Promise<readonly PersistedRunEvent[]>
  recoverInterruptedActivities?: (reason?: string) => Promise<readonly RunEventAppendResult[]>
}

export interface RunRepository {
  saveRunCheckpoint?: (checkpoint: RunCheckpoint) => Promise<RunCheckpoint>
  getRunCheckpoint?: (conversationId: string, runId: string) => Promise<RunCheckpoint | null>
  listRunCheckpoints?: (conversationId: string) => Promise<readonly RunCheckpoint[]>
  saveRunArtifact?: (artifact: RunArtifact) => Promise<RunArtifact>
  listRunArtifacts?: (conversationId: string, runId: string) => Promise<readonly RunArtifact[]>
}

export interface PlanRepository {
  createPlan?: (plan: PlanArtifact) => Promise<PlanArtifact>
  getPlan?: (conversationId: string, planId: string) => Promise<PlanArtifact>
  listPlans?: (conversationId: string) => Promise<readonly PlanArtifact[]>
  updatePlan?: (plan: PlanArtifact) => Promise<PlanArtifact>
  appendPlanRevision?: (input: PlanRevisionInput) => Promise<PlanArtifact>
}

/** Store composition consumed by the Workbench product layer. */
export interface WorkbenchStore
  extends SessionRepository,
    EventRepository,
    RunRepository,
    PlanRepository {}
