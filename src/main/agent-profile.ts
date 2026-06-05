export type AgentProfileId = 'chat' | 'doc' | 'coding' | 'research'

export interface AgentProfile {
  id: AgentProfileId
  label: string
  description: string
}

export const AGENT_PROFILES: Record<AgentProfileId, AgentProfile> = {
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

export function getAgentProfile(id: AgentProfileId): AgentProfile {
  return AGENT_PROFILES[id]
}
