import type { AgentLoopSnapshot, AgentRunIdentity } from './agent-loop'
import type { ChatMessage, ModelSelection, UsageInfo } from './agent-protocol'
import type { AgentContextPlan } from './context'
import type { PersistedMessage } from './conversation-core'
import type { ModelCallToolCall } from './model-call'
import type { AilaExecutionMode } from './tool-policy'

export const AILA_AGENT_RUN_CHECKPOINT_SCHEMA_VERSION = 1
export const AILA_AGENT_RUN_ARTIFACT_SCHEMA_VERSION = 1

export type AgentRunRecoveryStrategy = 'automatic' | 'manual_review'

export interface AgentRunRecovery {
  strategy: AgentRunRecoveryStrategy
  reason?: string
}

/**
 * Durable execution cursor. Unlike a prompt-compaction checkpoint, this record
 * contains everything required to continue the same run after process restart.
 */
export interface AgentRunCheckpoint {
  schemaVersion: typeof AILA_AGENT_RUN_CHECKPOINT_SCHEMA_VERSION
  identity: AgentRunIdentity
  assistantMessageId: string
  selection: ModelSelection
  executionMode: AilaExecutionMode
  maxToolSteps: number
  loop: AgentLoopSnapshot<ModelCallToolCall>
  messages: ChatMessage[]
  modelStepOutputs: Record<string, string>
  contextPlan?: AgentContextPlan
  assistantMessage: PersistedMessage
  usage?: UsageInfo
  plan?: {
    id: string
    operation?: 'create' | 'revise' | 'implement'
  }
  recovery: AgentRunRecovery
  revision: number
  createdAt: number
  updatedAt: number
  lastEventSeq?: number
}

export type AgentRunArtifactKind =
  | 'model_call'
  | 'tool_batch'
  | 'tool_result'
  | 'compaction'
  | 'debug'

/** Immutable, inspectable payload produced by one run step. */
export interface AgentRunArtifact {
  schemaVersion: typeof AILA_AGENT_RUN_ARTIFACT_SCHEMA_VERSION
  artifactId: string
  conversationId: string
  turnId: string
  runId: string
  stepId: string
  kind: AgentRunArtifactKind
  createdAt: number
  contentType: 'application/json' | 'text/plain'
  data: unknown
}

export function agentRunRecoveryForLoop(
  loop: AgentLoopSnapshot<ModelCallToolCall>,
): AgentRunRecovery {
  if (
    loop.state.currentStep?.kind === 'tool_batch' &&
    loop.state.currentStep.status === 'running'
  ) {
    return {
      strategy: 'manual_review',
      reason: 'process stopped while a tool batch was running; side effects may have occurred',
    }
  }
  return { strategy: 'automatic' }
}

export function prepareAgentRunCheckpoint(
  checkpoint: AgentRunCheckpoint,
  previous?: AgentRunCheckpoint,
): AgentRunCheckpoint {
  if (checkpoint.identity.runId !== checkpoint.loop.state.identity.runId) {
    throw new Error('run checkpoint identity does not match loop snapshot')
  }
  if (checkpoint.assistantMessage.id !== checkpoint.assistantMessageId) {
    throw new Error('run checkpoint assistant message id does not match its message snapshot')
  }
  return {
    ...structuredClone(checkpoint),
    schemaVersion: AILA_AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
    revision: previous
      ? Math.max(previous.revision + 1, checkpoint.revision)
      : Math.max(1, checkpoint.revision),
    recovery: agentRunRecoveryForLoop(checkpoint.loop),
  }
}

export function prepareAgentRunCheckpointForResume(
  checkpoint: AgentRunCheckpoint,
  timestamp: number,
): AgentRunCheckpoint {
  const prepared = prepareAgentRunCheckpoint(checkpoint)
  if (
    prepared.loop.state.status === 'completed' ||
    prepared.loop.state.status === 'failed' ||
    prepared.loop.state.status === 'cancelled'
  ) {
    throw new Error(`agent run is already ${prepared.loop.state.status}`)
  }
  if (prepared.recovery.strategy === 'manual_review') {
    throw new Error(prepared.recovery.reason ?? 'agent run requires manual review')
  }

  const currentStep = prepared.loop.state.currentStep
  if (currentStep?.status === 'running') {
    prepared.loop.state.steps = prepared.loop.state.steps.map((step) =>
      step.stepId === currentStep.stepId
        ? {
            ...step,
            status: 'cancelled',
            completedAt: timestamp,
            error: 'interrupted_before_resume',
          }
        : step,
    )
    prepared.loop.state.currentStep = undefined
    prepared.loop.state.nextAction =
      currentStep.kind === 'compact'
        ? { type: 'compact', reason: 'provider_overflow' }
        : { type: 'model', reason: 'retry' }
  }
  prepared.loop.state.status = 'paused'
  prepared.loop.state.completedAt = undefined
  prepared.loop.state.error = undefined
  prepared.recovery = { strategy: 'automatic' }
  prepared.updatedAt = timestamp
  return prepared
}

export function prepareAgentRunArtifact(artifact: AgentRunArtifact): AgentRunArtifact {
  return {
    ...structuredClone(artifact),
    schemaVersion: AILA_AGENT_RUN_ARTIFACT_SCHEMA_VERSION,
  }
}
