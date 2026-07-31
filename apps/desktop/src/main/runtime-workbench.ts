import {
  type ActiveAssistantTurn,
  type BlobGarbageCollectionResult,
  type ConversationRecord,
  type ConversationRuntimeHydration,
  type ConversationRuntimeStateSnapshot,
  type ConversationSummary,
  type PersistedMessage,
  type RunPayload,
  type RunSnapshot,
  type RuntimeCompactConversationInput,
  type RuntimeCompactConversationResult,
  type RuntimeCreateConversationInput,
  type RuntimeForkRunInput,
  type RuntimeForkSessionInput,
  type RuntimeNavigateSessionInput,
  type RuntimeRetryLastInput,
  type RuntimeRunControlInput,
  type RuntimeRunInspection,
  type RuntimeRunPayloadInput,
  type RuntimeRunSummary,
  type RuntimeSendInput,
  type RuntimeSendResult,
  type RuntimeSessionAvailability,
  type SessionTree,
  type ToolApprovalRequest,
  type ToolApprovalRequestPayload,
  ToolApprovalStore,
  type Workbench,
} from '@aila/agent'
import { createPersistedWorkbench } from '@aila/agent-node/app'
import type { IpcMain } from 'electron'
import {
  buildDesktopWorkspaceContextFromRecord,
  getDesktopShellCwd,
  getDesktopWorkspaceRoots,
} from './workspace-context'

const TOOL_APPROVAL_TIMEOUT_MS = 60_000

type DesktopRuntimeEmitter = (channel: string, data?: unknown) => void

// The append input is deliberately narrower than the agent's session-custom
// input: namespace and version are pinned host-side.
export interface RuntimeWorkbenchAppendMessageInput {
  conversationId: string
  message: PersistedMessage
}

export interface RuntimeWorkbenchReloadResult {
  toolCount: number
}

export interface DesktopRuntimeWorkbench {
  send(input: RuntimeSendInput): Promise<RuntimeSendResult>
  retryLastUserMessage(input: RuntimeRetryLastInput): Promise<RuntimeSendResult>
  appendPlaygroundMessage(input: RuntimeWorkbenchAppendMessageInput): Promise<string>
  compactConversation(
    input: RuntimeCompactConversationInput,
  ): Promise<RuntimeCompactConversationResult>
  abort(conversationId: string): Promise<void>
  listActiveTurns(): ActiveAssistantTurn[]
  recoverInterruptedActivities(reason?: string): Promise<ConversationSummary[]>
  shutdown(): Promise<void>
  reloadExtensions(): Promise<RuntimeWorkbenchReloadResult>

  createConversation(input?: RuntimeCreateConversationInput): Promise<ConversationSummary>
  listConversations(): Promise<ConversationSummary[]>
  getConversation(conversationId: string): Promise<ConversationRecord>
  getSessionTree(conversationId: string): Promise<SessionTree>
  getAvailability(conversationId: string): Promise<RuntimeSessionAvailability>
  navigateSession(input: RuntimeNavigateSessionInput): Promise<ConversationRecord>
  forkSession(input: RuntimeForkSessionInput): Promise<ConversationSummary>
  collectSessionGarbage(conversationId: string): Promise<BlobGarbageCollectionResult>
  hydrateConversation(conversationId: string): Promise<ConversationRuntimeHydration>
  listRunSnapshots(conversationId: string): Promise<RunSnapshot[]>
  listRunSummaries(conversationId: string): Promise<RuntimeRunSummary[]>
  inspectRun(input: RuntimeRunControlInput): Promise<RuntimeRunInspection>
  getRunPayload(input: RuntimeRunPayloadInput): Promise<RunPayload>
  stepRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult>
  continueRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult>
  resumeRun(input: RuntimeRunControlInput): Promise<RuntimeSendResult>
  abortRun(input: RuntimeRunControlInput): Promise<RunSnapshot>
  forkRun(input: RuntimeForkRunInput): Promise<RunSnapshot>
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
      loadTransientContext: ({ record }) => buildDesktopWorkspaceContextFromRecord(record),
      workspaceRoots: getDesktopWorkspaceRoots,
      shellCwd: getDesktopShellCwd,
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
        ...(input.transientContext ? { transientContext: input.transientContext } : {}),
      })
    },
    retryLastUserMessage(input) {
      return runtime.retryLastUserMessage(input)
    },
    appendPlaygroundMessage(input) {
      // Namespace is pinned host-side so the renderer cannot write foreign extension entries.
      return runtime.appendSessionCustomMessage({
        conversationId: input.conversationId,
        namespace: 'aila.playground',
        version: 1,
        message: input.message,
      })
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
      const registry = await runtime.reloadTools()
      return {
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
    getSessionTree(conversationId) {
      return runtime.getSessionTree(conversationId)
    },
    getAvailability(conversationId) {
      return runtime.getAvailability(conversationId)
    },
    navigateSession(input) {
      return runtime.navigateSession(input)
    },
    forkSession(input) {
      return runtime.forkSession(input)
    },
    collectSessionGarbage(conversationId) {
      return runtime.collectSessionGarbage(conversationId)
    },
    hydrateConversation(conversationId) {
      return runtime.hydrateConversation(conversationId)
    },
    listRunSnapshots(conversationId) {
      return runtime.listRunSnapshots(conversationId)
    },
    listRunSummaries(conversationId) {
      return runtime.listRunSummaries(conversationId)
    },
    inspectRun(input) {
      return runtime.inspectRun(input)
    },
    getRunPayload(input) {
      return runtime.getRunPayload(input)
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
  ipc.handle('runtime:send', (_event, request: RuntimeSendInput) => workbench.send(request))
  ipc.handle('runtime:retry-last', (_event, request: RuntimeRetryLastInput) =>
    workbench.retryLastUserMessage(request),
  )
  ipc.handle('runtime:messages:append', (_event, request: RuntimeWorkbenchAppendMessageInput) =>
    workbench.appendPlaygroundMessage(request),
  )
  ipc.handle('runtime:compact-conversation', (_event, request: RuntimeCompactConversationInput) =>
    workbench.compactConversation(request),
  )
  ipc.handle('runtime:abort', (_event, conversationId: string) => workbench.abort(conversationId))
  ipc.handle('runtime:list-active-turns', () => workbench.listActiveTurns())
  ipc.handle('runtime:hydrate-conversation', (_event, conversationId: string) =>
    workbench.hydrateConversation(conversationId),
  )
  ipc.handle('runtime:sessions:tree', (_event, conversationId: string) =>
    workbench.getSessionTree(conversationId),
  )
  ipc.handle('runtime:availability:get', (_event, conversationId: string) =>
    workbench.getAvailability(conversationId),
  )
  ipc.handle('runtime:sessions:navigate', (_event, request: RuntimeNavigateSessionInput) =>
    workbench.navigateSession(request),
  )
  ipc.handle('runtime:sessions:fork', (_event, request: RuntimeForkSessionInput) =>
    workbench.forkSession(request),
  )
  ipc.handle('runtime:sessions:collect-garbage', (_event, conversationId: string) =>
    workbench.collectSessionGarbage(conversationId),
  )
  ipc.handle('runtime:runs:list', (_event, conversationId: string) =>
    workbench.listRunSnapshots(conversationId),
  )
  ipc.handle('runtime:runs:list-summaries', (_event, conversationId: string) =>
    workbench.listRunSummaries(conversationId),
  )
  ipc.handle('runtime:runs:inspect', (_event, request: RuntimeRunControlInput) =>
    workbench.inspectRun(request),
  )
  ipc.handle('runtime:runs:get-payload', (_event, request: RuntimeRunPayloadInput) =>
    workbench.getRunPayload(request),
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
  ipc.handle('runtime:conversations:create', (_event, input?: RuntimeCreateConversationInput) =>
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
