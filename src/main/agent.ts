import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  ToolResultMessage,
  UserMessage,
} from '@mariozechner/pi-ai'
import type { AgentSession } from '@mariozechner/pi-coding-agent'
import {
  AuthStorage,
  buildSessionContext,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from '@mariozechner/pi-coding-agent'
import { app, type BrowserWindow } from 'electron'
import type { PreferenceMemoryService } from './memory/preference-memory-service'
import type { ConfigService } from './providers/config-service'
import type { ProviderRegistry } from './providers/registry'
import { parseModelKey } from './providers/types'
import { createCustomTools } from './tools'

const SYSTEM_PROMPT = `You are a helpful AI assistant running on the user's desktop computer.
You have direct access to the local filesystem and can run shell commands.
Be concise and direct. When working with files or commands, briefly explain what you're doing.`

export type SessionRunStatus = 'idle' | 'running' | 'error'

export interface UIMessage {
  id: string
  role: 'user' | 'assistant'
  content?: string
  images?: UIImageAttachment[]
  blocks?: UIBlock[]
  status?: 'queued' | 'streaming' | 'done'
}

export interface UIImageAttachment {
  id: string
  data: string
  mimeType: string
  name?: string
}

export type UIBlock =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'tool'
      id: string
      name: string
      args: Record<string, unknown>
      result?: string
      isError?: boolean
      status: 'running' | 'done'
    }

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
  session: AgentSession
  initialMessages?: UIMessage[]
  setPromptMemoryContext: (text: string) => void
}

function createMessageId(): string {
  return `msg-${crypto.randomUUID()}`
}

function createImageAttachmentId(): string {
  return `img-${crypto.randomUUID()}`
}

function extractUserText(message: UserMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }

  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function extractUserImages(message: UserMessage): UIImageAttachment[] {
  if (typeof message.content === 'string') {
    return []
  }

  return message.content
    .filter((part): part is ImageContent => part.type === 'image')
    .map((part) => ({
      id: createImageAttachmentId(),
      data: part.data,
      mimeType: part.mimeType,
    }))
}

function buildUIMessagesFromSessionManager(sessionManager: SessionManager): UIMessage[] {
  const entries = sessionManager.getEntries()
  const { messages: agentMessages } = buildSessionContext(entries)
  const toolResultMap = new Map<string, ToolResultMessage>()
  const uiMessages: UIMessage[] = []

  for (const message of agentMessages) {
    if ('role' in message && message.role === 'toolResult') {
      toolResultMap.set(message.toolCallId, message)
    }
  }

  for (const message of agentMessages) {
    if (!('role' in message)) continue

    if (message.role === 'user') {
      const content = extractUserText(message as UserMessage)
      const images = extractUserImages(message as UserMessage)
      uiMessages.push({
        id: createMessageId(),
        role: 'user',
        content,
        images,
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
        blocks.push({ type: 'thinking', content: part.thinking })
      } else if (part.type === 'toolCall') {
        const toolResult = toolResultMap.get(part.id)
        blocks.push({
          type: 'tool',
          id: part.id,
          name: part.name,
          args: part.arguments,
          result: toolResult
            ? toolResult.content
                .filter((content) => content.type === 'text')
                .map((content) => content.text)
                .join('')
            : undefined,
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
        status: assistantMessage.stopReason === 'aborted' ? 'done' : 'done',
      })
    }
  }

  return uiMessages
}

class SessionController {
  private readonly registry: AgentService
  private readonly id: string
  private readonly session: AgentSession
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
    this.session = options.session
    this.messages = options.initialMessages ? [...options.initialMessages] : []
    this.setPromptMemoryContext = options.setPromptMemoryContext
    this.unsubscribe = this.session.subscribe(this.handleEvent.bind(this))
  }

  get sessionId(): string {
    return this.id
  }

  get sessionPath(): string | null {
    return this.session.sessionFile ?? null
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

  buildRuntimeSummary(): Omit<
    SessionListEntry,
    'id' | 'runtimeId' | 'path' | 'modified' | 'name' | 'messageCount' | 'firstMessage'
  > & {
    modified: string
    name?: string
    messageCount: number
    firstMessage: string
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
    await this.session.abort()
    return this.buildSnapshot()
  }

  async switchModel(model: Model<Api>): Promise<void> {
    await this.session.setModel(model)
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
    this.session.dispose()
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

      await this.session.prompt(text, {
        images: images.map((image) => ({
          type: 'image',
          data: image.data,
          mimeType: image.mimeType,
        })),
      })

      this.registry.memoryService.markApplied(this.currentInjectedMemoryIds)

      if (this.activeTurn) {
        const turn = this.activeTurn
        const model = this.registry.resolveModel()
        void this.registry.memoryService
          .curateTurn({
            assistantText: turn.assistantText,
            model,
            modelRegistry: this.registry.modelRegistry,
            userText: turn.userText,
          })
          .catch((error) => {
            console.error('[memory] curation failed:', error)
          })
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

  private handleEvent(event: any): void {
    switch (event.type) {
      case 'message_update': {
        const assistantEvent = event.assistantMessageEvent
        switch (assistantEvent.type) {
          case 'text_delta':
            if (this.activeTurn) {
              this.activeTurn.assistantText += assistantEvent.delta
            }
            this.appendTextToActiveAssistant(assistantEvent.delta)
            this.registry.send('agent:text-delta', {
              sessionId: this.id,
              delta: assistantEvent.delta,
            })
            break
          case 'thinking_delta':
            this.appendThinkingToActiveAssistant(assistantEvent.delta)
            this.registry.send('agent:thinking-delta', {
              sessionId: this.id,
              delta: assistantEvent.delta,
            })
            break
          case 'error': {
            const message = assistantEvent.error?.errorMessage || 'Unknown error'
            this.status = 'error'
            this.registry.send('agent:error', {
              sessionId: this.id,
              message,
            })
            this.registry.notifySessionStateChanged(this)
            break
          }
        }
        break
      }
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
          result:
            typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2),
          isError: event.isError,
        }
        this.completeToolBlock(payload)
        this.registry.send('agent:tool-end', {
          sessionId: this.id,
          ...payload,
        })
        break
      }
    }
  }
}

export class AgentService {
  private readonly window: BrowserWindow
  private readonly registry: ProviderRegistry
  private readonly configService: ConfigService
  readonly memoryService: PreferenceMemoryService
  readonly modelRegistry: ModelRegistry
  private readonly authStorage = AuthStorage.inMemory()
  private readonly syncedProviderNames = new Set<string>()
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
    this.modelRegistry = ModelRegistry.create(this.authStorage)
  }

  async createSession(): Promise<SessionStateSnapshot> {
    const sessionManager = SessionManager.create(this.cwd, this.sessionDir)
    const controller = await this.createController(sessionManager)
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

    const sessionManager = SessionManager.open(target.path, this.sessionDir)
    const controller = await this.createController(
      sessionManager,
      buildUIMessagesFromSessionManager(sessionManager),
    )
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
    const persisted = await SessionManager.list(this.cwd, this.sessionDir).catch(() => [])
    const runtimeEntriesByPath = new Map<string, SessionController>()
    const runtimeOnlyEntries: SessionListEntry[] = []

    for (const controller of this.controllers.values()) {
      const path = controller.sessionPath
      if (path) {
        runtimeEntriesByPath.set(path, controller)
        continue
      }

      const summary = controller.buildRuntimeSummary()
      runtimeOnlyEntries.push({
        id: controller.sessionId,
        runtimeId: controller.sessionId,
        path: null,
        modified: summary.modified,
        name: undefined,
        messageCount: summary.messageCount,
        firstMessage: summary.firstMessage,
        status: summary.status,
        queuedCount: summary.queuedCount,
      })
    }

    const entries = persisted.map((session) => {
      const runtime = runtimeEntriesByPath.get(session.path)
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
      } satisfies SessionListEntry
    })

    return [...runtimeOnlyEntries, ...entries].sort(
      (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
    )
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
      unlinkSync(target.path)
    }

    this.send('agent:sessions-changed')
    return { deletedRuntimeId: runtimeId }
  }

  async switchModel(providerId: string, modelId: string): Promise<void> {
    const result = this.registry.createModelForId(providerId, modelId)
    if ('error' in result) throw new Error(result.error)

    await Promise.all(
      [...this.controllers.values()].map((controller) =>
        controller.switchModel(result).catch((error) => {
          console.error('[agent] failed to switch model for session:', error)
        }),
      ),
    )
  }

  async refreshProviderConfig(providerId?: string): Promise<void> {
    this.syncRuntimeApiKeys()

    const activeModel = this.configService.getActiveModelId()
    const parsed = activeModel ? parseModelKey(activeModel) : null
    if (!parsed) return
    if (providerId && parsed.providerId !== providerId) return

    const result = this.registry.createModelForId(parsed.providerId, parsed.modelId)
    if ('error' in result) return

    await Promise.all(
      [...this.controllers.values()].map((controller) =>
        controller.switchModel(result).catch((error) => {
          console.error('[agent] failed to refresh provider config for session:', error)
        }),
      ),
    )
  }

  destroy(): void {
    for (const controller of this.controllers.values()) {
      controller.destroy()
    }
    this.controllers.clear()
  }

  resolveModel(): Model<Api> {
    const activeModelKey = this.configService.getActiveModelId()
    if (activeModelKey) {
      const parsed = parseModelKey(activeModelKey)
      if (parsed) {
        const result = this.registry.createModelForId(parsed.providerId, parsed.modelId)
        if (!('error' in result)) {
          return result
        }
      }
    }

    const result = this.registry.createActiveModel()
    if ('error' in result) throw new Error(`No model available: ${result.error}`)
    return result
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

  private async createController(
    sessionManager: SessionManager,
    initialMessages?: UIMessage[],
  ): Promise<SessionController> {
    const sessionId = crypto.randomUUID()
    const model = this.resolveModel()
    const promptMemoryContext = { text: '' }

    mkdirSync(this.sessionDir, { recursive: true })

    const tools = createCodingTools(this.cwd)
    const customTools = createCustomTools({
      cwd: this.cwd,
      getWebSearchConfig: () => this.configService.getWebSearchConfig(),
    })

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      appendSystemPromptOverride: (base) =>
        promptMemoryContext.text ? [...base, promptMemoryContext.text] : base,
      systemPromptOverride: () => SYSTEM_PROMPT,
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
    })
    await resourceLoader.reload()

    this.syncRuntimeApiKeys()

    const { session } = await createAgentSession({
      cwd: this.cwd,
      model,
      tools,
      customTools,
      sessionManager,
      resourceLoader,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    })

    const controller = new SessionController({
      registry: this,
      sessionId,
      session,
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

  private syncRuntimeApiKeys(): void {
    const nextRuntimeKeys = new Map<string, string>()

    for (const provider of this.configService.getProviders()) {
      if (provider.apiKey) {
        nextRuntimeKeys.set(String(provider.provider), provider.apiKey)
      }
    }

    for (const providerName of this.syncedProviderNames) {
      if (!nextRuntimeKeys.has(providerName)) {
        this.authStorage.removeRuntimeApiKey(providerName)
      }
    }

    for (const [providerName, apiKey] of nextRuntimeKeys) {
      this.authStorage.setRuntimeApiKey(providerName, apiKey)
    }

    this.syncedProviderNames.clear()
    for (const providerName of nextRuntimeKeys.keys()) {
      this.syncedProviderNames.add(providerName)
    }
  }
}
