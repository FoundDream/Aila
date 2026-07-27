import type {
  ConversationRecord,
  ConversationSummary,
  ConversationWorkspaceRef,
  RunEventAppendResult,
} from '../conversation-core'
import type { RunSnapshot } from '../run-persistence'
import type {
  BlobRef,
  SessionEntry,
  SessionEntryAppendResult,
  SessionEntryInput,
  StoredBlob,
} from '../session-journal'

export interface SessionRepository {
  createConversation?: (workspace?: ConversationWorkspaceRef | null) => Promise<ConversationSummary>
  getConversation: (conversationId: string) => Promise<ConversationRecord>
  listConversations?: () => Promise<readonly ConversationSummary[]>
  appendSessionEntry: (
    conversationId: string,
    entry: SessionEntryInput,
  ) => Promise<SessionEntryAppendResult>
  listSessionEntries: (conversationId: string) => Promise<readonly SessionEntry[]>
  deleteConversation: (conversationId: string) => Promise<void>
}

export interface RecoveryRepository {
  recoverInterruptedActivities?: (reason?: string) => Promise<readonly RunEventAppendResult[]>
}

export interface RunSnapshotRepository {
  saveRunSnapshot: (snapshot: RunSnapshot) => Promise<RunSnapshot>
  getRunSnapshot: (conversationId: string, runId: string) => Promise<RunSnapshot | null>
  listRunSnapshots: (conversationId: string) => Promise<readonly RunSnapshot[]>
}

export interface BlobRepository {
  putBlob: (
    conversationId: string,
    input: { contentType: string; data: unknown; preview?: string; blobId?: string },
  ) => Promise<BlobRef>
  getBlob: (conversationId: string, blobId: string) => Promise<StoredBlob | null>
}

/** One journal plus rebuildable snapshots and referenced blobs. */
export interface WorkbenchStore
  extends SessionRepository,
    RecoveryRepository,
    RunSnapshotRepository,
    BlobRepository {}

/** @deprecated Use RecoveryRepository. */
export type EventRepository = RecoveryRepository
/** @deprecated Use RunSnapshotRepository and BlobRepository. */
export type RunRepository = RunSnapshotRepository & BlobRepository
