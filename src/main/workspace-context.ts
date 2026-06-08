import type { ChatMessage } from './agent-protocol'
import type { ConversationRecord } from './conversation-core'
import { getDoc, getDocFilePath } from './docs'
import { getDocumentsDir } from './paths'
import type { ToolContext } from './tools'

const DOC_PREVIEW_CHARS = 12_000

function truncateDocPreview(content: string): string {
  if (content.length <= DOC_PREVIEW_CHARS) return content
  return `${content.slice(0, DOC_PREVIEW_CHARS)}\n\n[document preview truncated: ${
    content.length - DOC_PREVIEW_CHARS
  } chars omitted]`
}

export function getDesktopWorkspaceRoots(): ToolContext['workspaceRoots'] {
  return [{ path: getDocumentsDir(), label: 'Desktop documents' }]
}

export async function buildDesktopWorkspaceContextFromRecord(
  record: ConversationRecord,
): Promise<ChatMessage[]> {
  const docPath = record.meta.docId
  if (!docPath) return []

  try {
    const doc = await getDoc(docPath)
    const filePath = getDocFilePath(doc.path)
    const lines = [
      'Desktop workspace context:',
      `- Active document title: ${doc.title}`,
      `- Vault path: ${doc.path}`,
      `- Absolute file path: ${filePath}`,
      '',
      'When you need to inspect or modify the active document, use the ordinary read/write/edit tools with the absolute file path above.',
      'Do not assume the preview below is complete; call read first for exact current contents before editing.',
      '',
      'Current document preview:',
      truncateDocPreview(doc.content),
    ]
    return [{ role: 'system', content: lines.join('\n') }]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return [
      {
        role: 'system',
        content: [
          'Desktop workspace context:',
          `- This conversation is bound to a document that could not be loaded: ${docPath}`,
          `- Load error: ${message}`,
        ].join('\n'),
      },
    ]
  }
}
