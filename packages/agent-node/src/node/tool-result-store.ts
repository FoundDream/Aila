import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PersistedToolResultRef } from '@aila/agent'
import { defaultAilaDataDir } from './settings'

export const DEFAULT_MAX_INLINE_TOOL_RESULT_CHARS = 50_000
export const DEFAULT_TOOL_RESULT_PREVIEW_CHARS = 2_000

export interface ToolResultStorePersistInput {
  conversationId: string
  messageId: string
  toolCallId: string
  toolName: string
  content: string
  previewChars: number
}

export interface ToolResultStore {
  persist(input: ToolResultStorePersistInput): Promise<PersistedToolResultRef>
}

export interface NodeToolResultStoreOptions {
  dataDir?: string
  toolResultDir?: string
}

export function getNodeToolResultsDir(options: NodeToolResultStoreOptions = {}): string {
  return options.toolResultDir ?? join(options.dataDir ?? defaultAilaDataDir(), 'tool-results')
}

export function getNodeToolResultsConversationDir(
  conversationId: string,
  options: NodeToolResultStoreOptions = {},
): string {
  return join(
    getNodeToolResultsDir(options),
    safeToolResultPathSegment(conversationId, 'conversation'),
  )
}

export function createNodeToolResultStore(
  options: NodeToolResultStoreOptions = {},
): ToolResultStore {
  const rootDir = getNodeToolResultsDir(options)

  return {
    async persist(input): Promise<PersistedToolResultRef> {
      const conversationDir = join(
        rootDir,
        safeToolResultPathSegment(input.conversationId, 'conversation'),
      )
      const fileName = [
        safeToolResultPathSegment(input.messageId, 'message'),
        safeToolResultPathSegment(input.toolCallId, 'tool-call'),
        safeToolResultPathSegment(input.toolName, 'tool'),
      ].join('__')
      const relativePath = join(
        safeToolResultPathSegment(input.conversationId, 'conversation'),
        `${fileName}.txt`,
      )
      const path = join(rootDir, relativePath)
      await mkdir(conversationDir, { recursive: true })
      await writeFile(path, input.content, 'utf-8')
      return {
        kind: 'file',
        path,
        relativePath,
        sizeChars: input.content.length,
        preview: previewToolResult(input.content, input.previewChars),
      }
    },
  }
}

export function previewToolResult(content: string, previewChars: number): string {
  if (previewChars <= 0) return ''
  return content.length <= previewChars ? content : content.slice(0, previewChars)
}

export function safeToolResultPathSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)
  return cleaned || fallback
}
