import type { RunEvent } from './agent-protocol'
import { summarizeToolTarget, type ToolApprovalRequest } from './tools'

export type ToolApprovalResolutionReason = 'user' | 'timeout' | 'shutdown' | 'cancelled'

export interface ToolApprovalRequestPayload {
  requestId: string
  name: string
  args: Record<string, unknown>
  metadata: ToolApprovalRequest['metadata']
  conversationId?: string
  messageId?: string
  turnId?: string
  runId?: string
  stepId?: string
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

type MaybePromise<T> = T | Promise<T>
export type ToolApprovalIdFactory = () => string

export type ToolApprovalActivityRecorder = (
  conversationId: string,
  event: RunEvent,
) => MaybePromise<unknown>

export interface ToolApprovalStoreOptions {
  timeoutMs: number
  createId?: ToolApprovalIdFactory
  recordRunEvent?: ToolApprovalActivityRecorder
  onRequest?: (payload: ToolApprovalRequestPayload) => void
  onResolved?: (payload: ToolApprovalResolvedPayload) => void
  logger?: Pick<Console, 'warn'>
}

export interface ImmediateToolApprovalActivityInput {
  request: ToolApprovalRequest
  approve: (request: ToolApprovalRequest) => MaybePromise<boolean>
  createId?: ToolApprovalIdFactory
  recordRunEvent?: ToolApprovalActivityRecorder
  logger?: Pick<Console, 'warn'>
}

function createApprovalId(): string {
  const cryptoLike = (
    globalThis as typeof globalThis & {
      crypto?: { randomUUID?: () => string }
    }
  ).crypto
  return (
    cryptoLike?.randomUUID?.() ??
    `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

function cloneApprovalValue<T>(value: T): T {
  return structuredClone(value)
}

function cloneToolApprovalRequest(req: ToolApprovalRequest): ToolApprovalRequest {
  return {
    ...req,
    args: cloneApprovalValue(req.args),
    metadata: cloneApprovalValue(req.metadata),
  }
}

function cloneToolApprovalRequestPayload(
  payload: ToolApprovalRequestPayload,
): ToolApprovalRequestPayload {
  return cloneApprovalValue(payload)
}

function cloneToolApprovalResolvedPayload(
  payload: ToolApprovalResolvedPayload,
): ToolApprovalResolvedPayload {
  return cloneApprovalValue(payload)
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
  callbacks: Pick<ToolApprovalStoreOptions, 'recordRunEvent' | 'logger'>,
  approved?: boolean,
  reason?: ToolApprovalResolutionReason,
): Promise<void> {
  if (!req.conversationId || !req.messageId) return
  const target = summarizeToolTarget(req.name, req.args)

  const event: RunEvent = {
    timestamp: Date.now(),
    conversationId: req.conversationId,
    messageId: req.messageId,
    ...(req.turnId && { turnId: req.turnId }),
    ...(req.runId && { runId: req.runId }),
    ...(req.stepId && { stepId: req.stepId }),
    type: state === 'requested' ? 'tool.approval.requested' : 'tool.approval.resolved',
    data: {
      requestId,
      toolName: req.name,
      ...(req.toolCallId && { toolCallId: req.toolCallId }),
      ...(state === 'requested'
        ? {
            risk: toolRisk(req),
            args: previewActivityValue(req.args),
            ...(target && { target }),
            destructive: req.metadata.destructive,
            access: [...req.metadata.access],
            scope: [...req.metadata.scope],
          }
        : {
            approved: approved === true,
            reason: reason ?? 'user',
          }),
    },
  }

  try {
    await callbacks.recordRunEvent?.(req.conversationId, event)
  } catch (error) {
    callbacks.logger?.warn('[activity] tool approval event append failed:', error)
  }
}

export async function requestToolApprovalWithActivity(
  input: ImmediateToolApprovalActivityInput,
): Promise<boolean> {
  const request = cloneToolApprovalRequest(input.request)
  const requestId = (input.createId ?? createApprovalId)()
  await recordToolApprovalActivity(request, requestId, 'requested', input)
  try {
    const approved = (await input.approve(cloneToolApprovalRequest(request))) === true
    await recordToolApprovalActivity(request, requestId, 'resolved', input, approved, 'user')
    return approved
  } catch (error) {
    await recordToolApprovalActivity(request, requestId, 'resolved', input, false, 'cancelled')
    throw error
  }
}

export class ToolApprovalStore {
  private readonly pending = new Map<string, PendingToolApproval>()
  private activityChain = Promise.resolve()

  constructor(private readonly options: ToolApprovalStoreOptions) {}

  request(req: ToolApprovalRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const request = cloneToolApprovalRequest(req)
      const requestId = (this.options.createId ?? createApprovalId)()
      const requestedAt = Date.now()
      const payload: ToolApprovalRequestPayload = {
        requestId,
        name: request.name,
        args: cloneApprovalValue(request.args),
        metadata: cloneApprovalValue(request.metadata),
        ...(request.conversationId && { conversationId: request.conversationId }),
        ...(request.messageId && { messageId: request.messageId }),
        ...(request.turnId && { turnId: request.turnId }),
        ...(request.runId && { runId: request.runId }),
        ...(request.stepId && { stepId: request.stepId }),
        ...(request.toolCallId && { toolCallId: request.toolCallId }),
        requestedAt,
        expiresAt: requestedAt + this.options.timeoutMs,
      }

      this.recordActivity(request, requestId, 'requested')
      const finish = (approved: boolean, reason: ToolApprovalResolutionReason): void => {
        if (!this.pending.delete(requestId)) return
        clearTimeout(timer)
        this.recordActivity(request, requestId, 'resolved', approved, reason)
        this.options.onResolved?.(cloneToolApprovalResolvedPayload({ requestId, approved, reason }))
        resolve(approved)
      }
      const timer = setTimeout(() => {
        finish(false, 'timeout')
      }, this.options.timeoutMs)
      this.pending.set(requestId, {
        payload: cloneToolApprovalRequestPayload(payload),
        finish,
        timer,
      })
      this.options.onRequest?.(cloneToolApprovalRequestPayload(payload))
    })
  }

  list(): ToolApprovalRequestPayload[] {
    return Array.from(this.pending.values())
      .map((pending) => cloneToolApprovalRequestPayload(pending.payload))
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

  async shutdown(): Promise<void> {
    for (const requestId of Array.from(this.pending.keys())) {
      this.resolve(requestId, false, 'shutdown')
    }
    await this.flushActivity()
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
