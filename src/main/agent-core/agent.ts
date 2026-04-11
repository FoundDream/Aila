/**
 * Self-built agent runtime.
 *
 * Runs the canonical LLM-agent loop:
 *   1. Append the user prompt (+images) to the session
 *   2. Stream a chat completion
 *   3. Accumulate assistant text / thinking / tool calls into blocks
 *   4. If the model wants tools, execute them, append results, go back to (2)
 *   5. Otherwise, emit turn_complete and return
 *
 * Event contract (the `subscribe` listener receives these):
 *   - text_delta              assistant text stream chunk
 *   - thinking_delta          assistant thinking stream chunk
 *   - tool_execution_start    before a tool runs
 *   - tool_execution_end      after a tool returns (success or error)
 *   - error                   fatal error; loop will terminate
 *   - turn_complete           end of a turn with final stopReason
 *
 * Matches the field shapes already consumed by SessionController.handleEvent
 * so the cutover in T10 is a narrow diff.
 */

import type { SessionStore } from '../session/store'
import type {
  AgentEvent,
  AssistantContentPart,
  AssistantMessage,
  ChatRequest,
  ImageContent,
  LLMToolSchema,
  LLMUsage,
  ResolvedLLM,
  StopReason,
  StreamEvent,
  ToolCallContent,
  Tool as ToolDef,
  ToolResultMessage,
  UserContentPart,
  UserMessage,
} from './types'

export interface AgentOptions {
  store: SessionStore
  cwd: string
  tools: ToolDef[]
  baseSystemPrompt: string
  getActiveLLM: () => ResolvedLLM | null
  /** Extra text appended to the system prompt on every turn (e.g. memory context). */
  getSystemPromptAddendum?: () => string
}

type Listener = (event: AgentEvent) => void

function toLLMToolSchemas(tools: ToolDef[]): LLMToolSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as Record<string, unknown>,
  }))
}

function renderToolGuidelines(tools: ToolDef[]): string {
  const sections: string[] = []
  for (const tool of tools) {
    if (!tool.promptSnippet && (!tool.promptGuidelines || tool.promptGuidelines.length === 0)) {
      continue
    }
    const lines: string[] = [`### ${tool.name}`]
    if (tool.promptSnippet) {
      lines.push(tool.promptSnippet)
    }
    if (tool.promptGuidelines && tool.promptGuidelines.length > 0) {
      for (const rule of tool.promptGuidelines) {
        lines.push(`- ${rule}`)
      }
    }
    sections.push(lines.join('\n'))
  }
  if (sections.length === 0) return ''
  return ['## Tools', ...sections].join('\n\n')
}

function flattenToolResultText(content: ToolResultMessage['content']): string {
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

function buildUserMessage(text: string, images: ImageContent[]): UserMessage {
  const parts: UserContentPart[] = []
  const trimmed = text.trim()
  if (trimmed) {
    parts.push({ type: 'text', text })
  }
  for (const image of images) {
    parts.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  }

  if (parts.length === 0) {
    return { role: 'user', content: '' }
  }
  if (parts.length === 1 && parts[0].type === 'text') {
    return { role: 'user', content: parts[0].text }
  }
  return { role: 'user', content: parts }
}

export class Agent {
  private readonly listeners = new Set<Listener>()
  private abortController: AbortController | null = null
  private disposed = false

  constructor(private readonly options: AgentOptions) {}

  get sessionFile(): string {
    return this.options.store.path
  }

  get store(): SessionStore {
    return this.options.store
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async prompt(text: string, promptOptions: { images?: ImageContent[] } = {}): Promise<void> {
    if (this.disposed) {
      throw new Error('Agent is disposed')
    }
    if (this.abortController) {
      throw new Error('Another prompt is already in flight on this agent')
    }

    const userMessage = buildUserMessage(text, promptOptions.images ?? [])
    this.options.store.appendMessage(userMessage)

    const controller = new AbortController()
    this.abortController = controller

    try {
      await this.runLoop(controller.signal)
    } finally {
      this.abortController = null
    }
  }

  async abort(): Promise<void> {
    this.abortController?.abort()
  }

  async setModel(providerId: string, modelId: string): Promise<void> {
    this.options.store.appendModelChange(providerId, modelId)
  }

  dispose(): void {
    this.disposed = true
    this.abortController?.abort()
    this.listeners.clear()
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[agent] listener threw:', err)
      }
    }
  }

  private buildSystemPrompt(): string {
    const pieces: string[] = [this.options.baseSystemPrompt]
    const toolGuidelines = renderToolGuidelines(this.options.tools)
    if (toolGuidelines) {
      pieces.push(toolGuidelines)
    }
    const addendum = this.options.getSystemPromptAddendum?.()
    if (addendum) {
      pieces.push(addendum)
    }
    return pieces.filter(Boolean).join('\n\n')
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (true) {
      if (signal.aborted) return

      const llmCtx = this.options.getActiveLLM()
      if (!llmCtx) {
        console.error('[agent] resolveActiveLLM returned null — no active model or missing API key')
        this.emit({
          type: 'error',
          message: 'No active LLM configured. Pick a model in Settings → Providers.',
        })
        return
      }

      const tools = this.options.tools
      const toolSchemas = toLLMToolSchemas(tools)

      const request: ChatRequest = {
        model: llmCtx.modelInfo,
        systemPrompt: this.buildSystemPrompt(),
        messages: this.options.store.getMessages(),
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        maxOutputTokens: llmCtx.modelInfo.maxOutputTokens,
        thinkingBudget: llmCtx.modelInfo.supportsThinking ? 10_000 : undefined,
      }

      console.log(
        `[agent] starting turn: provider=${llmCtx.modelInfo.provider} model=${llmCtx.modelInfo.id} tools=${toolSchemas.length} messages=${request.messages.length}`,
      )

      const turn = await this.streamTurn(request, llmCtx, signal)

      if (turn.usage) {
        this.emit({ type: 'usage', usage: turn.usage })
      }

      if (turn.errored) {
        console.error(`[agent] turn errored: ${turn.errorMessage ?? 'Unknown error'}`)
        this.persistAssistantIfAny(turn.assistantBlocks, 'error')
        this.emit({ type: 'error', message: turn.errorMessage ?? 'Unknown error' })
        return
      }

      console.log(
        `[agent] turn finished: stopReason=${turn.stopReason} blocks=${turn.assistantBlocks.length}`,
      )

      this.persistAssistantIfAny(turn.assistantBlocks, turn.stopReason)

      if (turn.stopReason === 'aborted' || signal.aborted) {
        this.emit({ type: 'turn_complete', stopReason: 'aborted' })
        return
      }

      const toolCalls = turn.assistantBlocks.filter(
        (b): b is ToolCallContent => b.type === 'toolCall',
      )

      if (turn.stopReason !== 'tool_use' || toolCalls.length === 0) {
        this.emit({ type: 'turn_complete', stopReason: turn.stopReason })
        return
      }

      for (const call of toolCalls) {
        if (signal.aborted) {
          this.emit({ type: 'turn_complete', stopReason: 'aborted' })
          return
        }
        await this.executeToolCall(call, signal)
      }
      // loop back for the next LLM turn
    }
  }

  private persistAssistantIfAny(blocks: AssistantContentPart[], stopReason: StopReason): void {
    if (blocks.length === 0) return
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: blocks,
      stopReason,
    }
    this.options.store.appendMessage(assistant)
  }

  private async streamTurn(
    request: ChatRequest,
    llmCtx: ResolvedLLM,
    signal: AbortSignal,
  ): Promise<{
    assistantBlocks: AssistantContentPart[]
    stopReason: StopReason
    errored: boolean
    errorMessage?: string
    usage?: LLMUsage
  }> {
    const assistantBlocks: AssistantContentPart[] = []
    let currentText = ''
    let currentThinking = ''
    let stopReason: StopReason = 'stop'
    let errored = false
    let errorMessage: string | undefined
    let turnUsage: LLMUsage | undefined
    let currentThinkingSignature: string | undefined

    const flushText = () => {
      if (currentText) {
        assistantBlocks.push({ type: 'text', text: currentText })
        currentText = ''
      }
    }
    const flushThinking = () => {
      if (currentThinking) {
        assistantBlocks.push({
          type: 'thinking',
          text: currentThinking,
          signature: currentThinkingSignature,
        })
        currentThinking = ''
        currentThinkingSignature = undefined
      }
    }

    try {
      const stream = llmCtx.client.stream(request, llmCtx.auth, signal)
      for await (const event of stream as AsyncIterable<StreamEvent>) {
        switch (event.type) {
          case 'text-delta':
            if (currentThinking) flushThinking()
            currentText += event.delta
            this.emit({ type: 'text_delta', delta: event.delta })
            break
          case 'thinking-delta':
            if (currentText) flushText()
            currentThinking += event.delta
            if (event.signature) currentThinkingSignature = event.signature
            this.emit({ type: 'thinking_delta', delta: event.delta })
            break
          case 'tool-call-start':
            flushText()
            flushThinking()
            break
          case 'tool-call-end': {
            flushText()
            flushThinking()
            const block: ToolCallContent = {
              type: 'toolCall',
              id: event.id,
              name: event.name,
              arguments: event.arguments,
            }
            assistantBlocks.push(block)
            this.emit({
              type: 'tool_execution_start',
              toolCallId: event.id,
              toolName: event.name,
              args: event.arguments,
            })
            break
          }
          case 'finish':
            stopReason = event.reason
            if (event.reason === 'error') {
              errored = true
              errorMessage = event.errorMessage
            }
            break
          case 'usage':
            turnUsage = event.usage
            break
          default:
            break
        }
      }
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        stopReason = 'aborted'
      } else {
        errored = true
        errorMessage = err instanceof Error ? err.message : String(err)
        console.error('[agent] stream threw:', err)
      }
    }

    flushText()
    flushThinking()

    return { assistantBlocks, stopReason, errored, errorMessage, usage: turnUsage }
  }

  private async executeToolCall(call: ToolCallContent, signal: AbortSignal): Promise<void> {
    const tool = this.options.tools.find((t) => t.name === call.name)

    if (!tool) {
      const text = `Unknown tool: ${call.name}`
      const resultMessage: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: call.id,
        content: [{ type: 'text', text }],
        isError: true,
      }
      this.options.store.appendMessage(resultMessage)
      this.emit({
        type: 'tool_execution_end',
        toolCallId: call.id,
        toolName: call.name,
        result: text,
        isError: true,
      })
      return
    }

    try {
      const result = await tool.execute(call.arguments as never, {
        cwd: this.options.cwd,
        signal,
      })

      const resultMessage: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: call.id,
        content: result.content,
        isError: result.isError,
      }
      this.options.store.appendMessage(resultMessage)

      this.emit({
        type: 'tool_execution_end',
        toolCallId: call.id,
        toolName: call.name,
        result: flattenToolResultText(result.content),
        isError: result.isError ?? false,
      })
    } catch (err) {
      const text = `Tool error: ${err instanceof Error ? err.message : String(err)}`
      const resultMessage: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: call.id,
        content: [{ type: 'text', text }],
        isError: true,
      }
      this.options.store.appendMessage(resultMessage)
      this.emit({
        type: 'tool_execution_end',
        toolCallId: call.id,
        toolName: call.name,
        result: text,
        isError: true,
      })
    }
  }
}
