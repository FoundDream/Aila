import type { ConversationSummary } from '../../types'

export type ConversationStatusTone =
  | 'approval'
  | 'running'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ConversationStatus {
  tone: ConversationStatusTone
  label: string
  ariaLabel: string
  title: string
}

export function getConversationStatus(
  conversation: ConversationSummary,
  input: { isBusy?: boolean; needsApproval?: boolean } = {},
): ConversationStatus | null {
  const activity = conversation.activity

  if (input.needsApproval || activity?.state === 'approval') {
    return {
      tone: 'approval',
      label: 'review',
      ariaLabel: 'Approval required',
      title: activity?.title ?? 'Approval required',
    }
  }

  if (input.isBusy || activity?.state === 'running') {
    return {
      tone: 'running',
      label: 'run',
      ariaLabel: input.isBusy ? 'Streaming' : 'Recent activity still running',
      title: activity?.title ?? 'Streaming',
    }
  }

  if (activity?.state === 'paused') {
    return {
      tone: 'paused',
      label: 'step',
      ariaLabel: 'Agent run paused',
      title: activity.title,
    }
  }

  if (activity?.state === 'failed') {
    return {
      tone: 'failed',
      label: 'error',
      ariaLabel: 'Last run failed',
      title: activity.title,
    }
  }

  if (activity?.state === 'cancelled') {
    return {
      tone: 'cancelled',
      label: 'stop',
      ariaLabel: 'Last run stopped',
      title: activity.title,
    }
  }

  if (activity?.state === 'interrupted') {
    return {
      tone: 'interrupted',
      label: 'resume',
      ariaLabel: 'Last run interrupted',
      title: activity.title,
    }
  }

  return null
}
