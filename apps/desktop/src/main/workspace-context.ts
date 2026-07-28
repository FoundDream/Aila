import { isAbsolute } from 'node:path'
import type {
  ChatMessage,
  ConversationRecord,
  ConversationWorkspaceRef,
  RuntimeWorkspaceResolverInput,
  ToolContext,
} from '@aila/agent'

function resolveDesktopWorkspace(
  input: RuntimeWorkspaceResolverInput,
): ConversationWorkspaceRef | undefined {
  const workspace = input.workspace
  if (!workspace) return undefined
  if (!isAbsolute(workspace.path)) {
    throw new Error(`desktop workspace path must be absolute: ${workspace.path}`)
  }
  return workspace
}

export function getDesktopWorkspaceRoots(
  input: RuntimeWorkspaceResolverInput,
): ToolContext['workspaceRoots'] {
  const workspace = resolveDesktopWorkspace(input)
  if (!workspace) return []
  return [{ path: workspace.path, label: workspace.label ?? 'Project' }]
}

export function getDesktopShellCwd(input: RuntimeWorkspaceResolverInput): ToolContext['shellCwd'] {
  return resolveDesktopWorkspace(input)?.path
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
