import {
  type RunMachineOptions,
  type RunMachineResult,
  type RunPolicy,
  type RunPolicyDecision,
  runDurableRun,
} from './run-machine'

type MaybePromise<T> = T | Promise<T>

export interface AgentRuntimeInputQueue<TQueuedInput> {
  dequeueSteering(): MaybePromise<TQueuedInput | undefined>
  dequeueFollowUp(): MaybePromise<TQueuedInput | undefined>
  apply(input: TQueuedInput, kind: 'steer' | 'follow_up'): MaybePromise<void>
}

export interface AgentRuntimeRunOptions<TQueuedInput = never>
  extends Omit<RunMachineOptions, 'policy'> {
  policy?: RunPolicy
  inputQueue?: AgentRuntimeInputQueue<TQueuedInput>
}

/**
 * The only model/tool run orchestrator.
 *
 * Product and in-memory entry points provide ports and storage, but queue timing,
 * step limits, pause/resume and model/tool sequencing are owned here and by the
 * pure Run Machine.
 */
export class AgentRuntime {
  async run<TQueuedInput = never>(
    options: AgentRuntimeRunOptions<TQueuedInput>,
  ): Promise<RunMachineResult> {
    const { inputQueue, policy, ...machine } = options

    return runDurableRun({
      ...machine,
      policy: {
        mode: policy?.mode ?? 'continuous',
        afterModel: async (input) => {
          if (input.toolCalls.length === 0 && inputQueue) {
            const steering = await inputQueue.dequeueSteering()
            if (steering !== undefined) {
              await inputQueue.apply(steering, 'steer')
              return 'continue'
            }
            const followUp = await inputQueue.dequeueFollowUp()
            if (followUp !== undefined) {
              await inputQueue.apply(followUp, 'follow_up')
              return 'continue'
            }
          }
          return (
            (await policy?.afterModel?.(input)) ??
            defaultAfterModel(policy?.mode ?? 'continuous', input.toolCalls.length)
          )
        },
        afterTools: async (input) => {
          if (inputQueue) {
            const steering = await inputQueue.dequeueSteering()
            if (steering !== undefined) await inputQueue.apply(steering, 'steer')
          }
          return (
            (await policy?.afterTools?.(input)) ?? (policy?.mode === 'step' ? 'pause' : 'continue')
          )
        },
      },
    })
  }
}

function defaultAfterModel(mode: RunPolicy['mode'], toolCallCount: number): RunPolicyDecision {
  if (toolCallCount === 0) return 'complete'
  return mode === 'step' ? 'pause' : 'continue'
}

export const defaultAgentRuntime = new AgentRuntime()
