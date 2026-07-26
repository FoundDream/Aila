import {
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  type ModelSelection,
  type PersistedBlock,
  type PersistedImageBlock,
  type PersistedMessage,
  type PersistedToolCallBlock,
  type PersistedToolResultRef,
} from '@aila/agent'

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Builds the persisted assistant projection without owning streaming or storage. */
export class AssistantMessageBuilder {
  readonly blocks: PersistedBlock[]
  private readonly toolBlockIndex = new Map<string, number>()

  constructor(blocks: readonly PersistedBlock[] = []) {
    this.blocks = [...clone(blocks)]
    this.blocks.forEach((block, index) => {
      if (block.type === 'tool_call') this.toolBlockIndex.set(block.id, index)
    })
  }

  appendText(kind: 'text' | 'reasoning', delta: string): void {
    if (!delta) return
    const last = this.blocks[this.blocks.length - 1]
    if (last && last.type === kind) {
      last.content += delta
      return
    }
    this.blocks.push({ type: kind, content: delta })
  }

  startToolCall(id: string, name: string, args: string): void {
    const existing = this.toolBlockIndex.get(id)
    if (existing !== undefined) {
      const block = this.blocks[existing] as PersistedToolCallBlock
      block.name = name
      block.arguments = args
      return
    }
    const block: PersistedToolCallBlock = {
      type: 'tool_call',
      id,
      name,
      arguments: args,
      status: 'running',
    }
    this.toolBlockIndex.set(id, this.blocks.length)
    this.blocks.push(block)
  }

  appendToolCallArgs(id: string, delta: string): void {
    if (!delta) return
    const index = this.toolBlockIndex.get(id)
    if (index === undefined) return
    const block = this.blocks[index] as PersistedToolCallBlock
    block.arguments += delta
  }

  appendImage(block: PersistedImageBlock): void {
    this.blocks.push(clone(block))
  }

  finishToolCall(
    id: string,
    result: string,
    isError: boolean,
    resultRef?: PersistedToolResultRef,
  ): void {
    const index = this.toolBlockIndex.get(id)
    if (index === undefined) return
    const block = this.blocks[index] as PersistedToolCallBlock
    block.status = isError ? 'error' : 'done'
    block.result = result
    if (resultRef) block.resultRef = clone(resultRef)
  }

  build(
    messageId: string,
    status: 'streaming' | 'done' | 'error',
    selection: ModelSelection,
    error?: string,
  ): PersistedMessage {
    return {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: messageId,
      role: 'assistant',
      blocks: clone(this.blocks),
      status,
      ...(error !== undefined && { error }),
      model: clone(selection),
    }
  }
}
