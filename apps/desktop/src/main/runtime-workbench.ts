import {
  type ActiveAssistantTurn,
  type AilaExecutionMode,
  type ChatAttachmentInput,
  type ConversationRecord,
  type ConversationRuntimeHydration,
  type ConversationRuntimeStateSnapshot,
  type ConversationSummary,
  type ConversationWorkspaceRef,
  type ModelSelection,
  type RunArtifact,
  type RunCheckpoint,
  type RuntimeCompactConversationResult,
  type RuntimeForkRunInput,
  type RuntimeRunArtifactInput,
  type RuntimeRunControlInput,
  type RuntimeRunInspection,
  type RuntimeRunSummary,
  type RuntimeSendResult,
  type ToolApprovalRequest,
  type ToolApprovalRequestPayload,
  ToolApprovalStore,
  type Workbench,
} from '@aila/agent'
import { cleanupConversationImages, createPersistedWorkbench } from '@aila/agent-node/app'
import type { IpcMain } from 'electron'
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
  mode?: AilaExecutionMode
  loopMode?: 'continuous' | 'step'
  attachments?: ChatAttachmentInput[]
}

export interface RuntimeWorkbenchRetryLastInput {
  conversationId: string
  selection: ModelSelection
  mode?: AilaExecutionMode
}

export interface RuntimeWorkbenchCompactInput {
  conversationId: string
  selection: ModelSelection
}

export interface RuntimeWorkbenchCreateConversationInput {
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
  listConversations(): Promise<ConversationSummary[]>
  getConversation(conversationId: string): Promise<ConversationRecord>
  hydrateConversation(conversationId: string): Promise<ConversationRuntimeHydration>
  listRunCheckpoints(conversationId: string): Promise<RunCheckpoint[]>
  listRunSummaries(conversationId: string): Promise<RuntimeRunSummary[]>
  inspectRun(input: RuntimeRunControlInput): Promise<RuntimeRunInspection>
  getRunArtifact(input: RuntimeRunArtifactInput): Promise<RunArtifact>
  stepRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult>
  continueRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult>
  resumeRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult>
  abortRun(input: RuntimeRunControlInput): Promise<RunCheckpoint>
  forkRun(input: RuntimeForkRunInput): Promise<RunCheckpoint>
  listConversationRuntimeStates(): Promise<ConversationRuntimeStateSnapshot[]>
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
  let runtime: Workbench

  const toolApprovals = new ToolApprovalStore({
    timeoutMs: TOOL_APPROVAL_TIMEOUT_MS,
    recordRunEvent: async (_conversationId, event) => {
      await runtime.recordRunEvent(event)
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

  runtime = createPersistedWorkbench({
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
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.loopMode ? { loopMode: input.loopMode } : {}),
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
        workspace: input.workspace ?? null,
      })
    },
    listConversations() {
      return runtime.listConversations()
    },
    getConversation(conversationId) {
      return runtime.getConversation(conversationId)
    },
    hydrateConversation(conversationId) {
      return runtime.hydrateConversation(conversationId)
    },
    listRunCheckpoints(conversationId) {
      return runtime.listRunCheckpoints(conversationId)
    },
    listRunSummaries(conversationId) {
      return runtime.listRunSummaries(conversationId)
    },
    inspectRun(input) {
      return runtime.inspectRun(input)
    },
    getRunArtifact(input) {
      return runtime.getRunArtifact(input)
    },
    stepRun(input) {
      return runtime.stepRun(input)
    },
    continueRun(input) {
      return runtime.continueRun(input)
    },
    resumeRun(input) {
      return runtime.resumeRun(input)
    },
    abortRun(input) {
      return runtime.abortRun(input)
    },
    forkRun(input) {
      return runtime.forkRun(input)
    },
    listConversationRuntimeStates() {
      return runtime.listConversationRuntimeStates()
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
  ipc.handle('runtime:runs:list', (_event, conversationId: string) =>
    workbench.listRunCheckpoints(conversationId),
  )
  ipc.handle('runtime:runs:list-summaries', (_event, conversationId: string) =>
    workbench.listRunSummaries(conversationId),
  )
  ipc.handle('runtime:runs:inspect', (_event, request: RuntimeRunControlInput) =>
    workbench.inspectRun(request),
  )
  ipc.handle('runtime:runs:get-artifact', (_event, request: RuntimeRunArtifactInput) =>
    workbench.getRunArtifact(request),
  )
  ipc.handle('runtime:runs:step', (_event, request: RuntimeRunControlInput) =>
    workbench.stepRun(request),
  )
  ipc.handle('runtime:runs:continue', (_event, request: RuntimeRunControlInput) =>
    workbench.continueRun(request),
  )
  ipc.handle('runtime:runs:resume', (_event, request: RuntimeRunControlInput) =>
    workbench.resumeRun(request),
  )
  ipc.handle('runtime:runs:abort', (_event, request: RuntimeRunControlInput) =>
    workbench.abortRun(request),
  )
  ipc.handle('runtime:runs:fork', (_event, request: RuntimeForkRunInput) =>
    workbench.forkRun(request),
  )
  ipc.handle('runtime:conversations:list', () => workbench.listConversations())
  ipc.handle('runtime:conversations:get', (_event, conversationId: string) =>
    workbench.getConversation(conversationId),
  )
  ipc.handle(
    'runtime:conversations:create',
    (_event, input?: RuntimeWorkbenchCreateConversationInput) =>
      workbench.createConversation(input ?? {}),
  )
  ipc.handle('runtime:conversations:rename', (_event, conversationId: string, title: string) =>
    workbench.renameConversation(conversationId, title),
  )
  ipc.handle('runtime:conversations:delete', (_event, conversationId: string) =>
    workbench.deleteConversation(conversationId),
  )
  ipc.handle('runtime:conversations:list-runtime-states', () =>
    workbench.listConversationRuntimeStates(),
  )
  ipc.handle('tools:list-pending-approvals', () => workbench.listPendingApprovals())
  ipc.on('tools:approval-response', (_event, payload: { requestId: string; approved: boolean }) => {
    workbench.resolveToolApproval(payload.requestId, payload.approved)
  })
}
