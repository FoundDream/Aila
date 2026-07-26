import type { ChatMessage, ConversationRecord, ToolContext } from '@aila/agent'

export function getDesktopWorkspaceRoots(): ToolContext['workspaceRoots'] {
  return [{ path: process.cwd(), label: 'Project' }]
}

export async function buildDesktopWorkspaceContextFromRecord(
  record: ConversationRecord,
): Promise<ChatMessage[]> {
  const workspace = record.meta.workspace
  if (!workspace) return []
  return [
    {
      role: 'system',
      content: [
        'Desktop workspace context:',
        `- Workspace: ${workspace.label ?? workspace.path}`,
        `- Absolute path: ${workspace.path}`,
        '',
        'Inspect relevant files before changing them and keep all operations scoped to this workspace.',
      ].join('\n'),
    },
  ]
}
