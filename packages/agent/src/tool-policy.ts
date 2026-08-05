import type {
  ToolPolicyDecision,
  ToolPolicyEvaluator,
  ToolPolicyRequest,
} from './tools'

export const TOOL_APPROVAL_MODES = ['safe', 'yolo'] as const

export type ToolApprovalMode = (typeof TOOL_APPROVAL_MODES)[number]

export function isToolApprovalMode(value: unknown): value is ToolApprovalMode {
  return typeof value === 'string' && TOOL_APPROVAL_MODES.includes(value as ToolApprovalMode)
}

export function normalizeToolApprovalMode(value: unknown): ToolApprovalMode {
  return isToolApprovalMode(value) ? value : 'safe'
}

export function evaluateToolApprovalMode(
  mode: ToolApprovalMode,
  request: ToolPolicyRequest,
): ToolPolicyDecision {
  if (mode === 'yolo') return { action: 'allow', reason: 'yolo mode' }

  const metadata = request.metadata
  if (
    metadata.requiresApproval ||
    metadata.destructive ||
    metadata.access.includes('write') ||
    metadata.access.includes('shell')
  ) {
    return { action: 'ask', reason: 'safe mode' }
  }
  return { action: 'allow', reason: 'safe mode' }
}

export function createToolPolicy(mode: ToolApprovalMode = 'safe'): ToolPolicyEvaluator {
  return (request) => evaluateToolApprovalMode(mode, request)
}
