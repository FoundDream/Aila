import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Api,
  AssistantMessage,
  Model,
  ToolResultMessage,
  UserMessage,
} from '@mariozechner/pi-ai'
import type { SessionInfo } from '@mariozechner/pi-coding-agent'
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

/** UI message format sent to renderer */
export interface UIMessage {
  role: 'user' | 'assistant'
  content?: string
  blocks?: UIBlock[]
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

export class AgentService {
  private session: ReturnType<
    Awaited<ReturnType<typeof createAgentSession>>['session']['subscribe']
  > extends () => void
    ? Awaited<ReturnType<typeof createAgentSession>>['session']
    : never = null as never
  private unsubscribe: (() => void) | null = null
  private window: BrowserWindow
  private registry: ProviderRegistry
  private configService: ConfigService
  private memoryService: PreferenceMemoryService
  private authStorage = AuthStorage.inMemory()
  private syncedProviderNames = new Set<string>()
  private currentModelKey: string | null = null
  private modelRegistry: ModelRegistry = ModelRegistry.create(this.authStorage)
  private currentMemoryContext = ''
  private currentInjectedMemoryIds: string[] = []
  private activeTurn: { userText: string; assistantText: string } | null = null

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

  async prompt(text: string): Promise<void> {
    try {
      if (!this.session) {
        console.log('[agent] initializing session...')
        await this.initSession()
        console.log('[agent] session initialized')
      }
      const memoryContext = this.memoryService.getPromptContext()
      this.currentMemoryContext = memoryContext.text
      this.currentInjectedMemoryIds = memoryContext.ids
      this.activeTurn = { userText: text, assistantText: '' }
      console.log('[agent] prompting:', text.slice(0, 100))
      await this.session.prompt(text)
      console.log('[agent] prompt complete')
      this.memoryService.markApplied(this.currentInjectedMemoryIds)

      if (this.activeTurn && this.modelRegistry) {
        const turn = this.activeTurn
        const model = this.resolveModel()
        void this.memoryService
          .curateTurn({
            assistantText: turn.assistantText,
            model,
            modelRegistry: this.modelRegistry,
            userText: turn.userText,
          })
          .catch((error) => {
            console.error('[memory] curation failed:', error)
          })
      }
    } catch (err) {
      console.error('[agent] error:', err)
      this.send('agent:error', {
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.currentMemoryContext = ''
      this.currentInjectedMemoryIds = []
      this.activeTurn = null
      this.send('agent:complete')
    }
  }

  async abort(): Promise<void> {
    await this.session?.abort()
  }

  async newSession(): Promise<void> {
    this.cleanup()
  }

  async listSessions(): Promise<SessionInfo[]> {
    try {
      const sessions = await SessionManager.list(this.cwd, this.sessionDir)
      return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime())
    } catch {
      return []
    }
  }

  async resumeSession(sessionPath: string): Promise<UIMessage[]> {
    this.cleanup()
    const sessionManager = SessionManager.open(sessionPath, this.sessionDir)
    await this.startSession(sessionManager)
    return this.buildUIMessages(sessionManager)
  }

  deleteSession(sessionPath: string): void {
    if (this.session?.sessionFile === sessionPath) {
      this.cleanup()
    }
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath)
    }
  }

  getCurrentSessionFile(): string | undefined {
    return this.session?.sessionFile
  }

  async switchModel(providerId: string, modelId: string): Promise<void> {
    const result = this.registry.createModelForId(providerId, modelId)
    if ('error' in result) throw new Error(result.error)

    const newModelKey = `${providerId}/${modelId}`

    if (this.session) {
      try {
        console.log('[agent] switching model to:', newModelKey)
        await this.session.setModel(result)
        this.currentModelKey = newModelKey
        console.log('[agent] model switched successfully')
      } catch (err) {
        console.error('[agent] setModel failed, recreating session:', err)
        this.cleanup()
        this.currentModelKey = newModelKey
      }
    } else {
      this.currentModelKey = newModelKey
    }
  }

  getCurrentModelKey(): string | null {
    return this.currentModelKey
  }

  async refreshProviderConfig(providerId?: string): Promise<void> {
    this.syncRuntimeApiKeys()

    if (!this.currentModelKey) {
      this.currentModelKey = this.configService.getActiveModelId()
      return
    }

    const parsed = parseModelKey(this.currentModelKey)
    if (!parsed) {
      this.currentModelKey = this.configService.getActiveModelId()
      return
    }

    if (providerId && parsed.providerId !== providerId) {
      return
    }

    const result = this.registry.createModelForId(parsed.providerId, parsed.modelId)
    if ('error' in result) {
      this.cleanup()
      this.currentModelKey = this.configService.getActiveModelId()
      return
    }

    if (!this.session) {
      return
    }

    try {
      await this.session.setModel(result)
    } catch (err) {
      console.error('[agent] failed to refresh model after provider update:', err)
      this.cleanup()
    }
  }

  destroy(): void {
    this.cleanup()
  }

  // --- private ---

  private async initSession(): Promise<void> {
    const sessionManager = SessionManager.create(this.cwd, this.sessionDir)
    await this.startSession(sessionManager)
  }

  private async startSession(sessionManager: SessionManager): Promise<void> {
    const model = this.resolveModel()
    console.log('[agent] config:', {
      model: model.id,
      api: model.api,
      provider: model.provider,
      cwd: this.cwd,
    })

    mkdirSync(this.sessionDir, { recursive: true })

    const tools = createCodingTools(this.cwd)

    const customTools = createCustomTools({
      cwd: this.cwd,
      getWebSearchConfig: () => this.configService.getWebSearchConfig(),
    })
    if (customTools.length > 0) {
      console.log('[agent] Custom tools enabled:', customTools.map((t) => t.name).join(', '))
    }

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      appendSystemPromptOverride: (base) =>
        this.currentMemoryContext ? [...base, this.currentMemoryContext] : base,
      systemPromptOverride: () => SYSTEM_PROMPT,
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
    })
    await resourceLoader.reload()

    this.syncRuntimeApiKeys()

    const { session } = await createAgentSession({
      model,
      tools,
      customTools,
      sessionManager,
      resourceLoader,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    })

    this.session = session
    this.unsubscribe = session.subscribe(this.handleEvent.bind(this))
  }

  private resolveModel(): Model<Api> {
    if (this.currentModelKey) {
      const parsed = parseModelKey(this.currentModelKey)
      if (!parsed) throw new Error(`Invalid model key: ${this.currentModelKey}`)
      const result = this.registry.createModelForId(parsed.providerId, parsed.modelId)
      if ('error' in result) throw new Error(`Cannot create model: ${result.error}`)
      return result
    }

    const result = this.registry.createActiveModel()
    if ('error' in result) throw new Error(`No model available: ${result.error}`)
    this.currentModelKey = this.configService.getActiveModelId()
    return result
  }

  private cleanup(): void {
    this.unsubscribe?.()
    this.session?.dispose()
    this.session = null as never
    this.unsubscribe = null
    this.currentMemoryContext = ''
    this.currentInjectedMemoryIds = []
    this.activeTurn = null
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

    this.syncedProviderNames = new Set(nextRuntimeKeys.keys())
  }

  private buildUIMessages(sessionManager: SessionManager): UIMessage[] {
    const entries = sessionManager.getEntries()
    const { messages: agentMessages } = buildSessionContext(entries)

    const uiMessages: UIMessage[] = []
    const toolResultMap = new Map<string, ToolResultMessage>()

    for (const msg of agentMessages) {
      if ('role' in msg && msg.role === 'toolResult') {
        const tr = msg as ToolResultMessage
        toolResultMap.set(tr.toolCallId, tr)
      }
    }

    for (const msg of agentMessages) {
      if (!('role' in msg)) continue

      if (msg.role === 'user') {
        const userMsg = msg as UserMessage
        const text =
          typeof userMsg.content === 'string'
            ? userMsg.content
            : userMsg.content
                .filter((c) => c.type === 'text')
                .map((c) => (c as { text: string }).text)
                .join('')
        uiMessages.push({ role: 'user', content: text })
      } else if (msg.role === 'assistant') {
        const assistantMsg = msg as AssistantMessage
        const blocks: UIBlock[] = []

        for (const part of assistantMsg.content) {
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
                    .filter((c) => c.type === 'text')
                    .map((c) => (c as { text: string }).text)
                    .join('')
                : undefined,
              isError: toolResult?.isError,
              status: 'done',
            })
          }
        }

        if (blocks.length > 0) {
          uiMessages.push({ role: 'assistant', blocks })
        }
      }
    }

    return uiMessages
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleEvent(event: any): void {
    if (event.type === 'message_update') {
      console.log('[agent] event:', event.type, '→', event.assistantMessageEvent?.type)
    } else {
      console.log('[agent] event:', event.type)
    }

    switch (event.type) {
      case 'message_update': {
        const e = event.assistantMessageEvent
        switch (e.type) {
          case 'text_delta':
            if (this.activeTurn) {
              this.activeTurn.assistantText += e.delta
            }
            this.send('agent:text-delta', e.delta)
            break
          case 'thinking_delta':
            this.send('agent:thinking-delta', e.delta)
            break
          case 'error':
            console.error('[agent] assistant error:', e.error)
            this.send('agent:error', {
              message: e.error?.errorMessage || 'Unknown error',
            })
            break
        }
        break
      }
      case 'tool_execution_start':
        this.send('agent:tool-start', {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
        })
        break
      case 'tool_execution_end':
        this.send('agent:tool-end', {
          id: event.toolCallId,
          name: event.toolName,
          result:
            typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2),
          isError: event.isError,
        })
        break
    }
  }

  private send(channel: string, data?: unknown): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, data)
    }
  }
}
