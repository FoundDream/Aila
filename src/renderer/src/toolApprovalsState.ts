import type { ToolApprovalRequestEvent } from './types'

const MAX_RESOLVED_TOMBSTONES = 500

export interface ToolApprovalsState {
  pending: ToolApprovalRequestEvent[]
  resolvedIds: ReadonlySet<string>
}

export function createToolApprovalsState(): ToolApprovalsState {
  return { pending: [], resolvedIds: new Set() }
}

function trimResolvedIds(resolvedIds: Set<string>): Set<string> {
  if (resolvedIds.size <= MAX_RESOLVED_TOMBSTONES) return resolvedIds
  return new Set(Array.from(resolvedIds).slice(-MAX_RESOLVED_TOMBSTONES))
}

export function mergeToolApprovals(
  state: ToolApprovalsState,
  incoming: ToolApprovalRequestEvent[],
): ToolApprovalsState {
  const byId = new Map(state.pending.map((request) => [request.requestId, request]))
  for (const request of incoming) {
    if (state.resolvedIds.has(request.requestId)) continue
    byId.set(request.requestId, request)
  }
  return {
    ...state,
    pending: Array.from(byId.values()).sort((a, b) => a.requestedAt - b.requestedAt),
  }
}

export function resolveToolApproval(
  state: ToolApprovalsState,
  requestId: string,
): ToolApprovalsState {
  const resolvedIds = new Set(state.resolvedIds)
  resolvedIds.delete(requestId)
  resolvedIds.add(requestId)
  return {
    pending: state.pending.filter((request) => request.requestId !== requestId),
    resolvedIds: trimResolvedIds(resolvedIds),
  }
}
