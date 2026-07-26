import type { AgentEvent } from './agent-protocol'

type MaybePromise<T> = T | Promise<T>

export type AgentLoopRunMode = 'continuous' | 'step'
export type AgentLoopRunStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AgentLoopStepKind = 'model' | 'tool_batch' | 'compact'
export type AgentLoopStepStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type AgentLoopContinuationReason =
  | 'user'
  | 'tool_results'
  | 'retry'
  | 'steer'
  | 'resume'
  | 'provider_overflow'

export interface AgentRunIdentity {
  conversationId: string
  turnId: string
  runId: string
  parentRunId?: string
  originStepId?: string
}

export interface AgentLoopStepIdentity {
  stepId: string
  index: number
  attempt: number
  kind: AgentLoopStepKind
}

export type AgentLoopNextAction =
  | { type: 'model'; reason: AgentLoopContinuationReason }
  | { type: 'tools'; toolCallIds: string[] }
  | { type: 'compact'; reason: 'preflight' | 'provider_overflow' }
  | { type: 'pause'; reason: 'debug' | 'approval' | 'user_input' }
  | { type: 'complete' }

export interface AgentLoopStepState extends AgentLoopStepIdentity {
  status: AgentLoopStepStatus
  startedAt: number
  completedAt?: number
  error?: string
}

export interface AgentLoopState {
  identity: AgentRunIdentity
  mode: AgentLoopRunMode
  status: AgentLoopRunStatus
  startedAt?: number
  completedAt?: number
  currentStep?: AgentLoopStepState
  steps: AgentLoopStepState[]
  nextAction?: AgentLoopNextAction
  error?: string
}

export type AgentLoopTransition =
  | {
      type: 'run.started'
      timestamp: number
      identity: AgentRunIdentity
      mode: AgentLoopRunMode
    }
  | {
      type: 'run.resumed'
      timestamp: number
      identity: AgentRunIdentity
      nextAction: AgentLoopNextAction
    }
  | {
      type: 'run.paused'
      timestamp: number
      identity: AgentRunIdentity
      nextAction: AgentLoopNextAction
    }
  | {
      type: 'run.completed'
      timestamp: number
      identity: AgentRunIdentity
    }
  | {
      type: 'run.failed'
      timestamp: number
      identity: AgentRunIdentity
      error: string
    }
  | {
      type: 'run.cancelled'
      timestamp: number
      identity: AgentRunIdentity
      reason: string
    }
  | {
      type: 'step.started'
      timestamp: number
      identity: AgentRunIdentity
      step: AgentLoopStepIdentity
      nextAction: AgentLoopNextAction
    }
  | {
      type: 'step.completed'
      timestamp: number
      identity: AgentRunIdentity
      step: AgentLoopStepIdentity
      nextAction: AgentLoopNextAction
    }
  | {
      type: 'step.failed'
      timestamp: number
      identity: AgentRunIdentity
      step: AgentLoopStepIdentity
      error: string
    }
  | {
      type: 'step.cancelled'
      timestamp: number
      identity: AgentRunIdentity
      step: AgentLoopStepIdentity
      reason: string
    }

export interface AgentLoopModelStepResult<TToolCall> {
  outcome: 'completed' | 'failed' | 'cancelled'
  toolCalls: readonly TToolCall[]
  error?: string
}

export interface AgentLoopToolBatchResult {
  outcome: 'completed' | 'failed' | 'cancelled'
  error?: string
}

export type AgentLoopPolicyDecision = 'continue' | 'pause' | 'complete'

export interface AgentLoopPolicy<TToolCall> {
  mode: AgentLoopRunMode
  afterModel?: (input: {
    identity: AgentRunIdentity
    step: AgentLoopStepIdentity
    toolCalls: readonly TToolCall[]
  }) => MaybePromise<AgentLoopPolicyDecision>
  afterTools?: (input: {
    identity: AgentRunIdentity
    step: AgentLoopStepIdentity
    toolCalls: readonly TToolCall[]
  }) => MaybePromise<'continue' | 'pause'>
}

export interface RunAgentLoopOptions<TToolCall> {
  identity: AgentRunIdentity
  signal: AbortSignal
  initialSnapshot?: AgentLoopSnapshot<TToolCall>
  /** Maximum number of tool batches before one final tool-free model step. */
  maxToolSteps: number
  initialReason?: AgentLoopContinuationReason
  policy?: AgentLoopPolicy<TToolCall>
  now?: () => number
  createStepId?: (input: {
    identity: AgentRunIdentity
    index: number
    kind: AgentLoopStepKind
  }) => string
  executeModelStep: (input: {
    identity: AgentRunIdentity
    step: AgentLoopStepIdentity
    modelStepIndex: number
    toolsEnabled: boolean
    reason: AgentLoopContinuationReason
    signal: AbortSignal
  }) => Promise<AgentLoopModelStepResult<TToolCall>>
  executeToolBatch: (input: {
    identity: AgentRunIdentity
    step: AgentLoopStepIdentity
    toolCalls: readonly TToolCall[]
    signal: AbortSignal
  }) => Promise<AgentLoopToolBatchResult>
  handleToolBudgetExhausted?: (input: {
    identity: AgentRunIdentity
    step: AgentLoopStepIdentity
    toolCalls: readonly TToolCall[]
  }) => MaybePromise<void>
  onTransition?: (transition: AgentLoopTransition) => MaybePromise<void>
  onSnapshot?: (snapshot: AgentLoopSnapshot<TToolCall>) => MaybePromise<void>
}

export interface AgentLoopResult {
  state: AgentLoopState
  pendingToolCallIds?: string[]
}

/**
 * Complete serializable cursor for the loop state machine. Host-specific
 * execution data belongs in a run checkpoint, while this snapshot is enough to
 * decide and execute exactly one next action.
 */
export interface AgentLoopSnapshot<TToolCall> {
  state: AgentLoopState
  nextStepIndex: number
  modelStepIndex: number
  completedToolBatches: number
  pendingToolCalls: TToolCall[]
}

export interface AdvanceAgentLoopOptions<TToolCall> extends RunAgentLoopOptions<TToolCall> {
  snapshot?: AgentLoopSnapshot<TToolCall>
}

export interface AgentLoopAdvanceResult<TToolCall> extends AgentLoopResult {
  snapshot: AgentLoopSnapshot<TToolCall>
  executedAction?: AgentLoopNextAction
}

const CONTINUOUS_POLICY: AgentLoopPolicy<unknown> = {
  mode: 'continuous',
  afterModel: () => 'continue',
  afterTools: () => 'continue',
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

export function createAgentLoopState(
  identity: AgentRunIdentity,
  mode: AgentLoopRunMode = 'continuous',
): AgentLoopState {
  return {
    identity: cloneValue(identity),
    mode,
    status: 'idle',
    steps: [],
  }
}

export function createAgentLoopSnapshot<TToolCall>(
  identity: AgentRunIdentity,
  mode: AgentLoopRunMode = 'continuous',
): AgentLoopSnapshot<TToolCall> {
  return {
    state: createAgentLoopState(identity, mode),
    nextStepIndex: 0,
    modelStepIndex: 0,
    completedToolBatches: 0,
    pendingToolCalls: [],
  }
}

function replaceStep(
  steps: readonly AgentLoopStepState[],
  stepId: string,
  update: (step: AgentLoopStepState) => AgentLoopStepState,
): AgentLoopStepState[] {
  return steps.map((step) => (step.stepId === stepId ? update(step) : step))
}

export function reduceAgentLoopTransition(
  state: AgentLoopState,
  transition: AgentLoopTransition,
): AgentLoopState {
  if (transition.identity.runId !== state.identity.runId) return state

  switch (transition.type) {
    case 'run.started':
      return {
        ...state,
        mode: transition.mode,
        status: 'running',
        startedAt: transition.timestamp,
        completedAt: undefined,
        nextAction: { type: 'model', reason: 'user' },
        error: undefined,
      }
    case 'run.resumed':
      return {
        ...state,
        status: 'running',
        completedAt: undefined,
        currentStep: undefined,
        nextAction: cloneValue(transition.nextAction),
        error: undefined,
      }
    case 'run.paused':
      return {
        ...state,
        status: 'paused',
        currentStep: undefined,
        nextAction: cloneValue(transition.nextAction),
      }
    case 'run.completed':
      return {
        ...state,
        status: 'completed',
        completedAt: transition.timestamp,
        currentStep: undefined,
        nextAction: { type: 'complete' },
      }
    case 'run.failed':
      return {
        ...state,
        status: 'failed',
        completedAt: transition.timestamp,
        currentStep: undefined,
        error: transition.error,
      }
    case 'run.cancelled':
      return {
        ...state,
        status: 'cancelled',
        completedAt: transition.timestamp,
        currentStep: undefined,
        error: transition.reason,
      }
    case 'step.started': {
      const step: AgentLoopStepState = {
        ...cloneValue(transition.step),
        status: 'running',
        startedAt: transition.timestamp,
      }
      return {
        ...state,
        status: 'running',
        currentStep: step,
        steps: [...state.steps, step],
        nextAction: cloneValue(transition.nextAction),
      }
    }
    case 'step.completed': {
      const steps = replaceStep(state.steps, transition.step.stepId, (step) => ({
        ...step,
        status: 'completed',
        completedAt: transition.timestamp,
      }))
      return {
        ...state,
        currentStep: undefined,
        steps,
        nextAction: cloneValue(transition.nextAction),
      }
    }
    case 'step.failed': {
      const steps = replaceStep(state.steps, transition.step.stepId, (step) => ({
        ...step,
        status: 'failed',
        completedAt: transition.timestamp,
        error: transition.error,
      }))
      return {
        ...state,
        status: 'failed',
        currentStep: undefined,
        steps,
        error: transition.error,
      }
    }
    case 'step.cancelled': {
      const steps = replaceStep(state.steps, transition.step.stepId, (step) => ({
        ...step,
        status: 'cancelled',
        completedAt: transition.timestamp,
        error: transition.reason,
      }))
      return {
        ...state,
        status: 'cancelled',
        currentStep: undefined,
        steps,
        error: transition.reason,
      }
    }
  }
}

function eventString(event: AgentEvent, key: string): string | undefined {
  const value = event.data?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function eventNumber(event: AgentEvent, key: string): number | undefined {
  const value = event.data?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function eventNextAction(event: AgentEvent): AgentLoopNextAction | undefined {
  const value = event.data?.nextAction
  if (!value || typeof value !== 'object') return undefined
  return cloneValue(value as AgentLoopNextAction)
}

function transitionFromAgentEvent(event: AgentEvent): AgentLoopTransition | null {
  if (!event.runId || !event.turnId) return null
  const identity: AgentRunIdentity = {
    conversationId: event.conversationId,
    turnId: event.turnId,
    runId: event.runId,
    ...(eventString(event, 'parentRunId')
      ? { parentRunId: eventString(event, 'parentRunId') }
      : {}),
    ...(eventString(event, 'originStepId')
      ? { originStepId: eventString(event, 'originStepId') }
      : {}),
  }
  const step = (): AgentLoopStepIdentity | null => {
    if (!event.stepId) return null
    const kind = eventString(event, 'kind')
    const index = eventNumber(event, 'index')
    if ((kind !== 'model' && kind !== 'tool_batch' && kind !== 'compact') || index === undefined) {
      return null
    }
    return {
      stepId: event.stepId,
      index,
      attempt: eventNumber(event, 'attempt') ?? 1,
      kind,
    }
  }

  switch (event.type) {
    case 'run.started':
      return {
        type: 'run.started',
        timestamp: event.timestamp,
        identity,
        mode: eventString(event, 'mode') === 'step' ? 'step' : 'continuous',
      }
    case 'run.resumed':
      return {
        type: 'run.resumed',
        timestamp: event.timestamp,
        identity,
        nextAction: eventNextAction(event) ?? { type: 'model', reason: 'resume' },
      }
    case 'run.paused':
      return {
        type: 'run.paused',
        timestamp: event.timestamp,
        identity,
        nextAction: eventNextAction(event) ?? { type: 'pause', reason: 'debug' },
      }
    case 'run.completed':
      return { type: 'run.completed', timestamp: event.timestamp, identity }
    case 'run.failed':
      return {
        type: 'run.failed',
        timestamp: event.timestamp,
        identity,
        error: eventString(event, 'error') ?? 'Agent run failed',
      }
    case 'run.cancelled':
      return {
        type: 'run.cancelled',
        timestamp: event.timestamp,
        identity,
        reason: eventString(event, 'reason') ?? 'Agent run cancelled',
      }
    case 'step.started': {
      const identityStep = step()
      if (!identityStep) return null
      return {
        type: 'step.started',
        timestamp: event.timestamp,
        identity,
        step: identityStep,
        nextAction: eventNextAction(event) ?? { type: 'model', reason: 'user' },
      }
    }
    case 'step.completed': {
      const identityStep = step()
      if (!identityStep) return null
      return {
        type: 'step.completed',
        timestamp: event.timestamp,
        identity,
        step: identityStep,
        nextAction: eventNextAction(event) ?? { type: 'complete' },
      }
    }
    case 'step.failed': {
      const identityStep = step()
      if (!identityStep) return null
      return {
        type: 'step.failed',
        timestamp: event.timestamp,
        identity,
        step: identityStep,
        error: eventString(event, 'error') ?? 'Agent step failed',
      }
    }
    case 'step.cancelled': {
      const identityStep = step()
      if (!identityStep) return null
      return {
        type: 'step.cancelled',
        timestamp: event.timestamp,
        identity,
        step: identityStep,
        reason: eventString(event, 'reason') ?? 'Agent step cancelled',
      }
    }
    default:
      return null
  }
}

export function replayAgentLoopState(
  events: readonly AgentEvent[],
  runId?: string,
): AgentLoopState | null {
  const relevant = events
    .filter((event) => event.runId && (!runId || event.runId === runId))
    .slice()
    .sort((left, right) => {
      if (left.runId === right.runId && left.seq !== undefined && right.seq !== undefined) {
        return left.seq - right.seq
      }
      return left.timestamp - right.timestamp
    })
  const first = relevant.find((event) => event.runId && event.turnId)
  if (!first?.runId || !first.turnId) return null
  let state = createAgentLoopState({
    conversationId: first.conversationId,
    turnId: first.turnId,
    runId: first.runId,
    ...(eventString(first, 'parentRunId')
      ? { parentRunId: eventString(first, 'parentRunId') }
      : {}),
    ...(eventString(first, 'originStepId')
      ? { originStepId: eventString(first, 'originStepId') }
      : {}),
  })
  for (const event of relevant) {
    const transition = transitionFromAgentEvent(event)
    if (transition) state = reduceAgentLoopTransition(state, transition)
  }
  return state
}

function defaultStepId(_input: {
  identity: AgentRunIdentity
  index: number
  kind: AgentLoopStepKind
}): string {
  return globalThis.crypto.randomUUID()
}

function toolCallId(value: unknown, index: number): string {
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return `tool-${index + 1}`
}

export async function advanceAgentLoop<TToolCall>(
  options: AdvanceAgentLoopOptions<TToolCall>,
): Promise<AgentLoopAdvanceResult<TToolCall>> {
  const now = options.now ?? Date.now
  const createStepId = options.createStepId ?? defaultStepId
  const policy = (options.policy ?? CONTINUOUS_POLICY) as AgentLoopPolicy<TToolCall>
  const snapshot = options.snapshot
    ? cloneValue(options.snapshot)
    : options.initialSnapshot
      ? cloneValue(options.initialSnapshot)
      : createAgentLoopSnapshot<TToolCall>(options.identity, policy.mode)

  if (snapshot.state.identity.runId !== options.identity.runId) {
    throw new Error('agent loop snapshot runId does not match the requested run')
  }

  const emit = async (transition: AgentLoopTransition): Promise<void> => {
    snapshot.state = reduceAgentLoopTransition(snapshot.state, transition)
    await options.onTransition?.(cloneValue(transition))
    await options.onSnapshot?.(cloneValue(snapshot))
  }
  const result = (executedAction?: AgentLoopNextAction): AgentLoopAdvanceResult<TToolCall> => {
    const state = cloneValue(snapshot.state)
    const nextAction = state.nextAction
    return {
      state,
      snapshot: cloneValue(snapshot),
      ...(executedAction ? { executedAction: cloneValue(executedAction) } : {}),
      ...(nextAction?.type === 'tools' ? { pendingToolCallIds: [...nextAction.toolCallIds] } : {}),
    }
  }
  const createStep = (kind: AgentLoopStepKind): AgentLoopStepIdentity => {
    const index = snapshot.nextStepIndex
    snapshot.nextStepIndex += 1
    return {
      stepId: createStepId({ identity: options.identity, index, kind }),
      index,
      attempt: 1,
      kind,
    }
  }
  const fail = async (
    step: AgentLoopStepIdentity,
    outcome: 'failed' | 'cancelled',
    error: string,
    action: AgentLoopNextAction,
  ): Promise<AgentLoopAdvanceResult<TToolCall>> => {
    if (outcome === 'cancelled') {
      await emit({
        type: 'step.cancelled',
        timestamp: now(),
        identity: options.identity,
        step,
        reason: error,
      })
      await emit({
        type: 'run.cancelled',
        timestamp: now(),
        identity: options.identity,
        reason: error,
      })
    } else {
      await emit({
        type: 'step.failed',
        timestamp: now(),
        identity: options.identity,
        step,
        error,
      })
      await emit({
        type: 'run.failed',
        timestamp: now(),
        identity: options.identity,
        error,
      })
    }
    return result(action)
  }
  const pause = async (
    nextAction: AgentLoopNextAction,
    executedAction: AgentLoopNextAction,
  ): Promise<AgentLoopAdvanceResult<TToolCall>> => {
    await emit({
      type: 'run.paused',
      timestamp: now(),
      identity: options.identity,
      nextAction,
    })
    return result(executedAction)
  }

  if (snapshot.state.status === 'idle') {
    await emit({
      type: 'run.started',
      timestamp: now(),
      identity: options.identity,
      mode: policy.mode,
    })
  } else if (snapshot.state.status === 'paused') {
    const nextAction = snapshot.state.nextAction ?? {
      type: 'model',
      reason: 'resume',
    }
    if (nextAction.type === 'pause') return result()
    await emit({
      type: 'run.resumed',
      timestamp: now(),
      identity: options.identity,
      nextAction,
    })
  }

  if (
    snapshot.state.status === 'completed' ||
    snapshot.state.status === 'failed' ||
    snapshot.state.status === 'cancelled'
  ) {
    return result()
  }
  if (options.signal.aborted) {
    await emit({
      type: 'run.cancelled',
      timestamp: now(),
      identity: options.identity,
      reason: 'abort_signal',
    })
    return result()
  }

  const action =
    snapshot.state.nextAction ??
    ({
      type: 'model',
      reason: options.initialReason ?? 'user',
    } satisfies AgentLoopNextAction)

  if (action.type === 'complete') {
    await emit({ type: 'run.completed', timestamp: now(), identity: options.identity })
    return result(action)
  }
  if (action.type === 'pause') return pause(action, action)
  if (action.type === 'compact') {
    const message = `compact action is not configured (${action.reason})`
    const step = createStep('compact')
    await emit({
      type: 'step.started',
      timestamp: now(),
      identity: options.identity,
      step,
      nextAction: action,
    })
    return fail(step, 'failed', message, action)
  }

  if (action.type === 'model') {
    const modelStep = createStep('model')
    const modelStepIndex = snapshot.modelStepIndex
    snapshot.modelStepIndex += 1
    const toolsEnabled = snapshot.completedToolBatches < options.maxToolSteps
    await emit({
      type: 'step.started',
      timestamp: now(),
      identity: options.identity,
      step: modelStep,
      nextAction: action,
    })

    let modelResult: AgentLoopModelStepResult<TToolCall>
    try {
      modelResult = await options.executeModelStep({
        identity: options.identity,
        step: modelStep,
        modelStepIndex,
        toolsEnabled,
        reason: action.reason,
        signal: options.signal,
      })
    } catch (error) {
      return fail(
        modelStep,
        options.signal.aborted ? 'cancelled' : 'failed',
        options.signal.aborted
          ? 'abort_signal'
          : error instanceof Error
            ? error.message
            : String(error),
        action,
      )
    }
    if (modelResult.outcome !== 'completed') {
      return fail(
        modelStep,
        modelResult.outcome,
        modelResult.error ??
          (modelResult.outcome === 'cancelled' ? 'abort_signal' : 'model_step_failed'),
        action,
      )
    }

    snapshot.pendingToolCalls = [...modelResult.toolCalls].map(cloneValue)
    const toolCallIds = snapshot.pendingToolCalls.map(toolCallId)
    const nextAction: AgentLoopNextAction =
      toolCallIds.length > 0 ? { type: 'tools', toolCallIds } : { type: 'complete' }
    await emit({
      type: 'step.completed',
      timestamp: now(),
      identity: options.identity,
      step: modelStep,
      nextAction,
    })

    if (toolCallIds.length === 0) {
      await emit({ type: 'run.completed', timestamp: now(), identity: options.identity })
      return result(action)
    }
    if (!toolsEnabled) {
      await options.handleToolBudgetExhausted?.({
        identity: options.identity,
        step: modelStep,
        toolCalls: snapshot.pendingToolCalls,
      })
      snapshot.pendingToolCalls = []
      await emit({ type: 'run.completed', timestamp: now(), identity: options.identity })
      return result(action)
    }

    const decision =
      (await policy.afterModel?.({
        identity: options.identity,
        step: modelStep,
        toolCalls: snapshot.pendingToolCalls,
      })) ?? (policy.mode === 'step' ? 'pause' : 'continue')
    if (decision === 'complete') {
      await emit({ type: 'run.completed', timestamp: now(), identity: options.identity })
      return result(action)
    }
    return decision === 'pause' ? pause(nextAction, action) : result(action)
  }

  const toolStep = createStep('tool_batch')
  const toolCalls = snapshot.pendingToolCalls.map(cloneValue)
  if (toolCalls.length === 0) {
    const message = `tool action has no persisted calls: ${action.toolCallIds.join(', ')}`
    await emit({
      type: 'step.started',
      timestamp: now(),
      identity: options.identity,
      step: toolStep,
      nextAction: action,
    })
    return fail(toolStep, 'failed', message, action)
  }

  await emit({
    type: 'step.started',
    timestamp: now(),
    identity: options.identity,
    step: toolStep,
    nextAction: action,
  })
  let toolResult: AgentLoopToolBatchResult
  try {
    toolResult = await options.executeToolBatch({
      identity: options.identity,
      step: toolStep,
      toolCalls,
      signal: options.signal,
    })
  } catch (error) {
    return fail(
      toolStep,
      options.signal.aborted ? 'cancelled' : 'failed',
      options.signal.aborted
        ? 'abort_signal'
        : error instanceof Error
          ? error.message
          : String(error),
      action,
    )
  }
  if (toolResult.outcome !== 'completed') {
    return fail(
      toolStep,
      toolResult.outcome,
      toolResult.error ??
        (toolResult.outcome === 'cancelled' ? 'abort_signal' : 'tool_batch_failed'),
      action,
    )
  }

  snapshot.completedToolBatches += 1
  snapshot.pendingToolCalls = []
  const nextAction: AgentLoopNextAction = { type: 'model', reason: 'tool_results' }
  await emit({
    type: 'step.completed',
    timestamp: now(),
    identity: options.identity,
    step: toolStep,
    nextAction,
  })
  const decision =
    (await policy.afterTools?.({
      identity: options.identity,
      step: toolStep,
      toolCalls,
    })) ?? (policy.mode === 'step' ? 'pause' : 'continue')
  return decision === 'pause' ? pause(nextAction, action) : result(action)
}

export async function runAgentLoop<TToolCall>(
  options: RunAgentLoopOptions<TToolCall>,
): Promise<AgentLoopResult> {
  let snapshot =
    options.initialSnapshot ??
    createAgentLoopSnapshot<TToolCall>(options.identity, options.policy?.mode ?? 'continuous')
  snapshot = cloneValue(snapshot)
  for (;;) {
    const advanced = await advanceAgentLoop({ ...options, snapshot })
    snapshot = advanced.snapshot
    if (advanced.state.status !== 'running') {
      return {
        state: advanced.state,
        ...(advanced.pendingToolCallIds ? { pendingToolCallIds: advanced.pendingToolCallIds } : {}),
      }
    }
  }
}
