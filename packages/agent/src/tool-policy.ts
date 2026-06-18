import type {
  ToolMetadata,
  ToolPolicyDecision,
  ToolPolicyEvaluator,
  ToolPolicyRequest,
} from './tools'

export const AILA_EXECUTION_MODES = ['chat', 'plan', 'agent'] as const

export type AilaExecutionMode = (typeof AILA_EXECUTION_MODES)[number]

export const TOOL_APPROVAL_MODES = ['safe', 'yolo'] as const

export type ToolApprovalMode = (typeof TOOL_APPROVAL_MODES)[number]

export function isAilaExecutionMode(value: unknown): value is AilaExecutionMode {
  return typeof value === 'string' && AILA_EXECUTION_MODES.includes(value as AilaExecutionMode)
}

export function normalizeAilaExecutionMode(value: unknown): AilaExecutionMode {
  return isAilaExecutionMode(value) ? value : 'agent'
}

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

export function isPlanSafeToolMetadata(metadata: ToolMetadata): boolean {
  if (metadata.planSafe === true) return true
  return (
    metadata.readOnly === true &&
    metadata.destructive !== true &&
    !metadata.access.includes('write') &&
    !metadata.access.includes('shell') &&
    !metadata.access.includes('image')
  )
}

export function evaluateExecutionModeToolPolicy(
  mode: AilaExecutionMode,
  request: ToolPolicyRequest,
): ToolPolicyDecision | undefined {
  if (mode === 'agent') return undefined
  if (isPlanSafeToolMetadata(request.metadata)) return undefined
  return {
    action: 'deny',
    reason: `${mode} mode only allows read-only planning tools`,
  }
}

export function createExecutionModeToolPolicy(
  mode: AilaExecutionMode = 'agent',
  next?: ToolPolicyEvaluator,
): ToolPolicyEvaluator {
  return async (request) => {
    const executionDecision = evaluateExecutionModeToolPolicy(mode, request)
    if (executionDecision) return executionDecision
    return next?.(request)
  }
}

export function createToolPolicy(mode: ToolApprovalMode = 'safe'): ToolPolicyEvaluator {
  return (request) => evaluateToolApprovalMode(mode, request)
}
