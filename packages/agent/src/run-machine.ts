import type { RunEvent } from './agent-protocol'
import type { ModelCallToolCall } from './model-call'

type MaybePromise<T> = T | Promise<T>

export type RunMode = 'continuous' | 'step'
export type RunStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export type RunStepKind = 'model' | 'tool' | 'compact'
export type RunStepStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type RunContinuationReason =
  | 'user'
  | 'tool_results'
  | 'retry'
  | 'steer'
  | 'follow_up'
  | 'resume'
  | 'provider_overflow'

export interface RunIdentity {
  conversationId: string
  turnId: string
  runId: string
  parentRunId?: string
  originStepId?: string
}

export interface RunStep {
  stepId: string
  index: number
  attempt: number
  kind: RunStepKind
  toolCallId?: string
}

export type RunNextAction =
  | { type: 'model'; reason: RunContinuationReason }
  | { type: 'tools'; toolCallIds: string[] }
  | { type: 'compact'; reason: 'preflight' | 'provider_overflow' }
  | { type: 'finalize'; outcome: 'completed' | 'failed' | 'cancelled'; error?: string }

export type RunWaitReason = 'operator' | 'approval' | 'user_input'

export interface RunWait {
  reason: RunWaitReason
  requestId?: string
  detail?: string
}

export interface RunStepState extends RunStep {
  status: RunStepStatus
  startedAt: number
  completedAt?: number
  error?: string
}

export interface RunState {
  identity: RunIdentity
  mode: RunMode
  status: RunStatus
  startedAt?: number
  completedAt?: number
  currentStep?: RunStepState
  steps: RunStepState[]
  nextAction?: RunNextAction
  wait?: RunWait
  error?: string
}

export type RunTransition =
  | {
      type: 'run.started'
      timestamp: number
      identity: RunIdentity
      mode: RunMode
    }
  | {
      type: 'run.resumed'
      timestamp: number
      identity: RunIdentity
      nextAction: RunNextAction
    }
  | {
      type: 'run.paused'
      timestamp: number
      identity: RunIdentity
      nextAction: RunNextAction
      wait: RunWait
    }
  | {
      type: 'run.completed'
      timestamp: number
      identity: RunIdentity
    }
  | {
      type: 'run.failed'
      timestamp: number
      identity: RunIdentity
      error: string
    }
  | {
      type: 'run.cancelled'
      timestamp: number
      identity: RunIdentity
      reason: string
    }
  | {
      type: 'step.started'
      timestamp: number
      identity: RunIdentity
      step: RunStep
      nextAction: RunNextAction
    }
  | {
      type: 'step.completed'
      timestamp: number
      identity: RunIdentity
      step: RunStep
      nextAction?: RunNextAction
    }
  | {
      type: 'step.failed'
      timestamp: number
      identity: RunIdentity
      step: RunStep
      error: string
      nextAction?: RunNextAction
    }
  | {
      type: 'step.cancelled'
      timestamp: number
      identity: RunIdentity
      step: RunStep
      reason: string
      nextAction?: RunNextAction
    }

export interface RunModelResult {
  outcome: 'completed' | 'failed' | 'cancelled'
  toolCalls: readonly ModelCallToolCall[]
  error?: string
  nextAction?: Extract<RunNextAction, { type: 'compact' }>
}

export interface RunToolStepResult {
  outcome: 'completed' | 'failed' | 'cancelled'
  error?: string
}

export interface RunToolPreparation {
  outcome: 'ready' | 'rejected'
  error?: string
}

export interface RunCompactResult {
  outcome: 'completed' | 'failed' | 'cancelled'
  error?: string
}

export type RunPolicyDecision = 'continue' | 'pause' | 'complete'

export interface RunPolicy {
  mode: RunMode
  afterModel?: (input: {
    identity: RunIdentity
    step: RunStep
    toolCalls: readonly ModelCallToolCall[]
  }) => MaybePromise<RunPolicyDecision>
  afterTools?: (input: {
    identity: RunIdentity
    step: RunStep
    toolCalls: readonly ModelCallToolCall[]
  }) => MaybePromise<'continue' | 'pause'>
}

export interface RunMachineOptions {
  identity: RunIdentity
  signal: AbortSignal
  initialSnapshot?: RunCursor
  /** Maximum number of tool batches before one final tool-free model step. */
  maxToolSteps: number
  initialReason?: RunContinuationReason
  policy?: RunPolicy
  now?: () => number
  createStepId?: (input: { identity: RunIdentity; index: number; kind: RunStepKind }) => string
  prepareModelStep?: (input: {
    identity: RunIdentity
    modelStepIndex: number
    toolsEnabled: boolean
    reason: RunContinuationReason
    signal: AbortSignal
  }) => MaybePromise<void>
  executeModelStep: (input: {
    identity: RunIdentity
    step: RunStep
    modelStepIndex: number
    toolsEnabled: boolean
    reason: RunContinuationReason
    signal: AbortSignal
  }) => Promise<RunModelResult>
  prepareToolStep?: (input: {
    identity: RunIdentity
    toolCall: ModelCallToolCall
    toolCallIndex: number
    toolCallCount: number
    modelStepIndex: number
    signal: AbortSignal
    waitFor<T>(wait: RunWait, operation: () => Promise<T>): Promise<T>
  }) => Promise<RunToolPreparation>
  executeToolStep: (input: {
    identity: RunIdentity
    step: RunStep
    toolCall: ModelCallToolCall
    toolCallIndex: number
    toolCallCount: number
    modelStepIndex: number
    preparation: RunToolPreparation
    signal: AbortSignal
  }) => Promise<RunToolStepResult>
  executeCompactStep?: (input: {
    identity: RunIdentity
    step: RunStep
    reason: 'preflight' | 'provider_overflow'
    signal: AbortSignal
  }) => Promise<RunCompactResult>
  handleToolBudgetExhausted?: (input: {
    identity: RunIdentity
    step: RunStep
    toolCalls: readonly ModelCallToolCall[]
  }) => MaybePromise<void>
  onTransition?: (transition: RunTransition) => MaybePromise<void>
  onSnapshot?: (snapshot: RunCursor) => MaybePromise<void>
}

export interface RunMachineResult {
  state: RunState
  pendingToolCallIds?: string[]
}

/**
 * Complete serializable cursor for the loop state machine. Host-specific
 * execution data belongs in a run checkpoint, while this snapshot is enough to
 * decide and execute exactly one next action.
 */
export interface RunCursor {
  state: RunState
  nextStepIndex: number
  modelStepIndex: number
  completedToolBatches: number
  pendingToolCalls: ModelCallToolCall[]
  /** Original calls for the active model response; retained while calls complete one by one. */
  toolBatchCalls?: ModelCallToolCall[]
}

export interface AdvanceRunOptions extends RunMachineOptions {
  snapshot?: RunCursor
}

export interface AdvanceRunResult extends RunMachineResult {
  snapshot: RunCursor
  executedAction?: RunNextAction
}

const CONTINUOUS_POLICY: RunPolicy = {
  mode: 'continuous',
  afterModel: () => 'continue',
  afterTools: () => 'continue',
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

export function createRunState(identity: RunIdentity, mode: RunMode = 'continuous'): RunState {
  return {
    identity: cloneValue(identity),
    mode,
    status: 'idle',
    steps: [],
  }
}

export function createRunCursor(identity: RunIdentity, mode: RunMode = 'continuous'): RunCursor {
  return {
    state: createRunState(identity, mode),
    nextStepIndex: 0,
    modelStepIndex: 0,
    completedToolBatches: 0,
    pendingToolCalls: [],
    toolBatchCalls: [],
  }
}

function replaceStep(
  steps: readonly RunStepState[],
  stepId: string,
  update: (step: RunStepState) => RunStepState,
): RunStepState[] {
  return steps.map((step) => (step.stepId === stepId ? update(step) : step))
}

export function reduceRunTransition(state: RunState, transition: RunTransition): RunState {
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
        wait: undefined,
        error: undefined,
      }
    case 'run.resumed':
      return {
        ...state,
        status: 'running',
        completedAt: undefined,
        currentStep: undefined,
        nextAction: cloneValue(transition.nextAction),
        wait: undefined,
        error: undefined,
      }
    case 'run.paused':
      return {
        ...state,
        status: 'paused',
        currentStep: undefined,
        nextAction: cloneValue(transition.nextAction),
        wait: cloneValue(transition.wait),
      }
    case 'run.completed':
      return {
        ...state,
        status: 'completed',
        completedAt: transition.timestamp,
        currentStep: undefined,
        nextAction: undefined,
        wait: undefined,
      }
    case 'run.failed':
      return {
        ...state,
        status: 'failed',
        completedAt: transition.timestamp,
        currentStep: undefined,
        nextAction: undefined,
        wait: undefined,
        error: transition.error,
      }
    case 'run.cancelled':
      return {
        ...state,
        status: 'cancelled',
        completedAt: transition.timestamp,
        currentStep: undefined,
        nextAction: undefined,
        wait: undefined,
        error: transition.reason,
      }
    case 'step.started': {
      const step: RunStepState = {
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
        wait: undefined,
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
        status: transition.nextAction ? 'running' : 'completed',
        completedAt: transition.nextAction ? undefined : transition.timestamp,
        currentStep: undefined,
        steps,
        nextAction: transition.nextAction ? cloneValue(transition.nextAction) : undefined,
        wait: undefined,
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
        status: transition.nextAction ? 'running' : 'failed',
        currentStep: undefined,
        steps,
        nextAction: transition.nextAction ? cloneValue(transition.nextAction) : undefined,
        wait: undefined,
        error: transition.nextAction ? undefined : transition.error,
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
        status: transition.nextAction ? 'running' : 'cancelled',
        currentStep: undefined,
        steps,
        nextAction: transition.nextAction ? cloneValue(transition.nextAction) : undefined,
        wait: undefined,
        error: transition.nextAction ? undefined : transition.reason,
      }
    }
  }
}

function eventString(event: RunEvent, key: string): string | undefined {
  const value = event.data?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function eventNumber(event: RunEvent, key: string): number | undefined {
  const value = event.data?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function eventNextAction(event: RunEvent): RunNextAction | undefined {
  const value = event.data?.nextAction
  if (!value || typeof value !== 'object') return undefined
  const type = (value as { type?: unknown }).type
  if (type !== 'model' && type !== 'tools' && type !== 'compact' && type !== 'finalize') {
    return undefined
  }
  return cloneValue(value as RunNextAction)
}

function eventWaitState(event: RunEvent): RunWait {
  const value = event.data?.wait
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const reason = record.reason
    if (reason === 'operator' || reason === 'approval' || reason === 'user_input') {
      return {
        reason,
        ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
        ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
      }
    }
  }
  return { reason: 'operator' }
}

function transitionFromRunEvent(event: RunEvent): RunTransition | null {
  if (!event.runId || !event.turnId) return null
  const identity: RunIdentity = {
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
  const step = (): RunStep | null => {
    if (!event.stepId) return null
    const kind = eventString(event, 'kind')
    const index = eventNumber(event, 'index')
    if ((kind !== 'model' && kind !== 'tool' && kind !== 'compact') || index === undefined) {
      return null
    }
    return {
      stepId: event.stepId,
      index,
      attempt: eventNumber(event, 'attempt') ?? 1,
      kind,
      ...(eventString(event, 'toolCallId') ? { toolCallId: eventString(event, 'toolCallId') } : {}),
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
        nextAction: eventNextAction(event) ?? { type: 'model', reason: 'resume' },
        wait: eventWaitState(event),
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
        nextAction: eventNextAction(event),
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
        nextAction: eventNextAction(event),
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
        nextAction: eventNextAction(event),
      }
    }
    default:
      return null
  }
}

export function replayRunState(events: readonly RunEvent[], runId?: string): RunState | null {
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
  let state = createRunState({
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
    const transition = transitionFromRunEvent(event)
    if (transition) state = reduceRunTransition(state, transition)
  }
  return state
}

function defaultStepId(_input: {
  identity: RunIdentity
  index: number
  kind: RunStepKind
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

export function assertRunStateInvariant(state: RunState): void {
  const terminal =
    state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled'
  if (terminal && (state.nextAction !== undefined || state.wait !== undefined)) {
    throw new Error(`terminal agent run "${state.identity.runId}" cannot retain work`)
  }
  if (state.status === 'paused' && (!state.nextAction || !state.wait)) {
    throw new Error(`paused agent run "${state.identity.runId}" requires action and wait state`)
  }
  if (state.status === 'running' && !state.nextAction) {
    throw new Error(`running agent run "${state.identity.runId}" requires a next action`)
  }
  if (state.status !== 'paused' && state.wait !== undefined) {
    throw new Error(`agent run "${state.identity.runId}" can wait only while paused`)
  }
}

export async function advanceRun(options: AdvanceRunOptions): Promise<AdvanceRunResult> {
  const now = options.now ?? Date.now
  const createStepId = options.createStepId ?? defaultStepId
  const policy = (options.policy ?? CONTINUOUS_POLICY) as RunPolicy
  const snapshot = options.snapshot
    ? cloneValue(options.snapshot)
    : options.initialSnapshot
      ? cloneValue(options.initialSnapshot)
      : createRunCursor(options.identity, policy.mode)

  if (snapshot.state.identity.runId !== options.identity.runId) {
    throw new Error('run cursor runId does not match the requested run')
  }

  const emit = async (transition: RunTransition): Promise<void> => {
    snapshot.state = reduceRunTransition(snapshot.state, transition)
    assertRunStateInvariant(snapshot.state)
    await options.onTransition?.(cloneValue(transition))
    await options.onSnapshot?.(cloneValue(snapshot))
  }
  const result = (executedAction?: RunNextAction): AdvanceRunResult => {
    const state = cloneValue(snapshot.state)
    const nextAction = state.nextAction
    return {
      state,
      snapshot: cloneValue(snapshot),
      ...(executedAction ? { executedAction: cloneValue(executedAction) } : {}),
      ...(nextAction?.type === 'tools' ? { pendingToolCallIds: [...nextAction.toolCallIds] } : {}),
    }
  }
  snapshot.toolBatchCalls ??= snapshot.pendingToolCalls.map(cloneValue)
  const createStep = (kind: RunStepKind, toolCallIdentity?: string): RunStep => {
    const index = snapshot.nextStepIndex
    snapshot.nextStepIndex += 1
    return {
      stepId: createStepId({ identity: options.identity, index, kind }),
      index,
      attempt: 1,
      kind,
      ...(toolCallIdentity ? { toolCallId: toolCallIdentity } : {}),
    }
  }
  const fail = async (
    step: RunStep,
    outcome: 'failed' | 'cancelled',
    error: string,
    action: RunNextAction,
  ): Promise<AdvanceRunResult> => {
    const nextAction: RunNextAction = { type: 'finalize', outcome, error }
    if (outcome === 'cancelled') {
      await emit({
        type: 'step.cancelled',
        timestamp: now(),
        identity: options.identity,
        step,
        reason: error,
        nextAction,
      })
    } else {
      await emit({
        type: 'step.failed',
        timestamp: now(),
        identity: options.identity,
        step,
        error,
        nextAction,
      })
    }
    return result(action)
  }
  const pause = async (
    nextAction: RunNextAction,
    executedAction: RunNextAction,
    wait: RunWait = { reason: 'operator' },
  ): Promise<AdvanceRunResult> => {
    await emit({
      type: 'run.paused',
      timestamp: now(),
      identity: options.identity,
      nextAction,
      wait,
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
    const nextAction = snapshot.state.nextAction
    if (!nextAction) throw new Error('paused agent run is missing its next action')
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
  const action = snapshot.state.nextAction
  if (!action) throw new Error('running agent run is missing its next action')
  if (action.type === 'finalize') {
    if (action.outcome === 'completed') {
      await emit({ type: 'run.completed', timestamp: now(), identity: options.identity })
    } else if (action.outcome === 'cancelled') {
      await emit({
        type: 'run.cancelled',
        timestamp: now(),
        identity: options.identity,
        reason: action.error ?? 'Agent run cancelled',
      })
    } else {
      await emit({
        type: 'run.failed',
        timestamp: now(),
        identity: options.identity,
        error: action.error ?? 'Agent run failed',
      })
    }
    return result(action)
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

  if (action.type === 'compact') {
    const step = createStep('compact')
    await emit({
      type: 'step.started',
      timestamp: now(),
      identity: options.identity,
      step,
      nextAction: action,
    })
    if (!options.executeCompactStep) {
      return fail(step, 'failed', `compact action is not configured (${action.reason})`, action)
    }
    let compactResult: RunCompactResult
    try {
      compactResult = await options.executeCompactStep({
        identity: options.identity,
        step,
        reason: action.reason,
        signal: options.signal,
      })
    } catch (error) {
      return fail(
        step,
        options.signal.aborted ? 'cancelled' : 'failed',
        options.signal.aborted
          ? 'abort_signal'
          : error instanceof Error
            ? error.message
            : String(error),
        action,
      )
    }
    if (compactResult.outcome !== 'completed') {
      return fail(
        step,
        compactResult.outcome,
        compactResult.error ??
          (compactResult.outcome === 'cancelled' ? 'abort_signal' : 'compact_step_failed'),
        action,
      )
    }
    const nextAction: RunNextAction = {
      type: 'model',
      reason: action.reason === 'provider_overflow' ? 'provider_overflow' : 'resume',
    }
    await emit({
      type: 'step.completed',
      timestamp: now(),
      identity: options.identity,
      step,
      nextAction,
    })
    return policy.mode === 'step' ? pause(nextAction, action) : result(action)
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

    let modelResult: RunModelResult
    try {
      await options.prepareModelStep?.({
        identity: options.identity,
        modelStepIndex,
        toolsEnabled,
        reason: action.reason,
        signal: options.signal,
      })
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
      if (
        modelResult.outcome === 'failed' &&
        modelResult.nextAction?.type === 'compact' &&
        !snapshot.state.steps.some((step) => step.kind === 'compact')
      ) {
        await emit({
          type: 'step.failed',
          timestamp: now(),
          identity: options.identity,
          step: modelStep,
          error: modelResult.error ?? 'model context overflow',
          nextAction: modelResult.nextAction,
        })
        return result(action)
      }
      return fail(
        modelStep,
        modelResult.outcome,
        modelResult.error ??
          (modelResult.outcome === 'cancelled' ? 'abort_signal' : 'model_step_failed'),
        action,
      )
    }

    snapshot.pendingToolCalls = [...modelResult.toolCalls].map(cloneValue)
    snapshot.toolBatchCalls = snapshot.pendingToolCalls.map(cloneValue)
    const toolCallIds = snapshot.pendingToolCalls.map(toolCallId)
    if (toolCallIds.length === 0) {
      const decision =
        (await policy.afterModel?.({
          identity: options.identity,
          step: modelStep,
          toolCalls: snapshot.pendingToolCalls,
        })) ?? 'complete'
      const nextAction: RunNextAction = { type: 'model', reason: 'follow_up' }
      const completedAction: RunNextAction = { type: 'finalize', outcome: 'completed' }
      await emit({
        type: 'step.completed',
        timestamp: now(),
        identity: options.identity,
        step: modelStep,
        nextAction: decision === 'complete' ? completedAction : nextAction,
      })
      if (decision === 'pause') return pause(nextAction, action)
      if (decision === 'continue') return result(action)
      return result(action)
    }
    if (!toolsEnabled) {
      await options.handleToolBudgetExhausted?.({
        identity: options.identity,
        step: modelStep,
        toolCalls: snapshot.pendingToolCalls,
      })
      snapshot.pendingToolCalls = []
      snapshot.toolBatchCalls = []
      await emit({
        type: 'step.completed',
        timestamp: now(),
        identity: options.identity,
        step: modelStep,
        nextAction: { type: 'finalize', outcome: 'completed' },
      })
      return result(action)
    }

    const nextAction: RunNextAction = { type: 'tools', toolCallIds }
    const decision =
      (await policy.afterModel?.({
        identity: options.identity,
        step: modelStep,
        toolCalls: snapshot.pendingToolCalls,
      })) ?? (policy.mode === 'step' ? 'pause' : 'continue')
    if (decision === 'complete') {
      snapshot.pendingToolCalls = []
      await emit({
        type: 'step.completed',
        timestamp: now(),
        identity: options.identity,
        step: modelStep,
        nextAction: { type: 'finalize', outcome: 'completed' },
      })
      return result(action)
    }
    await emit({
      type: 'step.completed',
      timestamp: now(),
      identity: options.identity,
      step: modelStep,
      nextAction,
    })
    return decision === 'pause' ? pause(nextAction, action) : result(action)
  }

  const toolCalls = snapshot.pendingToolCalls.map(cloneValue)
  const toolCall = toolCalls[0]
  if (!toolCall) {
    const step = createStep('tool')
    const message = `tool action has no persisted calls: ${action.toolCallIds.join(', ')}`
    await emit({
      type: 'step.started',
      timestamp: now(),
      identity: options.identity,
      step,
      nextAction: action,
    })
    return fail(step, 'failed', message, action)
  }

  const batchCalls =
    snapshot.toolBatchCalls.length > 0
      ? snapshot.toolBatchCalls.map(cloneValue)
      : toolCalls.map(cloneValue)
  const callId = toolCallId(toolCall, 0)
  const toolCallIndex = Math.max(
    0,
    batchCalls.findIndex((candidate, index) => toolCallId(candidate, index) === callId),
  )
  const modelStepIndex = Math.max(0, snapshot.modelStepIndex - 1)
  const waitFor = async <T>(wait: RunWait, operation: () => Promise<T>): Promise<T> => {
    await emit({
      type: 'run.paused',
      timestamp: now(),
      identity: options.identity,
      nextAction: action,
      wait,
    })
    try {
      const value = await operation()
      await emit({
        type: 'run.resumed',
        timestamp: now(),
        identity: options.identity,
        nextAction: action,
      })
      return value
    } catch (error) {
      await emit({
        type: 'run.resumed',
        timestamp: now(),
        identity: options.identity,
        nextAction: action,
      })
      throw error
    }
  }

  let preparation: RunToolPreparation = { outcome: 'ready' }
  try {
    preparation =
      (await options.prepareToolStep?.({
        identity: options.identity,
        toolCall: cloneValue(toolCall),
        toolCallIndex,
        toolCallCount: batchCalls.length,
        modelStepIndex,
        signal: options.signal,
        waitFor,
      })) ?? preparation
  } catch (error) {
    preparation = {
      outcome: 'rejected',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const toolStep = createStep('tool', callId)
  await emit({
    type: 'step.started',
    timestamp: now(),
    identity: options.identity,
    step: toolStep,
    nextAction: action,
  })
  let toolResult: RunToolStepResult
  try {
    toolResult = await options.executeToolStep({
      identity: options.identity,
      step: toolStep,
      toolCall: cloneValue(toolCall),
      toolCallIndex,
      toolCallCount: batchCalls.length,
      modelStepIndex,
      preparation,
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
        (toolResult.outcome === 'cancelled' ? 'abort_signal' : 'tool_step_failed'),
      action,
    )
  }

  snapshot.pendingToolCalls = snapshot.pendingToolCalls.slice(1)
  if (snapshot.pendingToolCalls.length > 0) {
    const nextAction: RunNextAction = {
      type: 'tools',
      toolCallIds: snapshot.pendingToolCalls.map(toolCallId),
    }
    await emit({
      type: 'step.completed',
      timestamp: now(),
      identity: options.identity,
      step: toolStep,
      nextAction,
    })
    return policy.mode === 'step' ? pause(nextAction, action) : result(action)
  }

  snapshot.completedToolBatches += 1
  snapshot.toolBatchCalls = []
  const nextAction: RunNextAction = { type: 'model', reason: 'tool_results' }
  const decision =
    (await policy.afterTools?.({
      identity: options.identity,
      step: toolStep,
      toolCalls: batchCalls,
    })) ?? (policy.mode === 'step' ? 'pause' : 'continue')
  await emit({
    type: 'step.completed',
    timestamp: now(),
    identity: options.identity,
    step: toolStep,
    nextAction,
  })
  return decision === 'pause' ? pause(nextAction, action) : result(action)
}

export async function runDurableRun(options: RunMachineOptions): Promise<RunMachineResult> {
  let snapshot =
    options.initialSnapshot ??
    createRunCursor(options.identity, options.policy?.mode ?? 'continuous')
  snapshot = cloneValue(snapshot)
  for (;;) {
    const advanced = await advanceRun({ ...options, snapshot })
    snapshot = advanced.snapshot
    if (advanced.state.status !== 'running') {
      return {
        state: advanced.state,
        ...(advanced.pendingToolCallIds ? { pendingToolCallIds: advanced.pendingToolCallIds } : {}),
      }
    }
  }
}
