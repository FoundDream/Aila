import type { ChatMessage, ToolCall } from '../agent-protocol'
import { defaultAgentRuntime } from '../agent-runtime'
import type {
  ModelCallResult,
  ModelCallStreamEvent,
  ModelCallStreamSink,
  ModelCallToolCall,
  ModelCallToolDefinition,
  ModelCallUsage,
} from '../model-call'

type MaybePromise<T> = T | Promise<T>

export interface AgentModelInput {
  messages: ChatMessage[]
  tools: ModelCallToolDefinition[]
  signal: AbortSignal
  turn: number
}

/** One model request. Provider selection, authentication and protocol encoding live behind it. */
export type AgentModel = (
  input: AgentModelInput,
  sink?: ModelCallStreamSink,
) => Promise<ModelCallResult>

export interface AgentToolContext {
  signal: AbortSignal
  turn: number
  call: ModelCallToolCall
}

export interface AgentTool {
  definition: ModelCallToolDefinition
  execute(args: Record<string, unknown>, context: AgentToolContext): MaybePromise<unknown>
}

export interface AgentState {
  messages: ChatMessage[]
  running: boolean
  streamingMessage?: Extract<ChatMessage, { role: 'assistant' }>
}

export interface Turn {
  index: number
  assistant: Extract<ChatMessage, { role: 'assistant' }>
  toolResults: Extract<ChatMessage, { role: 'tool' }>[]
  usage?: ModelCallUsage
}

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; result: AgentResult }
  | { type: 'turn_start'; turn: number }
  | { type: 'turn_end'; turn: Turn }
  | { type: 'message_start'; message: ChatMessage }
  | {
      type: 'message_update'
      message: Extract<ChatMessage, { role: 'assistant' }>
      delta: string
      kind: 'text' | 'reasoning'
    }
  | { type: 'message_end'; message: ChatMessage }
  | { type: 'tool_start'; turn: number; call: ModelCallToolCall }
  | {
      type: 'tool_update'
      turn: number
      call: Pick<ModelCallToolCall, 'id' | 'name'>
      delta: string
    }
  | {
      type: 'tool_end'
      turn: number
      call: ModelCallToolCall
      result: string
      isError: boolean
    }

export type AgentEventListener = (event: AgentEvent) => MaybePromise<void>

export type AgentResult =
  | { status: 'completed'; messages: ChatMessage[]; turns: number }
  | { status: 'aborted'; messages: ChatMessage[]; turns: number }
  | { status: 'failed'; messages: ChatMessage[]; turns: number; error: string }

export interface AgentOptions {
  model: AgentModel
  tools?: readonly AgentTool[]
  messages?: readonly ChatMessage[]
  systemPrompt?: string
  maxTurns?: number
  /** @deprecated Tool calls are serialized as individually recoverable runtime steps. */
  toolExecution?: 'sequential' | 'parallel'
}

type UserMessage = Extract<ChatMessage, { role: 'user' }>

interface ToolExecutionResult {
  call: ModelCallToolCall
  message: Extract<ChatMessage, { role: 'tool' }>
  result: string
  isError: boolean
}

interface PendingTurn {
  index: number
  assistant: Extract<ChatMessage, { role: 'assistant' }>
  calls: ModelCallToolCall[]
  resolved: Map<string, ModelCallResult['resolvedToolResults'][number]>
  usage?: ModelCallUsage
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function userMessage(input: string | UserMessage): UserMessage {
  return typeof input === 'string' ? { role: 'user', content: input } : clone(input)
}

function assistantToolCall(call: ModelCallToolCall): ToolCall {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.argsJson,
    },
  }
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Minimal, in-memory facade over the shared AgentRuntime.
 *
 * Agent owns the convenient transcript and event API. AgentRuntime owns model,
 * tool and queued-input sequencing; durable products provide different ports
 * and storage to that same runtime.
 */
export class Agent {
  readonly state: AgentState

  private model: AgentModel
  private tools: AgentTool[]
  private readonly listeners = new Set<AgentEventListener>()
  private readonly maxTurns: number
  private readonly steering: UserMessage[] = []
  private readonly followUps: UserMessage[] = []
  private controller: AbortController | null = null
  private active: Promise<AgentResult> | null = null

  constructor(options: AgentOptions) {
    this.model = options.model
    this.tools = [...(options.tools ?? [])]
    this.maxTurns = Math.max(1, Math.floor(options.maxTurns ?? 50))
    const messages: ChatMessage[] = (options.messages ?? []).map((message) => clone(message))
    if (options.systemPrompt) {
      messages.unshift({ role: 'system', content: options.systemPrompt })
    }
    this.state = {
      messages,
      running: false,
    }
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setModel(model: AgentModel): void {
    this.model = model
  }

  setTools(tools: readonly AgentTool[]): void {
    this.tools = [...tools]
  }

  prompt(input: string | UserMessage): Promise<AgentResult> {
    return this.start(userMessage(input))
  }

  continue(): Promise<AgentResult> {
    if (this.state.messages.length === 0) {
      return Promise.reject(new Error('cannot continue an empty agent'))
    }
    const last = this.state.messages[this.state.messages.length - 1]
    if (last.role === 'assistant') {
      const queued = this.steering.shift() ?? this.followUps.shift()
      if (queued) return this.start(queued)
      return Promise.reject(new Error('cannot continue from an assistant message'))
    }
    return this.start()
  }

  steer(input: string | UserMessage): void {
    this.steering.push(userMessage(input))
  }

  followUp(input: string | UserMessage): void {
    this.followUps.push(userMessage(input))
  }

  abort(): void {
    this.controller?.abort()
  }

  get signal(): AbortSignal | undefined {
    return this.controller?.signal
  }

  clearSteering(): void {
    this.steering.length = 0
  }

  clearFollowUps(): void {
    this.followUps.length = 0
  }

  clearQueue(): void {
    this.clearSteering()
    this.clearFollowUps()
  }

  hasQueuedMessages(): boolean {
    return this.steering.length > 0 || this.followUps.length > 0
  }

  reset(): void {
    if (this.state.running) throw new Error('cannot reset a running agent')
    this.state.messages.length = 0
    this.state.streamingMessage = undefined
    this.clearQueue()
  }

  async waitForIdle(): Promise<void> {
    await this.active
  }

  private start(prompt?: UserMessage): Promise<AgentResult> {
    if (this.active) return Promise.reject(new Error('agent is already running'))
    const controller = new AbortController()
    this.controller = controller
    this.state.running = true
    const running = this.run(prompt, controller)
    this.active = running
    void running.finally(() => {
      if (this.active === running) this.active = null
      if (this.controller === controller) this.controller = null
      this.state.running = false
      this.state.streamingMessage = undefined
    })
    return running
  }

  private async run(
    prompt: UserMessage | undefined,
    controller: AbortController,
  ): Promise<AgentResult> {
    let turns = 0
    let result: AgentResult
    let pendingTurn: PendingTurn | null = null
    let pendingToolResults: ToolExecutionResult[] = []
    try {
      await this.emit({ type: 'agent_start' })
      if (prompt) await this.appendMessage(prompt)

      const runId = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      const completed = await defaultAgentRuntime.run<ModelCallToolCall, UserMessage>({
        identity: {
          conversationId: 'memory',
          turnId: runId,
          runId,
        },
        signal: controller.signal,
        maxToolSteps: this.maxTurns,
        inputQueue: {
          dequeueSteering: () => this.steering.shift(),
          dequeueFollowUp: () => this.followUps.shift(),
          apply: (message) => this.appendMessage(message),
        },
        executeModelStep: async ({ modelStepIndex, signal }) => {
          if (modelStepIndex >= this.maxTurns) {
            return {
              outcome: 'failed',
              toolCalls: [],
              error: `agent exceeded ${this.maxTurns} turns`,
            }
          }
          pendingTurn = await this.runModelTurn(modelStepIndex, signal)
          pendingToolResults = []
          turns += 1
          if (pendingTurn.calls.length === 0) {
            await this.finishTurn(pendingTurn, [])
            pendingTurn = null
          }
          return {
            outcome: 'completed',
            toolCalls: pendingTurn?.calls ?? [],
          }
        },
        executeToolStep: async ({ toolCall, toolCallIndex, toolCallCount, signal }) => {
          const turn = pendingTurn
          if (!turn) {
            return {
              outcome: 'failed',
              error: 'agent tool step is missing its model turn',
            }
          }
          const execution = await this.executeTool(
            turn.index,
            toolCall,
            signal,
            turn.resolved.get(toolCall.id),
          )
          pendingToolResults.push(execution)
          this.state.messages.push(clone(execution.message))
          await this.emit({ type: 'message_end', message: clone(execution.message) })
          if (toolCallIndex === toolCallCount - 1) {
            await this.finishTurn(
              turn,
              pendingToolResults.map((entry) => entry.message),
            )
            pendingTurn = null
            pendingToolResults = []
          }
          return { outcome: 'completed' }
        },
      })

      result =
        completed.state.status === 'completed'
          ? {
              status: 'completed',
              messages: clone(this.state.messages),
              turns,
            }
          : completed.state.status === 'cancelled'
            ? {
                status: 'aborted',
                messages: clone(this.state.messages),
                turns,
              }
            : {
                status: 'failed',
                messages: clone(this.state.messages),
                turns,
                error: completed.state.error ?? `agent ended in ${completed.state.status}`,
              }
      await this.emit({ type: 'agent_end', result: clone(result) })
      return result
    } catch (error) {
      result = controller.signal.aborted
        ? {
            status: 'aborted',
            messages: clone(this.state.messages),
            turns,
          }
        : {
            status: 'failed',
            messages: clone(this.state.messages),
            turns,
            error: error instanceof Error ? error.message : String(error),
          }
      await this.emit({ type: 'agent_end', result: clone(result) })
      return result
    }
  }

  private async runModelTurn(index: number, signal: AbortSignal): Promise<PendingTurn> {
    await this.emit({ type: 'turn_start', turn: index })
    let text = ''
    const streamingMessage: Extract<ChatMessage, { role: 'assistant' }> = {
      role: 'assistant',
      content: '',
    }
    this.state.streamingMessage = streamingMessage
    await this.emit({ type: 'message_start', message: clone(streamingMessage) })

    const result = await this.model(
      {
        messages: clone(this.state.messages),
        tools: this.tools.map((tool) => clone(tool.definition)),
        signal,
        turn: index,
      },
      async (event) => {
        text = await this.handleModelEvent(index, text, event)
      },
    )

    if (result.outcome === 'cancelled' || signal.aborted) throw new Error('aborted')
    if (result.outcome === 'failed') throw new Error(result.error ?? 'model call failed')

    const assistant: Extract<ChatMessage, { role: 'assistant' }> = {
      role: 'assistant',
      content: result.text || text,
      ...(result.toolCalls.length > 0
        ? { tool_calls: result.toolCalls.map(assistantToolCall) }
        : {}),
    }
    this.state.streamingMessage = assistant
    this.state.messages.push(clone(assistant))
    await this.emit({ type: 'message_end', message: clone(assistant) })
    this.state.streamingMessage = undefined

    return {
      index,
      assistant,
      calls: result.toolCalls.map(clone),
      resolved: new Map(
        result.resolvedToolResults.map((toolResult) => [toolResult.toolCallId, toolResult]),
      ),
      ...(result.totalUsage ? { usage: clone(result.totalUsage) } : {}),
    }
  }

  private async finishTurn(
    pending: PendingTurn,
    toolResults: Extract<ChatMessage, { role: 'tool' }>[],
  ): Promise<void> {
    const turn: Turn = {
      index: pending.index,
      assistant: clone(pending.assistant),
      toolResults: clone(toolResults),
      ...(pending.usage ? { usage: clone(pending.usage) } : {}),
    }
    await this.emit({ type: 'turn_end', turn })
  }

  private async handleModelEvent(
    turn: number,
    text: string,
    event: ModelCallStreamEvent,
  ): Promise<string> {
    if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
      const nextText = event.type === 'text-delta' ? text + event.text : text
      const message: Extract<ChatMessage, { role: 'assistant' }> = {
        role: 'assistant',
        content: nextText,
      }
      this.state.streamingMessage = message
      await this.emit({
        type: 'message_update',
        message: clone(message),
        delta: event.text,
        kind: event.type === 'text-delta' ? 'text' : 'reasoning',
      })
      return nextText
    }
    if (event.type === 'tool-input-delta') {
      await this.emit({
        type: 'tool_update',
        turn,
        call: { id: event.id, name: '' },
        delta: event.delta,
      })
    }
    return text
  }

  private async executeTool(
    turn: number,
    call: ModelCallToolCall,
    signal: AbortSignal,
    resolved?: ModelCallResult['resolvedToolResults'][number],
  ): Promise<ToolExecutionResult> {
    await this.emit({ type: 'tool_start', turn, call: clone(call) })
    let result: string
    let isError = false

    if (resolved) {
      isError = resolved.error !== undefined
      result = resolved.error ?? stringifyToolResult(resolved.output)
    } else {
      const tool = this.tools.find((candidate) => candidate.definition.name === call.name)
      if (!tool) {
        isError = true
        result = `Unknown tool "${call.name}"`
      } else {
        try {
          result = stringifyToolResult(
            await tool.execute(clone(call.args), {
              signal,
              turn,
              call: clone(call),
            }),
          )
        } catch (error) {
          isError = true
          result = error instanceof Error ? error.message : String(error)
        }
      }
    }

    const message: Extract<ChatMessage, { role: 'tool' }> = {
      role: 'tool',
      tool_call_id: call.id,
      content: result,
    }
    await this.emit({
      type: 'tool_end',
      turn,
      call: clone(call),
      result,
      isError,
    })
    return { call, message, result, isError }
  }

  private async appendMessage(message: ChatMessage): Promise<void> {
    this.state.messages.push(clone(message))
    await this.emit({ type: 'message_start', message: clone(message) })
    await this.emit({ type: 'message_end', message: clone(message) })
  }

  private async emit(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(clone(event))
    }
  }
}
