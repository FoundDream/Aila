export type BuiltinAgentProfileId = 'chat' | 'doc' | 'coding' | 'research'
export type AgentProfileId = BuiltinAgentProfileId | (string & {})

export interface AgentProfile {
  id: AgentProfileId
  label: string
  description: string
  baseProfileId?: BuiltinAgentProfileId
  instructions?: string
}

export const AGENT_PROFILES: Record<BuiltinAgentProfileId, AgentProfile> = {
  chat: {
    id: 'chat',
    label: 'Chat',
    description: 'General chat with lightweight non-destructive tools only.',
  },
  doc: {
    id: 'doc',
    label: 'Document',
    description: 'Doc-bound assistant that can edit the current markdown document.',
  },
  coding: {
    id: 'coding',
    label: 'Coding',
    description: 'Workspace-scoped coding assistant with file and shell tools.',
  },
  research: {
    id: 'research',
    label: 'Research',
    description: 'Read-only research assistant for web and file inspection.',
  },
}

export function isBuiltinAgentProfileId(value: unknown): value is BuiltinAgentProfileId {
  return value === 'chat' || value === 'doc' || value === 'coding' || value === 'research'
}

export function getAgentProfile(id: AgentProfileId): AgentProfile {
  if (!isBuiltinAgentProfileId(id)) {
    return {
      id,
      label: id,
      description: 'Custom profile.',
      baseProfileId: 'chat',
    }
  }
  return AGENT_PROFILES[id]
}

export function normalizeChatAgentProfileId(value: unknown): BuiltinAgentProfileId {
  return value === 'research' || value === 'coding' ? value : 'chat'
}

export function normalizeBuiltinAgentProfileId(value: unknown): BuiltinAgentProfileId {
  return isBuiltinAgentProfileId(value) ? value : 'chat'
}
