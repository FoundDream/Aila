/**
 * Projection from persisted session entries → UI-facing message list.
 *
 * Tool results are matched to their originating tool call by `toolCallId`,
 * then attached as `result`/`isError` onto the corresponding tool block.
 * Standalone toolResult messages are never emitted as top-level UI messages.
 */

import { randomUUID } from 'node:crypto'
import type {
  AssistantMessage,
  ImageContent,
  SessionEntry,
  ToolResultMessage,
  UIBlock,
  UIImageAttachment,
  UIMessage,
  UserMessage,
} from '../agent-core/types'

function createMessageId(): string {
  return `msg-${randomUUID()}`
}

function createImageAttachmentId(): string {
  return `img-${randomUUID()}`
}

function extractUserText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function extractUserImages(message: UserMessage): UIImageAttachment[] {
  if (typeof message.content === 'string') return []
  return message.content
    .filter((p): p is ImageContent => p.type === 'image')
    .map((p) => ({
      id: createImageAttachmentId(),
      data: p.data,
      mimeType: p.mimeType,
    }))
}

function flattenToolResult(result: ToolResultMessage): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
}

export function buildUIMessagesFromEntries(entries: readonly SessionEntry[]): UIMessage[] {
  // First pass: collect tool results keyed by toolCallId.
  const toolResultMap = new Map<string, ToolResultMessage>()
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    if (entry.message.role === 'toolResult') {
      toolResultMap.set(entry.message.toolCallId, entry.message)
    }
  }

  const uiMessages: UIMessage[] = []

  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = entry.message

    if (message.role === 'user') {
      uiMessages.push({
        id: createMessageId(),
        role: 'user',
        content: extractUserText(message),
        images: extractUserImages(message),
        status: 'done',
      })
      continue
    }

    if (message.role !== 'assistant') continue

    const assistantMessage = message as AssistantMessage
    const blocks: UIBlock[] = []

    for (const part of assistantMessage.content) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', content: part.text })
      } else if (part.type === 'thinking') {
        blocks.push({ type: 'thinking', content: part.text })
      } else if (part.type === 'toolCall') {
        const toolResult = toolResultMap.get(part.id)
        blocks.push({
          type: 'tool',
          id: part.id,
          name: part.name,
          args: part.arguments,
          result: toolResult ? flattenToolResult(toolResult) : undefined,
          isError: toolResult?.isError,
          status: 'done',
        })
      }
    }

    if (blocks.length > 0) {
      uiMessages.push({
        id: createMessageId(),
        role: 'assistant',
        blocks,
        status: 'done',
      })
    }
  }

  return uiMessages
}
