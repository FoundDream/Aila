import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { Agent } from './agent-core/agent'
import type {
  AgentEvent,
  ResolvedLLM,
  UIBlock,
  UIImageAttachment,
  UIMessage,
} from './agent-core/types'
import type { PreferenceMemoryService } from './memory/preference-memory-service'
import type { ConfigService } from './providers/config-service'
import type { ProviderRegistry } from './providers/registry'
import { providerHasUsableAuth } from './providers/types'
import { buildUIMessagesFromEntries, SessionStore } from './session'
import { createCodingTools, createCustomTools } from './tools'

const SYSTEM_PROMPT = `You are a helpful AI assistant running on the user's desktop computer.
You have direct access to the local filesystem and can run shell commands.
Be concise and direct. When working with files or commands, briefly explain what you're doing.`

export type SessionRunStatus = 'idle' | 'running' | 'error'

// Re-export UI types for IPC payload compatibility.
export type { UIBlock, UIImageAttachment, UIMessage }

export interface QueuedPromptDraft {
  id: string
  text: string
  images: UIImageAttachment[]
}

export interface SessionStateSnapshot {
  sessionId: string
  sessionPath: string | null
  messages: UIMessage[]
  isStreaming: boolean
  queuedPrompts: QueuedPromptDraft[]
  status: SessionRunStatus
}

export interface SessionListEntry {
  id: string
  runtimeId: string | null
  path: string | null
  name?: string
  modified: string
  messageCount: number
  firstMessage: string
  status: SessionRunStatus
  queuedCount: number
}

export interface SessionTarget {
  runtimeId?: string | null
  path?: string | null
}

interface SessionControllerOptions {
  registry: AgentService
  sessionId: string
  agent: Agent
  initialMessages?: UIMessage[]
  setPromptMemoryContext: (text: string) => void
}

function createMessageId(): string {
  return `msg-${crypto.randomUUID()}`
}

class SessionController {
  private readonly registry: AgentService
  private readonly id: string
  private readonly agent: Agent
  private readonly messages: UIMessage[]
  private readonly setPromptMemoryContext: (text: string) => void
  private readonly queuedPrompts: QueuedPromptDraft[] = []
  private unsubscribe: (() => void) | null = null
  private isStreaming = false
  private status: SessionRunStatus = 'idle'
  private activeAssistantId: string | null = null
  private activeTurn: { userText: string; assistantText: string } | null = null
  private currentInjectedMemoryIds: string[] = []

  constructor(options: SessionControllerOptions) {
    this.registry = options.registry
    this.id = options.sessionId
    this.agent = options.agent
    this.messages = options.initialMessages ? [...options.initialMessages] : []
    this.setPromptMemoryContext = options.setPromptMemoryContext
    this.unsubscribe = this.agent.subscribe(this.handleEvent.bind(this))
  }

  get sessionId(): string {
    return this.id
  }

  get sessionPath(): string | null {
    return this.agent.sessionFile ?? null
  }

  get queuedCount(): number {
    return this.queuedPrompts.length
  }

  get currentStatus(): SessionRunStatus {
    return this.status
  }

  buildSnapshot(): SessionStateSnapshot {
    return {
      sessionId: this.id,
      sessionPath: this.sessionPath,
      messages: this.messages.map((message) => ({
        ...message,
        images: message.images ? message.images.map((image) => ({ ...image })) : undefined,
        blocks: message.blocks ? [...message.blocks] : undefined,
      })),
      isStreaming: this.isStreaming,
      queuedPrompts: this.queuedPrompts.map((prompt) => ({
        ...prompt,
        images: prompt.images.map((image) => ({ ...image })),
      })),
      status: this.status,
    }
  }

  buildRuntimeSummary(): {
    modified: string
    name?: string
    messageCount: number
    firstMessage: string
    status: SessionRunStatus
    queuedCount: number
  } {
    const firstUserMessage = this.messages.find((message) => message.role === 'user')
    const imageCount = firstUserMessage?.images?.length ?? 0
    const firstMessage =
      firstUserMessage?.content?.trim() ||
      (imageCount > 0 ? `${imageCount} image${imageCount === 1 ? '' : 's'}` : '')

    return {
      modified: new Date().toISOString(),
      status: this.status,
      queuedCount: this.queuedPrompts.length,
      messageCount: this.messages.length,
      firstMessage: firstMessage || 'New session',
    }
  }

  async submitPrompt(
    text: string,
    images: UIImageAttachment[] = [],
  ): Promise<SessionStateSnapshot> {
    const trimmed = text.trim()
    const nextImages = images.map((image) => ({ ...image }))

    if (!trimmed && nextImages.length === 0) {
      return this.buildSnapshot()
    }

    if (this.isStreaming) {
      this.queuedPrompts.push({
        id: createMessageId(),
        text: trimmed,
        images: nextImages,
      })
      this.registry.notifySessionStateChanged(this)
      return this.buildSnapshot()
    }

    this.startPrompt(trimmed, nextImages)
    return this.buildSnapshot()
  }

  async abort(): Promise<SessionStateSnapshot> {
    await this.agent.abort()
    return this.buildSnapshot()
  }

  async switchModel(providerId: string, modelId: string): Promise<void> {
    await this.agent.setModel(providerId, modelId)
  }

  editQueuedPrompt(
    promptId: string,
    currentDraft: { text: string; images: UIImageAttachment[] },
  ): {
    nextInput: { text: string; images: UIImageAttachment[] } | null
    snapshot: SessionStateSnapshot
  } {
    const index = this.queuedPrompts.findIndex((prompt) => prompt.id === promptId)
    if (index < 0) {
      return { nextInput: null, snapshot: this.buildSnapshot() }
    }

    const [selected] = this.queuedPrompts.splice(index, 1)
    const trimmedDraft = currentDraft.text.trim()
    if (trimmedDraft || currentDraft.images.length > 0) {
      this.queuedPrompts.splice(index, 0, {
        id: createMessageId(),
        text: trimmedDraft,
        images: currentDraft.images.map((image) => ({ ...image })),
      })
    }

    this.registry.notifySessionStateChanged(this)
    return {
      nextInput: selected
        ? {
            text: selected.text,
            images: selected.images.map((image) => ({ ...image })),
          }
        : null,
      snapshot: this.buildSnapshot(),
    }
  }

  removeQueuedPrompt(promptId: string): SessionStateSnapshot {
    const next = this.queuedPrompts.filter((prompt) => prompt.id !== promptId)
    if (next.length !== this.queuedPrompts.length) {
      this.queuedPrompts.length = 0
      this.queuedPrompts.push(...next)
      this.registry.notifySessionStateChanged(this)
    }
    return this.buildSnapshot()
  }

  destroy(): void {
    this.unsubscribe?.()
    this.agent.dispose()
    this.unsubscribe = null
  }

  private startPrompt(text: string, images: UIImageAttachment[]): void {
    const assistantId = createMessageId()

    this.isStreaming = true
    this.status = 'running'
    this.activeAssistantId = assistantId
    this.messages.push({
      id: createMessageId(),
      role: 'user',
      content: text,
      images,
      status: 'done',
    })
    this.messages.push({
      id: assistantId,
      role: 'assistant',
      blocks: [],
      status: 'streaming',
    })
    this.registry.notifySessionStateChanged(this)

    void this.runPrompt(text, images)
  }

  private async runPrompt(text: string, images: UIImageAttachment[]): Promise<void> {
    try {
      const memoryContext = this.registry.memoryService.getPromptContext()
      this.setPromptMemoryContext(memoryContext.text)
      this.currentInjectedMemoryIds = memoryContext.ids
      this.activeTurn = { userText: text, assistantText: '' }

      await this.agent.prompt(text, {
        images: images.map((image) => ({
          type: 'image',
          data: image.data,
          mimeType: image.mimeType,
        })),
      })

      this.registry.memoryService.markApplied(this.currentInjectedMemoryIds)

      if (this.activeTurn) {
        const turn = this.activeTurn
        const llmCtx = this.registry.resolveActiveLLM()
        if (llmCtx) {
          void this.registry.memoryService
            .curateTurn({
              assistantText: turn.assistantText,
              userText: turn.userText,
              modelInfo: llmCtx.modelInfo,
              auth: llmCtx.auth,
              llmClient: llmCtx.client,
            })
            .catch((error) => {
              console.error('[memory] curation failed:', error)
            })
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[agent:${this.id}] prompt error:`, error)
      this.status = 'error'
      this.appendTextToActiveAssistant(`\nError: ${message}`)
      this.registry.send('agent:error', {
        sessionId: this.id,
        message,
      })
    } finally {
      this.setPromptMemoryContext('')
      this.currentInjectedMemoryIds = []
      this.activeTurn = null
      this.completeActiveAssistant()
      this.registry.send('agent:complete', { sessionId: this.id })
      this.registry.notifySessionStateChanged(this)
      this.processNextPrompt()
    }
  }

  private processNextPrompt(): void {
    if (this.queuedPrompts.length === 0) {
      if (this.status !== 'error') {
        this.status = 'idle'
      }
      this.isStreaming = false
      this.activeAssistantId = null
      this.registry.notifySessionStateChanged(this)
      return
    }

    const nextPrompt = this.queuedPrompts.shift()
    this.registry.notifySessionStateChanged(this)
    if (nextPrompt) {
      this.startPrompt(nextPrompt.text, nextPrompt.images)
    }
  }

  private completeActiveAssistant(): void {
    const assistantId = this.activeAssistantId
    if (!assistantId) return

    const assistant = this.messages.find(
      (message) => message.id === assistantId && message.role === 'assistant',
    )
    if (assistant) {
      assistant.status = 'done'
    }
  }

  private appendTextToActiveAssistant(text: string): void {
    const assistant = this.getActiveAssistant()
    if (!assistant) return

    const blocks = assistant.blocks ?? []
    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock?.type === 'text') {
      lastBlock.content += text
      return
    }

    blocks.push({ type: 'text', content: text })
    assistant.blocks = blocks
  }

  private appendThinkingToActiveAssistant(text: string): void {
    const assistant = this.getActiveAssistant()
    if (!assistant) return

    const blocks = assistant.blocks ?? []
    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock?.type === 'thinking') {
      lastBlock.content += text
      return
    }

    blocks.push({ type: 'thinking', content: text })
    assistant.blocks = blocks
  }

  private pushToolBlock(tool: { id: string; name: string; args: Record<string, unknown> }): void {
    const assistant = this.getActiveAssistant()
    if (!assistant) return

    const blocks = assistant.blocks ?? []
    blocks.push({
      type: 'tool',
      id: tool.id,
      name: tool.name,
      args: tool.args,
      status: 'running',
    })
    assistant.blocks = blocks
  }

  private completeToolBlock(result: {
    id: string
    name: string
    result: string
    isError: boolean
  }): void {
    const assistant = this.getActiveAssistant()
    if (!assistant?.blocks) return

    assistant.blocks = assistant.blocks.map((block) =>
      block.type === 'tool' && block.id === result.id
        ? {
            ...block,
            result: result.result,
            isError: result.isError,
            status: 'done',
          }
        : block,
    )
  }

  private getActiveAssistant(): UIMessage | undefined {
    if (!this.activeAssistantId) return undefined

    return this.messages.find(
      (message) => message.id === this.activeAssistantId && message.role === 'assistant',
    )
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        if (this.activeTurn) {
          this.activeTurn.assistantText += event.delta
        }
        this.appendTextToActiveAssistant(event.delta)
        this.registry.send('agent:text-delta', {
          sessionId: this.id,
          delta: event.delta,
        })
        break
      case 'thinking_delta':
        this.appendThinkingToActiveAssistant(event.delta)
        this.registry.send('agent:thinking-delta', {
          sessionId: this.id,
          delta: event.delta,
        })
        break
      case 'tool_execution_start': {
        const payload = {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
        }
        this.pushToolBlock(payload)
        this.registry.send('agent:tool-start', {
          sessionId: this.id,
          ...payload,
        })
        break
      }
      case 'tool_execution_end': {
        const payload = {
          id: event.toolCallId,
          name: event.toolName,
          result: event.result,
          isError: event.isError,
        }
        this.completeToolBlock(payload)
        this.registry.send('agent:tool-end', {
          sessionId: this.id,
          ...payload,
        })
        break
      }
      case 'error':
        this.status = 'error'
        this.registry.send('agent:error', {
          sessionId: this.id,
          message: event.message,
        })
        this.registry.notifySessionStateChanged(this)
        break
      case 'turn_complete':
        // runPrompt's finally block handles UI finalization.
        break
    }
  }
}

export class AgentService {
  private readonly window: BrowserWindow
  private readonly registry: ProviderRegistry
  private readonly configService: ConfigService
  readonly memoryService: PreferenceMemoryService
  private readonly controllers = new Map<string, SessionController>()

  private get cwd() {
    return app.getPath('home')
  }

  private get sessionDir() {
    return join(app.getPath('userData'), 'sessions')
  }

  constructor(
    window: BrowserWindow,
    registry: ProviderRegistry,
    configService: ConfigService,
    memoryService: PreferenceMemoryService,
  ) {
    this.window = window
    this.registry = registry
    this.configService = configService
    this.memoryService = memoryService
  }

  async createSession(): Promise<SessionStateSnapshot> {
    mkdirSync(this.sessionDir, { recursive: true })
    const store = SessionStore.create(this.sessionDir, this.cwd)
    const controller = this.createController(store)
    this.notifySessionStateChanged(controller)
    return controller.buildSnapshot()
  }

  async openSession(target: SessionTarget): Promise<SessionStateSnapshot> {
    if (target.runtimeId) {
      return this.getController(target.runtimeId).buildSnapshot()
    }

    if (!target.path) {
      throw new Error('Session target requires a runtimeId or path')
    }

    const existing = this.findControllerByPath(target.path)
    if (existing) {
      return existing.buildSnapshot()
    }

    const store = SessionStore.open(target.path)
    const initialMessages = buildUIMessagesFromEntries(store.getEntries())
    const controller = this.createController(store, initialMessages)
    this.notifySessionStateChanged(controller)
    return controller.buildSnapshot()
  }

  getSessionState(sessionId: string): SessionStateSnapshot {
    return this.getController(sessionId).buildSnapshot()
  }

  async prompt(
    sessionId: string,
    text: string,
    images: UIImageAttachment[] = [],
  ): Promise<SessionStateSnapshot> {
    const controller = this.getController(sessionId)
    const snapshot = await controller.submitPrompt(text, images)
    this.notifySessionStateChanged(controller)
    return snapshot
  }

  async abort(sessionId: string): Promise<SessionStateSnapshot> {
    const controller = this.getController(sessionId)
    const snapshot = await controller.abort()
    this.notifySessionStateChanged(controller)
    return snapshot
  }

  editQueuedPrompt(
    sessionId: string,
    promptId: string,
    currentDraft: { text: string; images: UIImageAttachment[] },
  ): {
    nextInput: { text: string; images: UIImageAttachment[] } | null
    snapshot: SessionStateSnapshot
  } {
    return this.getController(sessionId).editQueuedPrompt(promptId, currentDraft)
  }

  removeQueuedPrompt(sessionId: string, promptId: string): SessionStateSnapshot {
    return this.getController(sessionId).removeQueuedPrompt(promptId)
  }

  async listSessions(): Promise<SessionListEntry[]> {
    mkdirSync(this.sessionDir, { recursive: true })
    const persisted = SessionStore.list(this.sessionDir).filter((s) => s.cwd === this.cwd)

    const runtimeByPath = new Map<string, SessionController>()
    for (const controller of this.controllers.values()) {
      const path = controller.sessionPath
      if (path) {
        runtimeByPath.set(path, controller)
      }
    }

    const entries: SessionListEntry[] = persisted.map((session) => {
      const runtime = runtimeByPath.get(session.path)
      return {
        id: runtime?.sessionId ?? `persisted:${session.path}`,
        runtimeId: runtime?.sessionId ?? null,
        path: session.path,
        name: session.name,
        modified: session.modified.toISOString(),
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
        status: runtime?.currentStatus ?? 'idle',
        queuedCount: runtime?.queuedCount ?? 0,
      }
    })

    return entries.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
  }

  async deleteSession(target: SessionTarget): Promise<{ deletedRuntimeId: string | null }> {
    const runtimeId =
      target.runtimeId ??
      (target.path ? (this.findControllerByPath(target.path)?.sessionId ?? null) : null)

    if (runtimeId) {
      const controller = this.controllers.get(runtimeId)
      controller?.destroy()
      this.controllers.delete(runtimeId)
    }

    if (target.path && existsSync(target.path)) {
      SessionStore.delete(target.path)
    }

    this.send('agent:sessions-changed')
    return { deletedRuntimeId: runtimeId }
  }

  async switchModel(providerId: string, modelId: string): Promise<void> {
    const provider = this.configService.getProvider(providerId)
    if (!provider) throw new Error(`Provider "${providerId}" not found`)
    if (!providerHasUsableAuth(provider)) {
      throw new Error(`Provider "${providerId}" is not ready to use`)
    }

    await Promise.all(
      [...this.controllers.values()].map((controller) =>
        controller.switchModel(providerId, modelId).catch((error) => {
          console.error('[agent] failed to switch model for session:', error)
        }),
      ),
    )
  }

  async refreshProviderConfig(_providerId?: string): Promise<void> {
    // Agents re-read provider config via resolveActiveLLM() on the next turn,
    // so there is no per-session state to mutate here. We notify the renderer
    // so it can refresh its cached config snapshot.
    this.send('agent:sessions-changed')
  }

  destroy(): void {
    for (const controller of this.controllers.values()) {
      controller.destroy()
    }
    this.controllers.clear()
  }

  resolveActiveLLM(): ResolvedLLM | null {
    return this.registry.resolveActiveLLM()
  }

  notifySessionStateChanged(controller: SessionController): void {
    this.send('agent:session-state', controller.buildSnapshot())
    this.send('agent:sessions-changed')
  }

  send<T>(channel: string, data?: T): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, data)
    }
  }

  private createController(store: SessionStore, initialMessages?: UIMessage[]): SessionController {
    const sessionId = crypto.randomUUID()
    const promptMemoryContext = { text: '' }

    const codingTools = createCodingTools(this.cwd)
    const customTools = createCustomTools({
      cwd: this.cwd,
      getWebSearchConfig: () => this.configService.getWebSearchConfig(),
    })
    const tools = [...codingTools, ...customTools]

    const agent = new Agent({
      store,
      cwd: this.cwd,
      tools,
      baseSystemPrompt: SYSTEM_PROMPT,
      getActiveLLM: () => this.registry.resolveActiveLLM(),
      getSystemPromptAddendum: () => promptMemoryContext.text,
    })

    const controller = new SessionController({
      registry: this,
      sessionId,
      agent,
      initialMessages,
      setPromptMemoryContext: (text) => {
        promptMemoryContext.text = text
      },
    })
    this.controllers.set(sessionId, controller)
    return controller
  }

  private getController(sessionId: string): SessionController {
    const controller = this.controllers.get(sessionId)
    if (!controller) {
      throw new Error(`Unknown session: ${sessionId}`)
    }
    return controller
  }

  private findControllerByPath(sessionPath: string): SessionController | undefined {
    return [...this.controllers.values()].find(
      (controller) => controller.sessionPath === sessionPath,
    )
  }
}
