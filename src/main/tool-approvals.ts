import { randomUUID } from 'node:crypto'
import type { AgentEvent } from './agent'
import {
  appendAgentEventAndTouchConversation,
  type ConversationSummary,
  type PersistedAgentEvent,
} from './conversations'
import type { ToolApprovalRequest } from './tools'

export type ToolApprovalResolutionReason = 'user' | 'timeout' | 'shutdown' | 'cancelled'

export interface ToolApprovalRequestPayload {
  requestId: string
  name: string
  args: Record<string, unknown>
  metadata: ToolApprovalRequest['metadata']
  conversationId?: string
  messageId?: string
  toolCallId?: string
  requestedAt: number
  expiresAt: number
}

export interface ToolApprovalResolvedPayload {
  requestId: string
  approved: boolean
  reason: ToolApprovalResolutionReason
}

interface PendingToolApproval {
  payload: ToolApprovalRequestPayload
  finish: (approved: boolean, reason: ToolApprovalResolutionReason) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ToolApprovalStoreOptions {
  timeoutMs: number
  onRequest?: (payload: ToolApprovalRequestPayload) => void
  onResolved?: (payload: ToolApprovalResolvedPayload) => void
  onAgentEvent?: (event: PersistedAgentEvent) => void
  onConversationUpdated?: (summary: ConversationSummary) => void
  logger?: Pick<Console, 'warn'>
}

function previewActivityValue(value: unknown): { preview: string; size: number } {
  const text =
    typeof value === 'string' ? value : value == null ? '' : (JSON.stringify(value) ?? '')
  return {
    preview: text.length > 1000 ? `${text.slice(0, 1000)}...` : text,
    size: text.length,
  }
}

function toolRisk(req: ToolApprovalRequest): string {
  if (req.metadata.access.includes('shell')) return 'shell command'
  if (req.metadata.destructive) return 'destructive write'
  if (req.metadata.access.includes('write')) return 'writes workspace data'
  if (req.metadata.scope.includes('external')) return 'external access'
  return 'requires approval'
}

async function recordToolApprovalActivity(
  req: ToolApprovalRequest,
  requestId: string,
  state: 'requested' | 'resolved',
  callbacks: Pick<ToolApprovalStoreOptions, 'onAgentEvent' | 'onConversationUpdated' | 'logger'>,
  approved?: boolean,
  reason?: ToolApprovalResolutionReason,
): Promise<void> {
  if (!req.conversationId || !req.messageId) return

  const event: AgentEvent = {
    timestamp: Date.now(),
    conversationId: req.conversationId,
    messageId: req.messageId,
    type: state === 'requested' ? 'tool.approval.requested' : 'tool.approval.resolved',
    data: {
      requestId,
      toolName: req.name,
      ...(req.toolCallId && { toolCallId: req.toolCallId }),
      ...(state === 'requested'
        ? {
            risk: toolRisk(req),
            args: previewActivityValue(req.args),
            destructive: req.metadata.destructive,
            access: req.metadata.access,
            scope: req.metadata.scope,
          }
        : {
            approved: approved === true,
            reason: reason ?? 'user',
          }),
    },
  }

  try {
    const { event: persisted, summary } = await appendAgentEventAndTouchConversation(
      req.conversationId,
      event,
    )
    callbacks.onAgentEvent?.(persisted)
    if (summary) callbacks.onConversationUpdated?.(summary)
  } catch (error) {
    callbacks.logger?.warn('[activity] tool approval event append failed:', error)
  }
}

export class ToolApprovalStore {
  private readonly pending = new Map<string, PendingToolApproval>()
  private activityChain = Promise.resolve()

  constructor(private readonly options: ToolApprovalStoreOptions) {}

  request(req: ToolApprovalRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const requestId = randomUUID()
      const requestedAt = Date.now()
      const payload: ToolApprovalRequestPayload = {
        requestId,
        name: req.name,
        args: req.args,
        metadata: req.metadata,
        ...(req.conversationId && { conversationId: req.conversationId }),
        ...(req.messageId && { messageId: req.messageId }),
        ...(req.toolCallId && { toolCallId: req.toolCallId }),
        requestedAt,
        expiresAt: requestedAt + this.options.timeoutMs,
      }

      this.recordActivity(req, requestId, 'requested')
      const finish = (approved: boolean, reason: ToolApprovalResolutionReason): void => {
        if (!this.pending.delete(requestId)) return
        clearTimeout(timer)
        this.recordActivity(req, requestId, 'resolved', approved, reason)
        this.options.onResolved?.({ requestId, approved, reason })
        resolve(approved)
      }
      const timer = setTimeout(() => {
        finish(false, 'timeout')
      }, this.options.timeoutMs)
      this.pending.set(requestId, { payload, finish, timer })
      this.options.onRequest?.(payload)
    })
  }

  list(): ToolApprovalRequestPayload[] {
    return Array.from(this.pending.values())
      .map((pending) => pending.payload)
      .sort((a, b) => a.requestedAt - b.requestedAt)
  }

  resolve(requestId: string, approved: boolean, reason: ToolApprovalResolutionReason): void {
    this.pending.get(requestId)?.finish(approved, reason)
  }

  resolveForConversation(
    conversationId: string,
    approved: boolean,
    reason: ToolApprovalResolutionReason,
  ): number {
    let resolved = 0
    for (const pending of Array.from(this.pending.values())) {
      if (pending.payload.conversationId !== conversationId) continue
      pending.finish(approved, reason)
      resolved += 1
    }
    return resolved
  }

  shutdown(): void {
    for (const requestId of Array.from(this.pending.keys())) {
      this.resolve(requestId, false, 'shutdown')
    }
  }

  async flushActivity(): Promise<void> {
    await this.activityChain
  }

  private recordActivity(
    req: ToolApprovalRequest,
    requestId: string,
    state: 'requested' | 'resolved',
    approved?: boolean,
    reason?: ToolApprovalResolutionReason,
  ): void {
    this.activityChain = this.activityChain
      .then(() => recordToolApprovalActivity(req, requestId, state, this.options, approved, reason))
      .catch((error) => {
        this.options.logger?.warn('[activity] tool approval event append failed:', error)
      })
  }
}
