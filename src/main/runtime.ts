import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ChatMessage,
  streamChat as defaultStreamChat,
  getModelInfo,
  type ModelSelection,
} from './agent'
import {
  AGENT_PROFILES,
  type AgentProfile,
  type AgentProfileId,
  type BuiltinAgentProfileId,
  isBuiltinAgentProfileId,
  normalizeChatAgentProfileId,
} from './agent-profile'
import { buildAgentContext } from './context'
import {
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  appendAgentEventAndTouchConversation,
  appendMessage,
  type ConversationRecord,
  getConversation,
  type PersistedImageBlock,
  type PersistedMessage,
  type PersistedTextBlock,
  deleteConversation as removeConversation,
  setConversationUsage,
} from './conversations'
import { imageNameFromUrl } from './image-store'
import { getImagesDir } from './paths'
import { type AgentRuntimeEvent, createRuntimeEvent } from './runtime-events'
import {
  createDefaultToolRegistry,
  type ToolContext,
  type ToolPack,
  type ToolRegistry,
} from './tools'

interface StreamSlot {
  controller: AbortController
  cleanup: Promise<void>
  assistantMessageId: string
  selection: ModelSelection
  abortRecorded: boolean
}

type MaybePromise<T> = T | Promise<T>

export type ConversationAbortReason = 'user' | 'delete' | 'shutdown'

function messageText(message: PersistedMessage): string {
  return message.blocks
    .filter((block): block is PersistedTextBlock => block.type === 'text')
    .map((block) => block.content)
    .join('')
}

function resolveRetryTurn(record: ConversationRecord): {
  userMessage: PersistedMessage
  record: ConversationRecord
} {
  const lastIndex = record.messages.length - 1
  const lastMessage = record.messages[lastIndex]
  if (!lastMessage) throw new Error('cannot retry: conversation has no messages')

  if (lastMessage.role === 'user') {
    return { userMessage: lastMessage, record }
  }

  if (lastMessage.role !== 'assistant' || lastMessage.status !== 'error') {
    throw new Error('cannot retry: last persisted turn is not retryable')
  }

  for (let i = lastIndex - 1; i >= 0; i--) {
    const candidate = record.messages[i]
    if (candidate?.role === 'user') {
      return {
        userMessage: candidate,
        record: {
          ...record,
          messages: record.messages.slice(0, lastIndex),
        },
      }
    }
  }

  throw new Error('cannot retry: failed assistant turn has no preceding user message')
}

export interface RuntimeSendInput {
  conversationId: string
  userText: string
  selection: ModelSelection
  requestedProfileId?: AgentProfileId
  transientContext?: ChatMessage[]
}

export interface RuntimeRetryLastInput {
  conversationId: string
  selection: ModelSelection
  requestedProfileId?: AgentProfileId
  transientContext?: ChatMessage[]
}

export interface RuntimeSendResult {
  userMessage: PersistedMessage
  assistantMessageId: string
}

export interface ActiveAssistantTurn {
  conversationId: string
  assistantMessageId: string
  selection: ModelSelection
}

export {
  type AgentRuntimeEvent,
  type AgentRuntimeEventMap,
  AILA_RUNTIME_EVENT_SCHEMA_VERSION,
  AILA_RUNTIME_EVENT_TYPES,
  type AilaRuntimeEventType,
  createRuntimeEvent,
  isRuntimeEventType,
} from './runtime-events'

export interface AgentRuntimeOptions {
  onEvent?: (event: AgentRuntimeEvent) => void
  onToolApproval?: ToolContext['onToolApproval']
  onConversationAbort?: (
    conversationId: string,
    reason: ConversationAbortReason,
  ) => MaybePromise<void>
  profiles?: readonly AgentProfile[]
  loadProfiles?: () => Promise<readonly AgentProfile[]>
  toolPacks?: readonly ToolPack[]
  loadToolPacks?: () => Promise<readonly ToolPack[]>
  workspaceRoots?: ToolContext['workspaceRoots'] | (() => ToolContext['workspaceRoots'])
  streamChat?: typeof defaultStreamChat
  logger?: Pick<Console, 'error' | 'warn'>
}

export class AgentRuntime {
  private readonly activeStreams = new Map<string, StreamSlot>()
  private readonly logger: Pick<Console, 'error' | 'warn'>
  private readonly staticProfiles: readonly AgentProfile[]
  private readonly staticToolPacks: readonly ToolPack[]
  private readonly fallbackToolRegistry: ToolRegistry
  private profileLoad: Promise<Map<string, AgentProfile>> | null = null
  private toolRegistryLoad: Promise<ToolRegistry> | null = null

  constructor(private readonly options: AgentRuntimeOptions = {}) {
    this.logger = options.logger ?? console
    this.staticProfiles = options.profiles ?? []
    this.staticToolPacks = options.toolPacks ?? []
    this.fallbackToolRegistry = createDefaultToolRegistry(this.staticToolPacks)
  }

  async getProfiles(): Promise<Map<string, AgentProfile>> {
    if (!this.options.loadProfiles) return this.buildProfileMap(this.staticProfiles)
    if (!this.profileLoad) this.profileLoad = this.loadProfiles()
    return this.profileLoad
  }

  async reloadProfiles(): Promise<Map<string, AgentProfile>> {
    this.profileLoad = null
    return this.getProfiles()
  }

  async getToolRegistry(): Promise<ToolRegistry> {
    if (!this.options.loadToolPacks) return this.fallbackToolRegistry
    if (!this.toolRegistryLoad) this.toolRegistryLoad = this.loadToolRegistry()
    return this.toolRegistryLoad
  }

  async reloadToolPacks(): Promise<ToolRegistry> {
    this.toolRegistryLoad = null
    return this.getToolRegistry()
  }

  async send(input: RuntimeSendInput): Promise<RuntimeSendResult> {
    const { conversationId, userText, selection, requestedProfileId, transientContext } = input

    // Wait for any prior stream on this conversation to finish its persistence
    // side-effects before appending the next user message.
    const previous = this.activeStreams.get(conversationId)
    if (previous) await previous.cleanup.catch(() => {})

    const userMessage: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: randomUUID(),
      role: 'user',
      blocks: [{ type: 'text', content: userText }],
      status: 'done',
    }
    await this.persistAndAnnounce(conversationId, userMessage)

    const record = await getConversation(conversationId)
    return this.startAssistantTurn({
      conversationId,
      userMessage,
      record,
      selection,
      requestedProfileId,
      transientContext,
    })
  }

  async retryLastUserMessage(input: RuntimeRetryLastInput): Promise<RuntimeSendResult> {
    const { conversationId, selection, requestedProfileId, transientContext } = input

    const previous = this.activeStreams.get(conversationId)
    if (previous) await previous.cleanup.catch(() => {})

    const record = await getConversation(conversationId)
    const retry = resolveRetryTurn(record)

    if (!messageText(retry.userMessage).trim()) {
      throw new Error('cannot retry: last persisted user message has no text content')
    }

    return this.startAssistantTurn({
      conversationId,
      userMessage: retry.userMessage,
      record: retry.record,
      selection,
      requestedProfileId,
      transientContext,
    })
  }

  private async startAssistantTurn(input: {
    conversationId: string
    userMessage: PersistedMessage
    record: ConversationRecord
    selection: ModelSelection
    requestedProfileId?: AgentProfileId
    transientContext?: ChatMessage[]
  }): Promise<RuntimeSendResult> {
    const { conversationId, userMessage, record, selection, requestedProfileId, transientContext } =
      input
    const assistantMessageId = randomUUID()
    const controller = new AbortController()
    let resolveCleanup: () => void = () => {}
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve
    })
    this.activeStreams.set(conversationId, {
      controller,
      cleanup,
      assistantMessageId,
      selection,
      abortRecorded: false,
    })

    const profile = await this.resolveProfile(requestedProfileId)
    const profileId = profile.baseProfileId

    const context = buildAgentContext({
      messages: record.messages,
      modelInfo: getModelInfo(selection.providerId, selection.modelId),
      profileInstructions: profile.instructions,
      transientContext,
    })
    const toolRegistry = await this.getToolRegistry()

    void this.runStream({
      conversationId,
      assistantMessageId,
      selection,
      controller,
      resolveCleanup,
      profileId,
      messages: context.messages,
      workspaceRoots: this.resolveWorkspaceRoots(),
      toolRegistry,
    })

    return { userMessage, assistantMessageId }
  }

  async abort(conversationId: string): Promise<void> {
    const slot = this.activeStreams.get(conversationId)
    if (!slot) return
    slot.controller.abort()
    const abortCleanup = this.notifyConversationAbort(conversationId, 'user')
    if (slot.abortRecorded) {
      await abortCleanup
      return
    }
    slot.abortRecorded = true
    try {
      await this.recordAgentEvent({
        timestamp: Date.now(),
        conversationId,
        messageId: slot.assistantMessageId,
        type: 'turn.cancelled',
        data: { phase: 'requested', reason: 'user' },
      })
    } catch (err) {
      this.logger.warn('[runtime] cancellation activity append failed:', err)
    } finally {
      await abortCleanup
    }
  }

  listActiveStreams(): ActiveAssistantTurn[] {
    return Array.from(this.activeStreams.entries()).map(([conversationId, slot]) => ({
      conversationId,
      assistantMessageId: slot.assistantMessageId,
      selection: slot.selection,
    }))
  }

  abortAll(): void {
    for (const [conversationId, slot] of this.activeStreams.entries()) {
      slot.controller.abort()
      void this.notifyConversationAbort(conversationId, 'shutdown')
    }
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const slot = this.activeStreams.get(conversationId)
    if (slot) {
      slot.controller.abort()
      await this.notifyConversationAbort(conversationId, 'delete')
      await slot.cleanup.catch(() => {})
    } else {
      await this.notifyConversationAbort(conversationId, 'delete')
    }

    try {
      const record = await getConversation(conversationId)
      const imagesDir = getImagesDir()
      const filenames = record.messages.flatMap((message) =>
        message.blocks
          .filter((block): block is PersistedImageBlock => block.type === 'image')
          .map((block) => imageNameFromUrl(block.url))
          .filter((name): name is string => name !== null),
      )
      await Promise.all(filenames.map((name) => unlink(join(imagesDir, name)).catch(() => {})))
    } catch (err) {
      this.logger.warn('[runtime] conversation image cleanup failed:', err)
    }

    await removeConversation(conversationId)
  }

  private async persistAndAnnounce(
    conversationId: string,
    message: PersistedMessage,
  ): Promise<void> {
    const summary = await appendMessage(conversationId, message)
    this.emit(createRuntimeEvent('conversations:updated', summary))
  }

  private emit(event: AgentRuntimeEvent): void {
    this.options.onEvent?.(event)
  }

  private async recordAgentEvent(
    event: Parameters<typeof appendAgentEventAndTouchConversation>[1],
  ): Promise<void> {
    const { event: persisted, summary } = await appendAgentEventAndTouchConversation(
      event.conversationId,
      event,
    )
    this.emit(createRuntimeEvent('agent:event', persisted))
    if (summary) this.emit(createRuntimeEvent('conversations:updated', summary))
  }

  private resolveWorkspaceRoots(): ToolContext['workspaceRoots'] {
    const roots = this.options.workspaceRoots
    return typeof roots === 'function' ? roots() : roots
  }

  private async notifyConversationAbort(
    conversationId: string,
    reason: ConversationAbortReason,
  ): Promise<void> {
    try {
      await this.options.onConversationAbort?.(conversationId, reason)
    } catch (error) {
      this.logger.warn('[runtime] conversation abort cleanup failed:', error)
    }
  }

  private buildProfileMap(extraProfiles: readonly AgentProfile[]): Map<string, AgentProfile> {
    const profiles = new Map<string, AgentProfile>(Object.entries(AGENT_PROFILES))
    for (const profile of extraProfiles) profiles.set(profile.id, profile)
    return profiles
  }

  private async loadProfiles(): Promise<Map<string, AgentProfile>> {
    try {
      const loaded = await this.options.loadProfiles?.()
      return this.buildProfileMap([...this.staticProfiles, ...(loaded ?? [])])
    } catch (error) {
      this.logger.warn(
        '[runtime] profile load failed; continuing with built-in/static profiles:',
        error,
      )
      return this.buildProfileMap(this.staticProfiles)
    }
  }

  private async resolveProfile(
    requestedProfileId: AgentProfileId | undefined,
  ): Promise<{ baseProfileId: BuiltinAgentProfileId; instructions?: string }> {
    const profiles = await this.getProfiles()
    const requested = requestedProfileId ? profiles.get(requestedProfileId) : undefined

    if (requested) {
      const baseProfileId = requested.baseProfileId ?? normalizeChatAgentProfileId(requested.id)
      return {
        baseProfileId: isBuiltinAgentProfileId(baseProfileId) ? baseProfileId : 'chat',
        ...(requested.instructions && { instructions: requested.instructions }),
      }
    }

    return { baseProfileId: normalizeChatAgentProfileId(requestedProfileId) }
  }

  private async loadToolRegistry(): Promise<ToolRegistry> {
    try {
      const loaded = await this.options.loadToolPacks?.()
      return createDefaultToolRegistry([...this.staticToolPacks, ...(loaded ?? [])])
    } catch (error) {
      this.logger.warn(
        '[runtime] tool-pack load failed; continuing with built-in/static tools:',
        error,
      )
      return this.fallbackToolRegistry
    }
  }

  private async runStream(input: {
    conversationId: string
    assistantMessageId: string
    selection: ModelSelection
    controller: AbortController
    resolveCleanup: () => void
    profileId: AgentProfileId
    messages: Parameters<typeof defaultStreamChat>[0]['messages']
    workspaceRoots?: ToolContext['workspaceRoots']
    toolRegistry: ToolRegistry
  }): Promise<void> {
    const {
      conversationId,
      assistantMessageId,
      selection,
      controller,
      resolveCleanup,
      profileId,
      messages,
      workspaceRoots,
      toolRegistry,
    } = input
    let eventLogChain = Promise.resolve()
    let terminalAgentEventQueued = false
    const queueAgentEvent = (
      event: Parameters<typeof appendAgentEventAndTouchConversation>[1],
    ): void => {
      if (
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        (event.type === 'turn.cancelled' && event.data?.phase === 'completed')
      ) {
        terminalAgentEventQueued = true
      }
      eventLogChain = eventLogChain
        .then(() => this.recordAgentEvent(event))
        .catch((err) => {
          this.logger.warn('[runtime] agent-event append failed:', err)
        })
    }

    try {
      const streamChat = this.options.streamChat ?? defaultStreamChat
      await streamChat(
        {
          conversationId,
          assistantMessageId,
          messages,
          selection,
          signal: controller.signal,
          profileId,
          workspaceRoots,
          onToolApproval: this.options.onToolApproval,
          onAgentEvent: queueAgentEvent,
          toolRegistry,
        },
        {
          onTextDelta: (event) => this.emit(createRuntimeEvent('chat:text-delta', event)),
          onReasoningDelta: (event) => this.emit(createRuntimeEvent('chat:reasoning-delta', event)),
          onToolCallStart: (event) => this.emit(createRuntimeEvent('chat:tool-call-start', event)),
          onToolCallArgsDelta: (event) =>
            this.emit(createRuntimeEvent('chat:tool-call-args-delta', event)),
          onToolCallResult: (event) =>
            this.emit(createRuntimeEvent('chat:tool-call-result', event)),
          onImageBlock: (event) => this.emit(createRuntimeEvent('chat:image-block', event)),
          onDone: async (event) => {
            await this.persistAndAnnounce(conversationId, event.message)
            if (event.usage) {
              const summary = await setConversationUsage(conversationId, event.usage)
              this.emit(createRuntimeEvent('conversations:updated', summary))
            }
            this.emit(createRuntimeEvent('chat:done', event))
          },
          onError: async (event) => {
            await this.persistAndAnnounce(conversationId, event.message)
            this.emit(createRuntimeEvent('chat:error', event))
          },
        },
      )
    } catch (err) {
      const isAbort = controller.signal.aborted
      const message = isAbort ? 'Aborted' : err instanceof Error ? err.message : String(err)
      if (!isAbort) this.logger.error('[runtime] unexpected stream error:', message)
      const errored: PersistedMessage = {
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: assistantMessageId,
        role: 'assistant',
        blocks: [],
        status: 'error',
        error: message,
        model: selection,
      }
      await this.persistAndAnnounce(conversationId, errored).catch(() => {})
      this.emit(
        createRuntimeEvent('chat:error', {
          conversationId,
          messageId: assistantMessageId,
          error: message,
          message: errored,
        }),
      )
      if (!terminalAgentEventQueued) {
        queueAgentEvent({
          timestamp: Date.now(),
          conversationId,
          messageId: assistantMessageId,
          type: isAbort ? 'turn.cancelled' : 'turn.failed',
          data: isAbort ? { phase: 'completed', reason: 'abort_signal' } : { error: message },
        })
      }
    } finally {
      if (this.activeStreams.get(conversationId)?.controller === controller) {
        this.activeStreams.delete(conversationId)
      }
      await eventLogChain
      resolveCleanup()
    }
  }
}
