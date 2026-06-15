import {
  type ActiveAssistantTurn,
  type AgentRuntimeApi,
  type ChatAttachmentInput,
  type ConversationRecord,
  type ConversationRuntimeHydration,
  type ConversationRuntimeStateSnapshot,
  type ConversationSummary,
  type ConversationWorkspaceRef,
  type ModelSelection,
  type RuntimeCompactConversationResult,
  type RuntimeListConversationsInput,
  type RuntimeSendResult,
  type ToolApprovalRequest,
  type ToolApprovalRequestPayload,
  ToolApprovalStore,
} from '@aila/agent'
import type { IpcMain } from 'electron'
import { cleanupConversationImages } from './image-store'
import { createPersistedAgentRuntime } from './runtime-host'
import {
  buildDesktopWorkspaceContextFromRecord,
  getDesktopWorkspaceRoots,
} from './workspace-context'

const TOOL_APPROVAL_TIMEOUT_MS = 60_000

type DesktopRuntimeEmitter = (channel: string, data?: unknown) => void

export interface RuntimeWorkbenchSendInput {
  conversationId: string
  userText: string
  selection: ModelSelection
  attachments?: ChatAttachmentInput[]
}

export interface RuntimeWorkbenchRetryLastInput {
  conversationId: string
  selection: ModelSelection
}

export interface RuntimeWorkbenchCompactInput {
  conversationId: string
  selection: ModelSelection
}

export interface RuntimeWorkbenchCreateConversationInput {
  docId?: string | null
  workspace?: ConversationWorkspaceRef | null
}

export interface RuntimeWorkbenchReloadResult {
  toolPackCount: number
  toolCount: number
}

export interface DesktopRuntimeWorkbench {
  send(input: RuntimeWorkbenchSendInput): Promise<RuntimeSendResult>
  retryLastUserMessage(input: RuntimeWorkbenchRetryLastInput): Promise<RuntimeSendResult>
  compactConversation(
    input: RuntimeWorkbenchCompactInput,
  ): Promise<RuntimeCompactConversationResult>
  abort(conversationId: string): Promise<void>
  listActiveTurns(): ActiveAssistantTurn[]
  recoverInterruptedActivities(reason?: string): Promise<ConversationSummary[]>
  shutdown(): Promise<void>
  reloadExtensions(): Promise<RuntimeWorkbenchReloadResult>

  createConversation(input?: RuntimeWorkbenchCreateConversationInput): Promise<ConversationSummary>
  listConversations(input?: RuntimeListConversationsInput): Promise<ConversationSummary[]>
  getConversation(conversationId: string): Promise<ConversationRecord>
  hydrateConversation(conversationId: string): Promise<ConversationRuntimeHydration>
  listConversationRuntimeStates(
    input?: RuntimeListConversationsInput,
  ): Promise<ConversationRuntimeStateSnapshot[]>
  renameConversation(conversationId: string, title: string): Promise<ConversationSummary>
  deleteConversation(conversationId: string): Promise<void>

  listPendingApprovals(): ToolApprovalRequestPayload[]
  resolveToolApproval(requestId: string, approved: boolean): void
}

export interface CreateDesktopRuntimeWorkbenchInput {
  emit: DesktopRuntimeEmitter
  logger?: Pick<Console, 'error' | 'warn'>
}

export function createDesktopRuntimeWorkbench(
  input: CreateDesktopRuntimeWorkbenchInput,
): DesktopRuntimeWorkbench {
  const logger = input.logger ?? console
  let runtime: AgentRuntimeApi

  const toolApprovals = new ToolApprovalStore({
    timeoutMs: TOOL_APPROVAL_TIMEOUT_MS,
    recordAgentEvent: async (_conversationId, event) => {
      await runtime.recordAgentEvent(event)
      return undefined
    },
    onRequest: (payload) => input.emit('tools:approval-request', payload),
    onResolved: (payload) => input.emit('tools:approval-resolved', payload),
    logger,
  })

  function requestToolApproval(req: ToolApprovalRequest): Promise<boolean> {
    return toolApprovals.request(req)
  }

  async function cancelConversationApprovals(conversationId: string): Promise<void> {
    const resolved = toolApprovals.resolveForConversation(conversationId, false, 'cancelled')
    if (resolved > 0) await toolApprovals.flushActivity()
  }

  runtime = createPersistedAgentRuntime({
    host: {
      onEvent: (event) => input.emit(event.type, event.data),
      onToolApproval: requestToolApproval,
      onConversationAbort: cancelConversationApprovals,
      cleanupConversationAssets: cleanupConversationImages,
      loadTransientContext: ({ record }) => buildDesktopWorkspaceContextFromRecord(record),
      workspaceRoots: getDesktopWorkspaceRoots,
      logger,
    },
  })

  return {
    send(input) {
      return runtime.send({
        conversationId: input.conversationId,
        userText: input.userText,
        selection: input.selection,
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
      })
    },
    retryLastUserMessage(input) {
      return runtime.retryLastUserMessage(input)
    },
    compactConversation(input) {
      return runtime.compactConversation(input)
    },
    abort(conversationId) {
      return runtime.abort(conversationId)
    },
    listActiveTurns() {
      return runtime.listActiveTurns()
    },
    recoverInterruptedActivities(reason) {
      return runtime.recoverInterruptedActivities(reason)
    },
    async shutdown() {
      await runtime.shutdown('shutdown')
      await toolApprovals.shutdown()
    },
    async reloadExtensions() {
      const registry = await runtime.reloadToolPacks()
      return {
        toolPackCount: registry.toolPacks.length,
        toolCount: registry.specs.length,
      }
    },

    createConversation(input = {}) {
      return runtime.createConversation({
        docId: input.docId ?? null,
        workspace: input.workspace ?? null,
      })
    },
    listConversations(input = {}) {
      return runtime.listConversations(input)
    },
    getConversation(conversationId) {
      return runtime.getConversation(conversationId)
    },
    hydrateConversation(conversationId) {
      return runtime.hydrateConversation(conversationId)
    },
    listConversationRuntimeStates(input = {}) {
      return runtime.listConversationRuntimeStates(input)
    },
    renameConversation(conversationId, title) {
      return runtime.renameConversation(conversationId, title)
    },
    deleteConversation(conversationId) {
      return runtime.deleteConversation(conversationId)
    },

    listPendingApprovals() {
      return toolApprovals.list()
    },
    resolveToolApproval(requestId, approved) {
      toolApprovals.resolve(requestId, approved, 'user')
    },
  }
}

export function registerRuntimeWorkbenchIpcHandlers(
  ipc: Pick<IpcMain, 'handle' | 'on'>,
  workbench: DesktopRuntimeWorkbench,
): void {
  ipc.handle('runtime:send', (_event, request: RuntimeWorkbenchSendInput) =>
    workbench.send(request),
  )
  ipc.handle('runtime:retry-last', (_event, request: RuntimeWorkbenchRetryLastInput) =>
    workbench.retryLastUserMessage(request),
  )
  ipc.handle('runtime:compact-conversation', (_event, request: RuntimeWorkbenchCompactInput) =>
    workbench.compactConversation(request),
  )
  ipc.handle('runtime:abort', (_event, conversationId: string) => workbench.abort(conversationId))
  ipc.handle('runtime:list-active-turns', () => workbench.listActiveTurns())
  ipc.handle('runtime:hydrate-conversation', (_event, conversationId: string) =>
    workbench.hydrateConversation(conversationId),
  )
  ipc.handle('runtime:conversations:list', (_event, docId: string | null) =>
    workbench.listConversations({ docId }),
  )
  ipc.handle('runtime:conversations:get', (_event, conversationId: string) =>
    workbench.getConversation(conversationId),
  )
  ipc.handle(
    'runtime:conversations:create',
    (_event, input?: string | null | RuntimeWorkbenchCreateConversationInput) => {
      if (typeof input === 'string' || input === null) {
        return workbench.createConversation({ docId: input ?? null })
      }
      return workbench.createConversation(input ?? {})
    },
  )
  ipc.handle('runtime:conversations:rename', (_event, conversationId: string, title: string) =>
    workbench.renameConversation(conversationId, title),
  )
  ipc.handle('runtime:conversations:delete', (_event, conversationId: string) =>
    workbench.deleteConversation(conversationId),
  )
  ipc.handle('runtime:conversations:list-runtime-states', (_event, docId: string | null) =>
    workbench.listConversationRuntimeStates({ docId }),
  )
  ipc.handle('tools:list-pending-approvals', () => workbench.listPendingApprovals())
  ipc.on('tools:approval-response', (_event, payload: { requestId: string; approved: boolean }) => {
    workbench.resolveToolApproval(payload.requestId, payload.approved)
  })
}
