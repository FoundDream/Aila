import type { ChatMessage } from '../agent-protocol'
import type { AgentContextPlan } from '../context'
import type {
  ConversationRecord,
  ConversationSummary,
  PersistedMessage,
  PersistedRunEvent,
  RunEventAppendResult,
} from '../conversation-core'
import type { Settings } from '../settings-types'
import type { LoadedSkill } from '../skills'
import { type AilaExecutionMode, isReadOnlyToolMetadata } from '../tool-policy'
import { createToolRegistry, type ToolContext, type ToolPack, type ToolRegistry } from '../tools'
import type { RuntimeAttachmentBlock, RuntimeToolPackLoadInput } from './api-types'

export function cloneRuntimeValue<T>(value: T): T {
  return structuredClone(value)
}

export function cloneRuntimeToolPack(toolPack: ToolPack): ToolPack {
  return {
    ...toolPack,
    tools: toolPack.tools.map((entry) => ({
      run: entry.run,
      spec: cloneRuntimeValue(entry.spec),
    })),
  }
}

export function cloneRuntimeToolRegistry(registry: ToolRegistry): ToolRegistry {
  return createToolRegistry(registry.toolPacks.map(cloneRuntimeToolPack))
}

export function filterRuntimeToolRegistryForMode(
  registry: ToolRegistry,
  mode: AilaExecutionMode,
): ToolRegistry {
  if (mode === 'agent') return cloneRuntimeToolRegistry(registry)
  const toolPacks = registry.toolPacks
    .map((toolPack) => ({
      ...toolPack,
      tools: toolPack.tools.filter((entry) => isReadOnlyToolMetadata(entry.spec.metadata)),
    }))
    .filter((toolPack) => toolPack.tools.length > 0)
  return createToolRegistry(toolPacks)
}

export function cloneRuntimeSettings(settings: Settings): Settings {
  return cloneRuntimeValue(settings)
}

export function assertRuntimeAttachmentBlock(
  block: RuntimeAttachmentBlock,
): RuntimeAttachmentBlock {
  if (!block || typeof block !== 'object') {
    throw new Error('runtime host returned an invalid attachment block')
  }
  if (block.type === 'file') {
    if (typeof block.name !== 'string' || typeof block.content !== 'string') {
      throw new Error('runtime host returned an invalid file attachment block')
    }
    return block
  }
  if (block.type === 'image') {
    if (typeof block.url !== 'string' || typeof block.mime !== 'string') {
      throw new Error('runtime host returned an invalid image attachment block')
    }
    return block
  }
  throw new Error('runtime host returned an unsupported attachment block')
}

export function cloneRuntimeWorkspaceRoots(
  roots: ToolContext['workspaceRoots'],
): ToolContext['workspaceRoots'] {
  return roots === undefined ? undefined : cloneRuntimeValue(roots)
}

export function cloneRuntimeChatMessages(
  messages: readonly ChatMessage[] | undefined,
): ChatMessage[] | undefined {
  return messages === undefined ? undefined : cloneRuntimeValue([...messages])
}

const IN_RUN_TOOL_RESULT_COMPACTED =
  '[Earlier tool result compacted during this run; rerun the tool if the full output is required.]'

export function prepareRuntimeModelStepMessages(
  messages: readonly ChatMessage[],
  contextPlan: AgentContextPlan | undefined,
): ChatMessage[] {
  const prepared = cloneRuntimeChatMessages(messages) ?? []
  const budgetChars = contextPlan?.budget.budgetChars
  if (!budgetChars || JSON.stringify(prepared).length <= budgetChars) return prepared

  const toolIndexes = prepared.flatMap((message, index) => (message.role === 'tool' ? [index] : []))
  const compactable = toolIndexes.slice(0, Math.max(0, toolIndexes.length - 6))
  for (const index of compactable) {
    const message = prepared[index]
    if (message?.role !== 'tool') continue
    prepared[index] = {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: IN_RUN_TOOL_RESULT_COMPACTED,
    }
    if (JSON.stringify(prepared).length <= budgetChars) break
  }
  return prepared
}

export function cloneRuntimeConversationRecord(record: ConversationRecord): ConversationRecord {
  return cloneRuntimeValue(record)
}

export function cloneRuntimeToolPackLoadInput(
  input: RuntimeToolPackLoadInput | undefined,
): RuntimeToolPackLoadInput | undefined {
  if (!input) return undefined
  return {
    ...(input.conversationId && { conversationId: input.conversationId }),
    ...(input.record && { record: cloneRuntimeConversationRecord(input.record) }),
  }
}

export function cloneRuntimeConversationSummary(summary: ConversationSummary): ConversationSummary {
  return cloneRuntimeValue(summary)
}

export function cloneRuntimeConversationSummaries(
  summaries: readonly ConversationSummary[],
): ConversationSummary[] {
  return cloneRuntimeValue([...summaries])
}

export function sortRuntimeConversationSummaries(
  summaries: readonly ConversationSummary[],
): ConversationSummary[] {
  return summaries
    .map((summary, index) => ({ summary, index }))
    .sort((left, right) => {
      const updatedOrder = right.summary.updatedAt - left.summary.updatedAt
      return updatedOrder === 0 ? left.index - right.index : updatedOrder
    })
    .map(({ summary }) => summary)
}

export function cloneRuntimePersistedMessage(message: PersistedMessage): PersistedMessage {
  return cloneRuntimeValue(message)
}

function cloneRuntimePersistedRunEvent(event: PersistedRunEvent): PersistedRunEvent {
  return cloneRuntimeValue(event)
}

export function cloneRuntimePersistedRunEvents(
  events: readonly PersistedRunEvent[],
): PersistedRunEvent[] {
  return cloneRuntimeValue([...events])
}

function cloneRuntimeRunEventAppendResult(result: RunEventAppendResult): RunEventAppendResult {
  const event = cloneRuntimePersistedRunEvent(result.event)
  if (!result.summary) return { event }
  return { event, summary: cloneRuntimeConversationSummary(result.summary) }
}

export function cloneRuntimeRunEventAppendResults(
  results: readonly RunEventAppendResult[],
): RunEventAppendResult[] {
  return results.map(cloneRuntimeRunEventAppendResult)
}

export function cloneRuntimeSkill(skill: LoadedSkill): LoadedSkill {
  return cloneRuntimeValue(skill)
}

export function cloneRuntimeSkills(skills: readonly LoadedSkill[]): LoadedSkill[] {
  return skills.map(cloneRuntimeSkill)
}
