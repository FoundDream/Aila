import type {
  ConversationRecord,
  ConversationSummary,
  ConversationWorkspaceRef,
  RunEventAppendResult,
} from '../conversation-core'
import type { RunSnapshot } from '../run-persistence'
import type {
  BlobGarbageCollectionResult,
  BlobRef,
  SessionEntry,
  SessionEntryAppendResult,
  SessionEntryInput,
  SessionTree,
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
  getSessionTree: (conversationId: string) => Promise<SessionTree>
  getSessionBranch: (conversationId: string, entryId?: string) => Promise<readonly SessionEntry[]>
  setSessionLeaf: (conversationId: string, entryId: string) => Promise<SessionEntryAppendResult>
  forkConversation: (
    conversationId: string,
    entryId?: string,
    workspace?: ConversationWorkspaceRef | null,
  ) => Promise<ConversationSummary>
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
  collectGarbageBlobs: (conversationId: string) => Promise<BlobGarbageCollectionResult>
}

/** One journal plus rebuildable snapshots and referenced blobs. */
export interface WorkbenchStore
  extends SessionRepository,
    RecoveryRepository,
    RunSnapshotRepository,
    BlobRepository {}
