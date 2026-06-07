import { randomUUID } from 'node:crypto'
import {
  type AgentEvent,
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
  type AgentEventAppendResult,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  createConversation as addConversation,
  appendAgentEventAndTouchConversation,
  type ConversationRecord,
  type ConversationSummary,
  createInterruptedConversationRecoveryEvent,
  type DocRefRewrite,
  getConversation,
  listAgentEvents,
  listConversations,
  type PersistedAgentEvent,
  type PersistedMessage,
  type PersistedTextBlock,
  recoverInterruptedConversationActivities,
  deleteConversation as removeConversation,
  renameConversation,
  replayConversationActivity,
  rewriteDocRefs as rewritePersistedDocRefs,
  setConversationUsage,
  upsertMessage,
} from './conversations'
import { type AgentRuntimeEvent, createRuntimeEvent } from './runtime-events'
import type { Settings } from './settings'
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
export type RuntimeRecordAgentEventInput = Parameters<
  typeof appendAgentEventAndTouchConversation
>[1]
type AgentEventInput = RuntimeRecordAgentEventInput

export type ConversationAbortReason = 'user' | 'delete' | 'shutdown'

const DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS = 5_000
const TURN_LIFECYCLE_EVENTS = new Set<AgentEvent['type']>([
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'turn.interrupted',
])

function messageText(message: PersistedMessage): string {
  return message.blocks
    .filter((block): block is PersistedTextBlock => block.type === 'text')
    .map((block) => block.content)
    .join('')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTurnSelection(event: AgentEventInput, selection: ModelSelection): AgentEventInput {
  if (!TURN_LIFECYCLE_EVENTS.has(event.type)) return event
  const data = event.data ?? {}
  if (typeof data.providerId === 'string' && typeof data.modelId === 'string') return event
  return {
    ...event,
    data: {
      ...data,
      ...(typeof data.providerId === 'string' ? {} : { providerId: selection.providerId }),
      ...(typeof data.modelId === 'string' ? {} : { modelId: selection.modelId }),
    },
  }
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

export interface RuntimeTransientContextInput {
  conversationId: string
  record: ConversationRecord
  selection: ModelSelection
  requestedProfileId?: AgentProfileId
  source: 'send' | 'retry'
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

export interface RuntimeCreateConversationInput {
  docId?: string | null
}

export interface RuntimeListConversationsInput {
  docId?: string | null
}

export interface RuntimeAppendUserMessageInput {
  conversationId: string
  text: string
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

export interface AgentRuntimeHost {
  onEvent?: (event: AgentRuntimeEvent) => void
  onToolPolicy?: ToolContext['onToolPolicy']
  onToolApproval?: ToolContext['onToolApproval']
  onConversationAbort?: (
    conversationId: string,
    reason: ConversationAbortReason,
  ) => MaybePromise<void>
  cleanupConversationAssets?: (record: ConversationRecord) => MaybePromise<void>
  profiles?: readonly AgentProfile[]
  loadProfiles?: () => Promise<readonly AgentProfile[]>
  toolPacks?: readonly ToolPack[]
  loadToolPacks?: () => Promise<readonly ToolPack[]>
  loadSettings?: () => MaybePromise<Settings>
  loadTransientContext?: (
    input: RuntimeTransientContextInput,
  ) => MaybePromise<ChatMessage[] | undefined>
  generateImage?: ToolContext['generateImage']
  saveImage?: ToolContext['saveImage']
  workspaceRoots?: ToolContext['workspaceRoots'] | (() => ToolContext['workspaceRoots'])
  shellCwd?: ToolContext['shellCwd'] | (() => ToolContext['shellCwd'])
  streamChat?: typeof defaultStreamChat
  logger?: Pick<Console, 'error' | 'warn'>
}

export interface AgentRuntimeOptions extends AgentRuntimeHost {
  host?: AgentRuntimeHost
  store?: AgentRuntimeStore
  profiles?: readonly AgentProfile[]
  toolPacks?: readonly ToolPack[]
  abortAllCleanupTimeoutMs?: number
}

export interface AgentRuntimeStore {
  createConversation?: (docId?: string) => Promise<ConversationSummary>
  getConversation: (conversationId: string) => Promise<ConversationRecord>
  upsertMessage: (conversationId: string, message: PersistedMessage) => Promise<ConversationSummary>
  appendAgentEventAndTouchConversation: (
    conversationId: string,
    event: Parameters<typeof appendAgentEventAndTouchConversation>[1],
  ) => Promise<AgentEventAppendResult>
  listConversations?: () => Promise<readonly ConversationSummary[]>
  listAgentEvents?: (conversationId: string) => Promise<readonly PersistedAgentEvent[]>
  recoverInterruptedConversationActivities?: (reason?: string) => Promise<ConversationSummary[]>
  renameConversation?: (conversationId: string, title: string) => Promise<ConversationSummary>
  rewriteDocRefs?: (rewrites: readonly DocRefRewrite[]) => Promise<readonly ConversationSummary[]>
  setConversationUsage: (
    conversationId: string,
    usage: { promptTokens: number; completionTokens: number; totalTokens: number },
  ) => Promise<ConversationSummary>
  deleteConversation: (conversationId: string) => Promise<void>
}

const DEFAULT_RUNTIME_STORE: AgentRuntimeStore = {
  createConversation: addConversation,
  getConversation,
  upsertMessage,
  appendAgentEventAndTouchConversation,
  listConversations,
  listAgentEvents,
  recoverInterruptedConversationActivities,
  renameConversation,
  rewriteDocRefs: (rewrites) => rewritePersistedDocRefs([...rewrites]),
  setConversationUsage,
  deleteConversation: removeConversation,
}

function normalizeRuntimeHost(options: AgentRuntimeOptions): AgentRuntimeHost {
  const host: AgentRuntimeHost = {}
  if (options.onEvent) host.onEvent = options.onEvent
  if (options.onToolPolicy) host.onToolPolicy = options.onToolPolicy
  if (options.onToolApproval) host.onToolApproval = options.onToolApproval
  if (options.onConversationAbort) host.onConversationAbort = options.onConversationAbort
  if (options.cleanupConversationAssets) {
    host.cleanupConversationAssets = options.cleanupConversationAssets
  }
  if (options.loadProfiles) host.loadProfiles = options.loadProfiles
  if (options.loadToolPacks) host.loadToolPacks = options.loadToolPacks
  if (options.loadSettings) host.loadSettings = options.loadSettings
  if (options.loadTransientContext) host.loadTransientContext = options.loadTransientContext
  if (options.generateImage) host.generateImage = options.generateImage
  if (options.saveImage) host.saveImage = options.saveImage
  if (options.workspaceRoots !== undefined) host.workspaceRoots = options.workspaceRoots
  if (options.shellCwd !== undefined) host.shellCwd = options.shellCwd
  if (options.streamChat) host.streamChat = options.streamChat
  if (options.logger) host.logger = options.logger

  if (!options.host) return host
  if (options.host.onEvent) host.onEvent = options.host.onEvent
  if (options.host.onToolPolicy) host.onToolPolicy = options.host.onToolPolicy
  if (options.host.onToolApproval) host.onToolApproval = options.host.onToolApproval
  if (options.host.onConversationAbort) host.onConversationAbort = options.host.onConversationAbort
  if (options.host.cleanupConversationAssets) {
    host.cleanupConversationAssets = options.host.cleanupConversationAssets
  }
  if (options.host.loadProfiles) host.loadProfiles = options.host.loadProfiles
  if (options.host.loadToolPacks) host.loadToolPacks = options.host.loadToolPacks
  if (options.host.loadSettings) host.loadSettings = options.host.loadSettings
  if (options.host.loadTransientContext) {
    host.loadTransientContext = options.host.loadTransientContext
  }
  if (options.host.generateImage) host.generateImage = options.host.generateImage
  if (options.host.saveImage) host.saveImage = options.host.saveImage
  if (options.host.workspaceRoots !== undefined) host.workspaceRoots = options.host.workspaceRoots
  if (options.host.shellCwd !== undefined) host.shellCwd = options.host.shellCwd
  if (options.host.streamChat) host.streamChat = options.host.streamChat
  if (options.host.logger) host.logger = options.host.logger
  return host
}

function resolveStaticProfiles(options: AgentRuntimeOptions): readonly AgentProfile[] {
  return options.host?.profiles ?? options.profiles ?? []
}

function resolveStaticToolPacks(options: AgentRuntimeOptions): readonly ToolPack[] {
  return options.host?.toolPacks ?? options.toolPacks ?? []
}

export class AgentRuntime {
  private readonly activeStreams = new Map<string, StreamSlot>()
  private readonly deletedConversations = new Set<string>()
  private readonly host: AgentRuntimeHost
  private readonly store: AgentRuntimeStore
  private readonly logger: Pick<Console, 'error' | 'warn'>
  private readonly staticProfiles: readonly AgentProfile[]
  private readonly staticToolPacks: readonly ToolPack[]
  private readonly fallbackToolRegistry: ToolRegistry
  private shutdownPromise: Promise<void> | null = null
  private shutdownStarted = false
  private profileLoad: Promise<Map<string, AgentProfile>> | null = null
  private toolRegistryLoad: Promise<ToolRegistry> | null = null

  constructor(private readonly options: AgentRuntimeOptions = {}) {
    this.host = normalizeRuntimeHost(options)
    this.store = options.store ?? DEFAULT_RUNTIME_STORE
    this.logger = this.host.logger ?? console
    this.staticProfiles = resolveStaticProfiles(options)
    this.staticToolPacks = resolveStaticToolPacks(options)
    this.fallbackToolRegistry = createDefaultToolRegistry(this.staticToolPacks)
  }

  async getProfiles(): Promise<Map<string, AgentProfile>> {
    if (!this.host.loadProfiles) return this.buildProfileMap(this.staticProfiles)
    if (!this.profileLoad) this.profileLoad = this.loadProfiles()
    return this.profileLoad
  }

  async reloadProfiles(): Promise<Map<string, AgentProfile>> {
    this.profileLoad = null
    return this.getProfiles()
  }

  async getToolRegistry(): Promise<ToolRegistry> {
    if (!this.host.loadToolPacks) return this.fallbackToolRegistry
    if (!this.toolRegistryLoad) this.toolRegistryLoad = this.loadToolRegistry()
    return this.toolRegistryLoad
  }

  async reloadToolPacks(): Promise<ToolRegistry> {
    this.toolRegistryLoad = null
    return this.getToolRegistry()
  }

  async createConversation(
    input: RuntimeCreateConversationInput = {},
  ): Promise<ConversationSummary> {
    if (!this.store.createConversation) throw new Error('runtime store cannot create conversations')
    const summary = await this.store.createConversation(input.docId ?? undefined)
    this.emit(createRuntimeEvent('conversations:updated', summary))
    return summary
  }

  async listConversations(
    input: RuntimeListConversationsInput = {},
  ): Promise<ConversationSummary[]> {
    if (!this.store.listConversations) throw new Error('runtime store cannot list conversations')
    const conversations = [...(await this.store.listConversations())]
    if (input.docId === undefined) return conversations
    if (input.docId === null) return conversations.filter((summary) => !summary.docId)
    return conversations.filter((summary) => summary.docId === input.docId)
  }

  getConversation(conversationId: string): Promise<ConversationRecord> {
    return this.store.getConversation(conversationId)
  }

  async listAgentEvents(conversationId: string): Promise<PersistedAgentEvent[]> {
    if (!this.store.listAgentEvents) throw new Error('runtime store cannot list agent events')
    return [...(await this.store.listAgentEvents(conversationId))]
  }

  async renameConversation(conversationId: string, title: string): Promise<ConversationSummary> {
    if (!this.store.renameConversation) throw new Error('runtime store cannot rename conversations')
    const summary = await this.store.renameConversation(conversationId, title)
    this.emit(createRuntimeEvent('conversations:updated', summary))
    return summary
  }

  async rewriteDocRefs(rewrites: readonly DocRefRewrite[]): Promise<ConversationSummary[]> {
    if (!this.store.rewriteDocRefs) throw new Error('runtime store cannot rewrite doc refs')
    const summaries = [...(await this.store.rewriteDocRefs(rewrites))]
    for (const summary of summaries) {
      this.emit(createRuntimeEvent('conversations:updated', summary))
    }
    return summaries
  }

  async appendUserMessage(input: RuntimeAppendUserMessageInput): Promise<PersistedMessage> {
    const { conversationId, text } = input
    this.assertCanStartTurn(conversationId)
    const message: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: randomUUID(),
      role: 'user',
      blocks: [{ type: 'text', content: text }],
      status: 'done',
    }
    if (!(await this.persistAndAnnounce(conversationId, message))) {
      this.assertConversationOpen(conversationId)
      throw new Error('conversation was deleted')
    }
    return message
  }

  async send(input: RuntimeSendInput): Promise<RuntimeSendResult> {
    const { conversationId, userText, selection, requestedProfileId, transientContext } = input

    this.assertCanStartTurn(conversationId)

    // Wait for any prior stream on this conversation to finish its persistence
    // side-effects before appending the next user message.
    const previous = this.activeStreams.get(conversationId)
    if (previous) await this.waitForPriorStreamBeforeNextTurn(conversationId, previous)
    this.assertCanStartTurn(conversationId)

    const userMessage: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: randomUUID(),
      role: 'user',
      blocks: [{ type: 'text', content: userText }],
      status: 'done',
    }
    if (!(await this.persistAndAnnounce(conversationId, userMessage))) {
      this.assertConversationOpen(conversationId)
      throw new Error('conversation was deleted')
    }
    this.assertCanStartTurn(conversationId)

    const record = await this.store.getConversation(conversationId)
    this.assertCanStartTurn(conversationId)
    return this.startAssistantTurn({
      conversationId,
      userMessage,
      record,
      selection,
      requestedProfileId,
      transientContext,
      source: 'send',
    })
  }

  async retryLastUserMessage(input: RuntimeRetryLastInput): Promise<RuntimeSendResult> {
    const { conversationId, selection, requestedProfileId, transientContext } = input

    this.assertCanStartTurn(conversationId)
    const previous = this.activeStreams.get(conversationId)
    if (previous) await this.waitForPriorStreamBeforeNextTurn(conversationId, previous)
    this.assertCanStartTurn(conversationId)

    const record = await this.store.getConversation(conversationId)
    this.assertCanStartTurn(conversationId)
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
      source: 'retry',
    })
  }

  private async startAssistantTurn(input: {
    conversationId: string
    userMessage: PersistedMessage
    record: ConversationRecord
    selection: ModelSelection
    requestedProfileId?: AgentProfileId
    transientContext?: ChatMessage[]
    source: RuntimeTransientContextInput['source']
  }): Promise<RuntimeSendResult> {
    const {
      conversationId,
      userMessage,
      record,
      selection,
      requestedProfileId,
      transientContext,
      source,
    } = input
    const assistantMessageId = randomUUID()
    this.assertCanStartTurn(conversationId)

    let profileId: AgentProfileId
    let messages: Parameters<typeof defaultStreamChat>[0]['messages']
    let workspaceRoots: ToolContext['workspaceRoots']
    let toolRegistry: ToolRegistry
    try {
      const profile = await this.resolveProfile(requestedProfileId)
      profileId = profile.baseProfileId

      const context = buildAgentContext({
        messages: record.messages,
        modelInfo: getModelInfo(selection.providerId, selection.modelId),
        profileInstructions: profile.instructions,
        transientContext:
          transientContext ??
          (await this.resolveTransientContext({
            conversationId,
            record,
            selection,
            requestedProfileId,
            source,
          })),
      })
      messages = context.messages
      toolRegistry = await this.getToolRegistry()
      workspaceRoots = this.resolveWorkspaceRoots()
    } catch (error) {
      await this.persistSetupFailure(
        conversationId,
        assistantMessageId,
        selection,
        errorMessage(error),
      )
      this.assertConversationOpen(conversationId)
      return { userMessage, assistantMessageId }
    }
    this.assertCanStartTurn(conversationId)

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

    void this.runStream({
      conversationId,
      assistantMessageId,
      selection,
      controller,
      resolveCleanup,
      profileId,
      messages,
      workspaceRoots,
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
      await this.recordAgentEvent(
        withTurnSelection(
          {
            timestamp: Date.now(),
            conversationId,
            messageId: slot.assistantMessageId,
            type: 'turn.cancelled',
            data: { phase: 'requested', reason: 'user' },
          },
          slot.selection,
        ),
      )
    } catch (err) {
      this.logger.warn('[runtime] cancellation activity append failed:', err)
    } finally {
      await abortCleanup
    }
    const cleanedUp = await this.waitForStreamCleanup(slot, this.cleanupTimeoutMs())
    if (!cleanedUp) {
      if (this.activeStreams.get(conversationId)?.controller === slot.controller) {
        this.activeStreams.delete(conversationId)
      }
      try {
        await this.recordInterruptedStreamCleanup(conversationId, slot, 'user cleanup timed out')
      } catch (err) {
        this.logger.warn('[runtime] interrupted abort activity append failed:', err)
      }
    }
  }

  listActiveStreams(): ActiveAssistantTurn[] {
    return Array.from(this.activeStreams.entries()).map(([conversationId, slot]) => ({
      conversationId,
      assistantMessageId: slot.assistantMessageId,
      selection: slot.selection,
    }))
  }

  async recoverInterruptedActivities(
    reason = 'runtime restarted before this turn finished',
  ): Promise<ConversationSummary[]> {
    if (this.store.recoverInterruptedConversationActivities) {
      const recovered = await this.store.recoverInterruptedConversationActivities(reason)
      for (const summary of recovered) {
        this.emit(createRuntimeEvent('conversations:updated', summary))
      }
      return [...recovered].sort((a, b) => b.updatedAt - a.updatedAt)
    }

    if (!this.store.listConversations || !this.store.listAgentEvents) return []

    const conversations = await this.store.listConversations()
    const recovered: ConversationSummary[] = []
    await Promise.all(
      conversations.map(async (summary) => {
        const events = await this.store.listAgentEvents?.(summary.id)
        if (!events) return
        const recoveryEvent = createInterruptedConversationRecoveryEvent(events, {
          reason,
          activity: replayConversationActivity(events) ?? summary.activity,
        })
        if (!recoveryEvent) return
        const { event, summary: nextSummary } =
          await this.store.appendAgentEventAndTouchConversation(summary.id, recoveryEvent)
        this.emit(createRuntimeEvent('agent:event', event))
        if (!nextSummary) return
        this.emit(createRuntimeEvent('conversations:updated', nextSummary))
        recovered.push(nextSummary)
      }),
    )
    return recovered.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async abortAll(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    const cleanupTimeoutMs =
      this.options.abortAllCleanupTimeoutMs ?? DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS
    await Promise.all(
      Array.from(this.activeStreams.entries()).map(async ([conversationId, slot]) => {
        slot.controller.abort()
        const abortCleanup = this.notifyConversationAbort(conversationId, reason)
        if (!slot.abortRecorded) {
          slot.abortRecorded = true
          try {
            await this.recordAgentEvent(
              withTurnSelection(
                {
                  timestamp: Date.now(),
                  conversationId,
                  messageId: slot.assistantMessageId,
                  type: 'turn.cancelled',
                  data: { phase: 'requested', reason },
                },
                slot.selection,
              ),
            )
          } catch (err) {
            this.logger.warn('[runtime] cancellation activity append failed:', err)
          }
        }
        await abortCleanup
        const cleanedUp = await this.waitForStreamCleanup(slot, cleanupTimeoutMs)
        if (!cleanedUp) {
          if (this.activeStreams.get(conversationId)?.controller === slot.controller) {
            this.activeStreams.delete(conversationId)
          }
          try {
            await this.recordInterruptedStreamCleanup(
              conversationId,
              slot,
              `${reason} cleanup timed out`,
            )
          } catch (err) {
            this.logger.warn('[runtime] interrupted shutdown activity append failed:', err)
          }
        }
      }),
    )
  }

  shutdown(reason: ConversationAbortReason = 'shutdown'): Promise<void> {
    this.shutdownStarted = true
    if (!this.shutdownPromise) this.shutdownPromise = this.abortAll(reason)
    return this.shutdownPromise
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.deletedConversations.add(conversationId)
    let removed = false
    try {
      const slot = this.activeStreams.get(conversationId)
      if (slot) {
        slot.controller.abort()
        await this.notifyConversationAbort(conversationId, 'delete')
        const cleanedUp = await this.waitForStreamCleanup(
          slot,
          this.options.abortAllCleanupTimeoutMs ?? DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS,
        )
        if (!cleanedUp && this.activeStreams.get(conversationId)?.controller === slot.controller) {
          this.activeStreams.delete(conversationId)
        }
      } else {
        await this.notifyConversationAbort(conversationId, 'delete')
      }

      await this.cleanupConversationAssets(conversationId)

      await this.store.deleteConversation(conversationId)
      removed = true
    } finally {
      if (!removed) this.deletedConversations.delete(conversationId)
    }
  }

  private async persistAndAnnounce(
    conversationId: string,
    message: PersistedMessage,
  ): Promise<boolean> {
    if (this.deletedConversations.has(conversationId)) return false
    const summary = await this.store.upsertMessage(conversationId, message)
    if (this.deletedConversations.has(conversationId)) return false
    this.emit(createRuntimeEvent('conversations:updated', summary))
    return true
  }

  private async persistSetupFailure(
    conversationId: string,
    assistantMessageId: string,
    selection: ModelSelection,
    message: string,
  ): Promise<void> {
    const errored: PersistedMessage = {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: assistantMessageId,
      role: 'assistant',
      blocks: [],
      status: 'error',
      error: message,
      model: selection,
    }
    const persisted = await this.persistAndAnnounce(conversationId, errored)
    if (!persisted) return
    try {
      await this.recordAgentEvent(
        withTurnSelection(
          {
            timestamp: Date.now(),
            conversationId,
            messageId: assistantMessageId,
            type: 'turn.failed',
            data: { phase: 'setup', error: message },
          },
          selection,
        ),
      )
    } catch (error) {
      this.logger.warn('[runtime] setup failure activity append failed:', error)
    }
    if (this.deletedConversations.has(conversationId)) return
    this.emit(
      createRuntimeEvent('chat:error', {
        conversationId,
        messageId: assistantMessageId,
        error: message,
        message: errored,
      }),
    )
  }

  private emit(event: AgentRuntimeEvent): void {
    this.host.onEvent?.(event)
  }

  private emitStreamEvent(
    conversationId: string,
    controller: AbortController,
    event: AgentRuntimeEvent,
  ): void {
    if (!this.acceptsStreamEvents(conversationId, controller)) return
    this.emit(event)
  }

  async recordAgentEvent(event: RuntimeRecordAgentEventInput): Promise<boolean> {
    if (this.deletedConversations.has(event.conversationId)) return false
    const { event: persisted, summary } = await this.store.appendAgentEventAndTouchConversation(
      event.conversationId,
      event,
    )
    if (this.deletedConversations.has(event.conversationId)) return false
    this.emit(createRuntimeEvent('agent:event', persisted))
    if (summary) this.emit(createRuntimeEvent('conversations:updated', summary))
    return true
  }

  private resolveWorkspaceRoots(): ToolContext['workspaceRoots'] {
    const roots = this.host.workspaceRoots
    return typeof roots === 'function' ? roots() : roots
  }

  private resolveShellCwd(): ToolContext['shellCwd'] {
    const cwd = this.host.shellCwd
    return typeof cwd === 'function' ? cwd() : cwd
  }

  private async resolveSettings(): Promise<Settings | undefined> {
    return this.host.loadSettings?.()
  }

  private async resolveTransientContext(
    input: RuntimeTransientContextInput,
  ): Promise<ChatMessage[] | undefined> {
    return this.host.loadTransientContext?.(input)
  }

  private cleanupTimeoutMs(): number {
    return this.options.abortAllCleanupTimeoutMs ?? DEFAULT_ABORT_ALL_CLEANUP_TIMEOUT_MS
  }

  private assertConversationOpen(conversationId: string): void {
    if (this.deletedConversations.has(conversationId)) {
      throw new Error('conversation was deleted')
    }
  }

  private assertCanStartTurn(conversationId: string): void {
    if (this.shutdownStarted) throw new Error('runtime is shut down')
    this.assertConversationOpen(conversationId)
  }

  private async waitForPriorStreamBeforeNextTurn(
    conversationId: string,
    slot: StreamSlot,
  ): Promise<void> {
    if (!slot.controller.signal.aborted) {
      await slot.cleanup.catch(() => {})
      return
    }

    const cleanedUp = await this.waitForStreamCleanup(slot, this.cleanupTimeoutMs())
    if (cleanedUp) return

    if (this.activeStreams.get(conversationId)?.controller === slot.controller) {
      this.activeStreams.delete(conversationId)
    }
    await this.recordInterruptedStreamCleanup(conversationId, slot, 'aborted cleanup timed out')
  }

  private async recordInterruptedStreamCleanup(
    conversationId: string,
    slot: StreamSlot,
    reason: string,
  ): Promise<void> {
    await this.recordAgentEvent(
      withTurnSelection(
        {
          timestamp: Date.now(),
          conversationId,
          messageId: slot.assistantMessageId,
          type: 'turn.interrupted',
          data: {
            reason,
            previousState: 'cancelled',
            previousEventType: 'turn.cancelled',
            previousTitle: 'Stop requested',
          },
        },
        slot.selection,
      ),
    )
  }

  private acceptsStreamEvents(conversationId: string, controller: AbortController): boolean {
    if (this.deletedConversations.has(conversationId)) return false
    return this.activeStreams.get(conversationId)?.controller === controller
  }

  private async notifyConversationAbort(
    conversationId: string,
    reason: ConversationAbortReason,
  ): Promise<void> {
    try {
      await this.host.onConversationAbort?.(conversationId, reason)
    } catch (error) {
      this.logger.warn('[runtime] conversation abort cleanup failed:', error)
    }
  }

  private async cleanupConversationAssets(conversationId: string): Promise<void> {
    if (!this.host.cleanupConversationAssets) return
    try {
      const record = await this.store.getConversation(conversationId)
      await this.host.cleanupConversationAssets(record)
    } catch (err) {
      this.logger.warn('[runtime] conversation asset cleanup failed:', err)
    }
  }

  private async waitForStreamCleanup(slot: StreamSlot, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        slot.cleanup.catch(() => {}).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private buildProfileMap(extraProfiles: readonly AgentProfile[]): Map<string, AgentProfile> {
    const profiles = new Map<string, AgentProfile>(Object.entries(AGENT_PROFILES))
    for (const profile of extraProfiles) profiles.set(profile.id, profile)
    return profiles
  }

  private async loadProfiles(): Promise<Map<string, AgentProfile>> {
    try {
      const loaded = await this.host.loadProfiles?.()
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
      const loaded = await this.host.loadToolPacks?.()
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
    const shellCwd = this.resolveShellCwd()
    let eventLogChain = Promise.resolve()
    let terminalAgentEventQueued = false
    const queueAgentEvent = (event: AgentEventInput): void => {
      const eventWithSelection = withTurnSelection(event, selection)
      if (
        eventWithSelection.type === 'turn.completed' ||
        eventWithSelection.type === 'turn.failed' ||
        (eventWithSelection.type === 'turn.cancelled' &&
          eventWithSelection.data?.phase === 'completed')
      ) {
        terminalAgentEventQueued = true
      }
      if (!this.acceptsStreamEvents(conversationId, controller)) return
      eventLogChain = eventLogChain
        .then(async () => {
          await this.recordAgentEvent(eventWithSelection)
        })
        .catch((err) => {
          this.logger.warn('[runtime] agent-event append failed:', err)
        })
    }

    try {
      const streamChat = this.host.streamChat ?? defaultStreamChat
      const settings = await this.resolveSettings()
      await streamChat(
        {
          conversationId,
          assistantMessageId,
          messages,
          selection,
          signal: controller.signal,
          profileId,
          workspaceRoots,
          shellCwd,
          settings,
          generateImage: this.host.generateImage,
          saveImage: this.host.saveImage,
          onToolPolicy: this.host.onToolPolicy,
          onToolApproval: this.host.onToolApproval,
          onAgentEvent: queueAgentEvent,
          toolRegistry,
        },
        {
          onTextDelta: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createRuntimeEvent('chat:text-delta', event),
            ),
          onReasoningDelta: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createRuntimeEvent('chat:reasoning-delta', event),
            ),
          onToolCallStart: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createRuntimeEvent('chat:tool-call-start', event),
            ),
          onToolCallArgsDelta: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createRuntimeEvent('chat:tool-call-args-delta', event),
            ),
          onToolCallResult: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createRuntimeEvent('chat:tool-call-result', event),
            ),
          onImageBlock: (event) =>
            this.emitStreamEvent(
              conversationId,
              controller,
              createRuntimeEvent('chat:image-block', event),
            ),
          onDone: async (event) => {
            if (!this.acceptsStreamEvents(conversationId, controller)) return
            const persisted = await this.persistAndAnnounce(conversationId, event.message)
            if (!persisted || !this.acceptsStreamEvents(conversationId, controller)) return
            this.emit(createRuntimeEvent('chat:done', event))
            if (event.usage) {
              try {
                const summary = await this.store.setConversationUsage(conversationId, event.usage)
                this.emit(createRuntimeEvent('conversations:updated', summary))
              } catch (err) {
                this.logger.warn('[runtime] usage persistence failed:', err)
              }
            }
          },
          onError: async (event) => {
            if (!this.acceptsStreamEvents(conversationId, controller)) return
            const persisted = await this.persistAndAnnounce(conversationId, event.message)
            if (!persisted || !this.acceptsStreamEvents(conversationId, controller)) return
            this.emit(createRuntimeEvent('chat:error', event))
          },
        },
      )
    } catch (err) {
      const isAbort = controller.signal.aborted
      const message = isAbort ? 'Aborted' : err instanceof Error ? err.message : String(err)
      if (!isAbort) this.logger.error('[runtime] unexpected stream error:', message)
      if (this.acceptsStreamEvents(conversationId, controller)) {
        const errored: PersistedMessage = {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: assistantMessageId,
          role: 'assistant',
          blocks: [],
          status: 'error',
          error: message,
          model: selection,
        }
        const persisted = await this.persistAndAnnounce(conversationId, errored).catch(() => false)
        if (persisted && this.acceptsStreamEvents(conversationId, controller)) {
          this.emit(
            createRuntimeEvent('chat:error', {
              conversationId,
              messageId: assistantMessageId,
              error: message,
              message: errored,
            }),
          )
        }
        if (!terminalAgentEventQueued) {
          queueAgentEvent({
            timestamp: Date.now(),
            conversationId,
            messageId: assistantMessageId,
            type: isAbort ? 'turn.cancelled' : 'turn.failed',
            data: isAbort ? { phase: 'completed', reason: 'abort_signal' } : { error: message },
          })
        }
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
