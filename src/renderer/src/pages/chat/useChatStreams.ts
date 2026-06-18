/// <reference path="../../env.d.ts" />

/**
 * Per-conversation streaming buffers. Lifts what used to live in ChatPage refs
 * out into an app-level hook so multiple conversations can stream in parallel:
 * switching the active sidebar entry is purely a view change.
 *
 * Concurrency: at most one in-flight runtime send per conversation. Additional
 * sends pile into a per-conversation queue and fire after the previous done.
 *
 * IPC events from main are tagged with conversationId/messageId; the reducer
 * routes by conversationId so events for inactive conversations land in their
 * own buffer instead of clobbering the active view.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type {
  ActiveAssistantTurn,
  AilaExecutionMode,
  ChatAttachmentInput,
  ChatDoneEvent,
  ChatErrorEvent,
  ConversationRuntimeReplayState,
  ConversationSummary,
  ImageBlockEvent,
  ModelSelection,
  PersistedAgentEvent,
  PersistedMessage,
  PlanArtifact,
  ReasoningDeltaEvent,
  RuntimeCompactConversationResult,
  TextDeltaEvent,
  ToolCallArgsDeltaEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  UsageInfo,
} from '../../types'
import type { Block, FileBlock, ImageBlock, Message, TextBlock, ToolCallBlock } from './types'

export type QueuedRun =
  | {
      id: string
      kind: 'send'
      text: string
      attachments: ChatAttachmentInput[]
      selection: ModelSelection
      mode?: AilaExecutionMode
      planId?: string
    }
  | {
      id: string
      kind: 'retryLast'
      selection: ModelSelection
      mode?: AilaExecutionMode
      planId?: string
    }
  | {
      id: string
      kind: 'approvePlan'
      planId: string
      expectedRevisionId?: string
      selection: ModelSelection
    }

export interface ConversationStream {
  messages: Message[]
  displayMessages: Message[]
  isHydrated: boolean
  queue: QueuedRun[]
  runningMessageId: string | null
  usage: UsageInfo | null
  events: PersistedAgentEvent[]
  plans: PlanArtifact[]
}

type ConversationStreamState = Omit<ConversationStream, 'displayMessages'>

interface State {
  streams: Map<string, ConversationStreamState>
  droppedConversationIds: Set<string>
}

const EMPTY_STREAM: ConversationStreamState = {
  messages: [],
  isHydrated: false,
  queue: [],
  runningMessageId: null,
  usage: null,
  events: [],
  plans: [],
}

type Action =
  | {
      type: 'HYDRATE'
      conversationId: string
      messages: Message[]
      usage: UsageInfo | null
      events: PersistedAgentEvent[]
      plans?: PlanArtifact[]
      activeTurn?: ActiveAssistantTurn | null
      runtimeState?: ConversationRuntimeReplayState
    }
  | { type: 'ENQUEUE'; conversationId: string; queued: QueuedRun }
  | { type: 'POP_QUEUE_HEAD'; conversationId: string }
  | {
      type: 'RUN_STARTED'
      conversationId: string
      queuedId?: string
      userMessage: Message
      assistantMessage: Message
    }
  | {
      type: 'RETRY_STARTED'
      conversationId: string
      queuedId?: string
      assistantMessage: Message
    }
  | {
      type: 'TEXT_DELTA'
      conversationId: string
      messageId: string
      kind: 'text' | 'reasoning'
      delta: string
    }
  | {
      type: 'TOOL_CALL_START'
      conversationId: string
      messageId: string
      toolCallId: string
      name: string
      args: string
    }
  | {
      type: 'TOOL_CALL_ARGS_DELTA'
      conversationId: string
      messageId: string
      toolCallId: string
      delta: string
    }
  | {
      type: 'TOOL_CALL_RESULT'
      conversationId: string
      messageId: string
      toolCallId: string
      name?: string
      result: string
      isError: boolean
    }
  | {
      type: 'IMAGE_BLOCK'
      conversationId: string
      messageId: string
      block: ImageBlock
    }
  | {
      type: 'FINISH'
      conversationId: string
      messageId: string
      message: Message
      usage?: UsageInfo
    }
  | { type: 'CLEAR_QUEUE'; conversationId: string }
  | { type: 'SET_PLANS'; conversationId: string; plans: PlanArtifact[] }
  | { type: 'AGENT_EVENT'; event: PersistedAgentEvent }
  | { type: 'DROP'; conversationId: string }

function getStream(state: State, id: string): ConversationStreamState {
  return state.streams.get(id) ?? EMPTY_STREAM
}

function withStream(
  state: State,
  id: string,
  updater: (current: ConversationStreamState) => ConversationStreamState,
): State {
  const next = new Map(state.streams)
  next.set(id, updater(getStream(state, id)))
  return { ...state, streams: next }
}

function conversationIdForAction(action: Action): string {
  return action.type === 'AGENT_EVENT' ? action.event.conversationId : action.conversationId
}

function appendDelta(blocks: Block[], kind: 'text' | 'reasoning', delta: string): Block[] {
  if (!delta) return blocks
  const last = blocks[blocks.length - 1]
  if (last && last.type === kind) {
    return [...blocks.slice(0, -1), { type: kind, content: (last as TextBlock).content + delta }]
  }
  return [...blocks, { type: kind, content: delta }]
}

function upsertToolCall(
  blocks: Block[],
  toolCallId: string,
  updater: (block: ToolCallBlock) => ToolCallBlock,
  fallback: ToolCallBlock,
): Block[] {
  const idx = blocks.findIndex((b) => b.type === 'tool_call' && b.id === toolCallId)
  if (idx === -1) return [...blocks, fallback]
  const next = [...blocks]
  next[idx] = updater(next[idx] as ToolCallBlock)
  return next
}

function patchMessage(
  messages: Message[],
  messageId: string,
  patcher: (msg: Message) => Message,
): Message[] {
  return messages.map((m) => (m.id === messageId ? patcher(m) : m))
}

function createStreamingAssistantMessage(messageId: string, selection?: ModelSelection): Message {
  return {
    id: messageId,
    role: 'assistant',
    blocks: [],
    status: 'streaming',
    ...(selection ? { model: selection } : {}),
  }
}

function ensureAssistantMessage(
  messages: Message[],
  messageId: string,
  selection?: ModelSelection,
): Message[] {
  return messages.some((message) => message.id === messageId)
    ? messages
    : [...messages, createStreamingAssistantMessage(messageId, selection)]
}

function patchOrAppendAssistantMessage(
  messages: Message[],
  messageId: string,
  patcher: (msg: Message) => Message,
  selection?: ModelSelection,
): Message[] {
  const seeded = ensureAssistantMessage(messages, messageId, selection)
  return patchMessage(seeded, messageId, patcher)
}

function replaceOrAppendMessage(messages: Message[], message: Message): Message[] {
  return messages.some((candidate) => candidate.id === message.id)
    ? patchMessage(messages, message.id, () => message)
    : [...messages, message]
}

function appendMissingMessage(messages: Message[], message: Message): Message[] {
  return messages.some((candidate) => candidate.id === message.id)
    ? messages
    : [...messages, message]
}

function queuedAttachmentToBlock(attachment: ChatAttachmentInput): ImageBlock | FileBlock {
  if (attachment.kind === 'image') {
    return {
      type: 'image',
      url: `data:${attachment.mime};base64,${attachment.data}`,
      mime: attachment.mime,
    }
  }
  return { type: 'file', name: attachment.name, content: attachment.data }
}

function queuedSendBlocks(text: string, attachments: ChatAttachmentInput[]): Block[] {
  return [
    ...(text ? [{ type: 'text' as const, content: text }] : []),
    ...attachments.map(queuedAttachmentToBlock),
  ]
}

function queuedSendToMessage(
  queued: Extract<QueuedRun, { kind: 'send' }>,
  id: string,
  status: 'queued' | 'done',
): Message {
  return {
    id,
    role: 'user',
    blocks: queuedSendBlocks(queued.text, queued.attachments),
    status,
  }
}

function displayMessagesForStream(stream: ConversationStreamState): Message[] {
  return stream.messages
}

function materializeStream(stream: ConversationStreamState): ConversationStream {
  return {
    ...stream,
    displayMessages: displayMessagesForStream(stream),
  }
}

function removeQueuedRun(queue: QueuedRun[], queuedId?: string): QueuedRun[] {
  if (!queuedId) return queue
  return queue.filter((queued) => queued.id !== queuedId)
}

function finalizeAssistantMessageAsError(
  messages: Message[],
  messageId: string,
  error: string,
  selection?: ModelSelection,
): Message[] {
  const current = messages.find((message) => message.id === messageId)
  if (current && current.status !== 'streaming') return messages
  return patchOrAppendAssistantMessage(
    messages,
    messageId,
    (message) => ({
      ...message,
      status: 'error',
      error,
    }),
    selection,
  )
}

function insertMissingMessageBefore(
  messages: Message[],
  message: Message,
  beforeMessageId: string,
): Message[] {
  if (messages.some((candidate) => candidate.id === message.id)) return messages
  const beforeIndex = messages.findIndex((candidate) => candidate.id === beforeMessageId)
  if (beforeIndex === -1) return [...messages, message]
  return [...messages.slice(0, beforeIndex), message, ...messages.slice(beforeIndex)]
}

function hydrateMessages(messages: Message[], activeTurn?: ActiveAssistantTurn | null): Message[] {
  if (!activeTurn) return messages
  return ensureAssistantMessage(messages, activeTurn.assistantMessageId, activeTurn.selection)
}

function preferHydratedMessage(current: Message | undefined, incoming: Message): Message {
  if (!current) return incoming
  if (current.status === 'streaming' && incoming.status !== 'streaming') return incoming
  if (current.status !== 'streaming' && incoming.status === 'streaming') return current
  return incoming
}

function mergeHydratedMessages(
  current: Message[],
  incoming: Message[],
  activeTurn?: ActiveAssistantTurn | null,
): Message[] {
  const messagesById = new Map<string, Message>()
  for (const message of current) messagesById.set(message.id, message)
  for (const message of incoming) {
    messagesById.set(message.id, preferHydratedMessage(messagesById.get(message.id), message))
  }

  const merged: Message[] = []
  const pushed = new Set<string>()
  for (const message of [...incoming, ...current]) {
    const selected = messagesById.get(message.id)
    if (!selected || pushed.has(selected.id)) continue
    merged.push(selected)
    pushed.add(selected.id)
  }

  return hydrateMessages(merged, activeTurn)
}

function hasTerminalMessage(messages: Message[], messageId: string | null): boolean {
  if (!messageId) return false
  const message = messages.find((candidate) => candidate.id === messageId)
  return Boolean(message && message.status !== 'streaming')
}

function selectionFromAgentEventData(
  data: Record<string, unknown> | undefined,
): ModelSelection | undefined {
  const providerId = data?.providerId
  const modelId = data?.modelId
  return typeof providerId === 'string' && typeof modelId === 'string'
    ? { providerId: providerId as ModelSelection['providerId'], modelId }
    : undefined
}

function stringFromAgentEventData(
  data: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = data?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function assistantErrorFromAgentEvent(event: PersistedAgentEvent): string | null {
  if (event.type === 'turn.failed') {
    return stringFromAgentEventData(event.data, 'error') ?? 'Turn failed'
  }
  if (event.type === 'turn.cancelled' && event.data?.phase === 'completed') {
    const reason = stringFromAgentEventData(event.data, 'reason')
    return reason ? `Cancelled: ${reason}` : 'Cancelled'
  }
  if (event.type === 'turn.interrupted') {
    return stringFromAgentEventData(event.data, 'reason') ?? 'Interrupted'
  }
  return null
}

function assistantErrorFromRuntimeState(
  runtimeState: ConversationRuntimeReplayState | undefined,
  events: PersistedAgentEvent[],
): string | null {
  if (!runtimeState?.turn || runtimeState.active) return null
  if (
    runtimeState.phase !== 'failed' &&
    runtimeState.phase !== 'cancelled' &&
    runtimeState.phase !== 'interrupted'
  ) {
    return null
  }

  const replayEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.messageId === runtimeState.turn?.assistantMessageId &&
        event.type === runtimeState.turn.eventType,
    )
  const eventError = replayEvent ? assistantErrorFromAgentEvent(replayEvent) : null
  if (eventError) return eventError
  if (runtimeState.phase === 'failed') return 'Turn failed'
  if (runtimeState.phase === 'cancelled') return 'Cancelled'
  return 'Interrupted'
}

function shouldClearRunningFromAgentEvent(event: PersistedAgentEvent): boolean {
  return (
    event.type === 'turn.failed' ||
    event.type === 'turn.interrupted' ||
    (event.type === 'turn.cancelled' && event.data?.phase === 'completed')
  )
}

function agentEventKey(event: PersistedAgentEvent): string {
  return [
    event.timestamp,
    event.conversationId,
    event.messageId,
    event.type,
    JSON.stringify(event.data ?? {}),
  ].join(':')
}

function mergeAgentEvents(
  current: PersistedAgentEvent[],
  incoming: PersistedAgentEvent[],
): PersistedAgentEvent[] {
  const seen = new Set(current.map(agentEventKey))
  const next = [...current]
  for (const event of incoming) {
    const key = agentEventKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(event)
  }
  return next.sort((a, b) => a.timestamp - b.timestamp)
}

function reducer(state: State, action: Action): State {
  if (action.type !== 'DROP' && state.droppedConversationIds.has(conversationIdForAction(action))) {
    return state
  }

  switch (action.type) {
    case 'HYDRATE':
      return withStream(state, action.conversationId, (current) => {
        const events = mergeAgentEvents(current.events, action.events)
        const hydratedMessages = mergeHydratedMessages(
          current.messages,
          action.messages,
          action.activeTurn,
        )
        const terminalError = assistantErrorFromRuntimeState(action.runtimeState, events)
        const messages =
          terminalError && action.runtimeState?.turn
            ? finalizeAssistantMessageAsError(
                hydratedMessages,
                action.runtimeState.turn.assistantMessageId,
                terminalError,
                action.runtimeState.turn.selection,
              )
            : hydratedMessages
        return {
          ...current,
          messages,
          usage: action.usage,
          events,
          plans: action.plans ?? current.plans,
          runningMessageId:
            action.activeTurn?.assistantMessageId ??
            (hasTerminalMessage(messages, current.runningMessageId)
              ? null
              : current.runningMessageId),
          isHydrated: true,
        }
      })

    case 'SET_PLANS':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        plans: action.plans,
      }))

    case 'ENQUEUE':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        queue: [...current.queue, action.queued],
      }))

    case 'POP_QUEUE_HEAD':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        queue: current.queue.slice(1),
      }))

    case 'RUN_STARTED':
      return withStream(state, action.conversationId, (current) => {
        const messages = appendMissingMessage(
          insertMissingMessageBefore(
            current.messages,
            action.userMessage,
            action.assistantMessage.id,
          ),
          action.assistantMessage,
        )
        const assistant = messages.find((message) => message.id === action.assistantMessage.id)
        return {
          ...current,
          messages,
          queue: removeQueuedRun(current.queue, action.queuedId),
          runningMessageId:
            assistant?.status === 'streaming'
              ? action.assistantMessage.id
              : current.runningMessageId,
        }
      })

    case 'RETRY_STARTED':
      return withStream(state, action.conversationId, (current) => {
        const messages = appendMissingMessage(current.messages, action.assistantMessage)
        const assistant = messages.find((message) => message.id === action.assistantMessage.id)
        return {
          ...current,
          messages,
          queue: removeQueuedRun(current.queue, action.queuedId),
          runningMessageId:
            assistant?.status === 'streaming'
              ? action.assistantMessage.id
              : current.runningMessageId,
        }
      })

    case 'TEXT_DELTA':
      return withStream(state, action.conversationId, (current) => {
        if (hasTerminalMessage(current.messages, action.messageId)) return current
        return {
          ...current,
          messages: patchOrAppendAssistantMessage(current.messages, action.messageId, (m) => ({
            ...m,
            blocks: appendDelta(m.blocks, action.kind, action.delta),
          })),
          runningMessageId: current.runningMessageId ?? action.messageId,
        }
      })

    case 'TOOL_CALL_START':
      return withStream(state, action.conversationId, (current) => {
        if (hasTerminalMessage(current.messages, action.messageId)) return current
        return {
          ...current,
          messages: patchOrAppendAssistantMessage(current.messages, action.messageId, (m) => ({
            ...m,
            blocks: upsertToolCall(
              m.blocks,
              action.toolCallId,
              (b) => ({ ...b, name: action.name, arguments: action.args }),
              {
                type: 'tool_call',
                id: action.toolCallId,
                name: action.name,
                arguments: action.args,
                status: 'running',
              },
            ),
          })),
          runningMessageId: current.runningMessageId ?? action.messageId,
        }
      })

    case 'TOOL_CALL_ARGS_DELTA':
      if (!action.delta) return state
      return withStream(state, action.conversationId, (current) => {
        if (hasTerminalMessage(current.messages, action.messageId)) return current
        return {
          ...current,
          messages: patchOrAppendAssistantMessage(current.messages, action.messageId, (m) => ({
            ...m,
            blocks: upsertToolCall(
              m.blocks,
              action.toolCallId,
              (b) => ({ ...b, arguments: b.arguments + action.delta }),
              {
                type: 'tool_call',
                id: action.toolCallId,
                name: 'tool',
                arguments: action.delta,
                status: 'running',
              },
            ),
          })),
          runningMessageId: current.runningMessageId ?? action.messageId,
        }
      })

    case 'TOOL_CALL_RESULT':
      return withStream(state, action.conversationId, (current) => {
        if (hasTerminalMessage(current.messages, action.messageId)) return current
        return {
          ...current,
          messages: patchOrAppendAssistantMessage(current.messages, action.messageId, (m) => ({
            ...m,
            blocks: upsertToolCall(
              m.blocks,
              action.toolCallId,
              (b) => ({
                ...b,
                ...(action.name ? { name: action.name } : {}),
                status: action.isError ? 'error' : 'done',
                result: action.result,
              }),
              {
                type: 'tool_call',
                id: action.toolCallId,
                name: action.name ?? 'tool',
                arguments: '',
                status: action.isError ? 'error' : 'done',
                result: action.result,
              },
            ),
          })),
          runningMessageId: current.runningMessageId ?? action.messageId,
        }
      })

    case 'IMAGE_BLOCK':
      return withStream(state, action.conversationId, (current) => {
        if (hasTerminalMessage(current.messages, action.messageId)) return current
        return {
          ...current,
          messages: patchOrAppendAssistantMessage(current.messages, action.messageId, (m) => ({
            ...m,
            blocks: [...m.blocks, action.block],
          })),
          runningMessageId: current.runningMessageId ?? action.messageId,
        }
      })

    case 'FINISH':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        messages: replaceOrAppendMessage(current.messages, action.message),
        runningMessageId:
          current.runningMessageId === action.messageId ? null : current.runningMessageId,
        usage: action.usage ?? current.usage,
      }))

    case 'CLEAR_QUEUE':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        queue: [],
      }))

    case 'AGENT_EVENT':
      return withStream(state, action.event.conversationId, (current) => {
        const terminalError = assistantErrorFromAgentEvent(action.event)
        return {
          ...current,
          messages:
            action.event.type === 'turn.started'
              ? hasTerminalMessage(current.messages, action.event.messageId)
                ? current.messages
                : ensureAssistantMessage(
                    current.messages,
                    action.event.messageId,
                    selectionFromAgentEventData(action.event.data),
                  )
              : terminalError
                ? finalizeAssistantMessageAsError(
                    current.messages,
                    action.event.messageId,
                    terminalError,
                  )
                : current.messages,
          runningMessageId:
            action.event.type === 'turn.started'
              ? hasTerminalMessage(current.messages, action.event.messageId)
                ? current.runningMessageId
                : action.event.messageId
              : shouldClearRunningFromAgentEvent(action.event) &&
                  current.runningMessageId === action.event.messageId
                ? null
                : current.runningMessageId,
          events: mergeAgentEvents(current.events, [action.event]),
        }
      })

    case 'DROP': {
      const droppedConversationIds = new Set(state.droppedConversationIds)
      droppedConversationIds.add(action.conversationId)
      const next = new Map(state.streams)
      next.delete(action.conversationId)
      return { ...state, streams: next, droppedConversationIds }
    }
  }
}

function persistedToMessage(message: PersistedMessage): Message {
  return message as unknown as Message
}

export interface ChatStreamsApi {
  getStream: (id: string) => ConversationStream
  busyIds: Set<string>
  hydrate: (id: string) => Promise<void>
  markHydrated: (id: string) => void
  enqueueSend: (
    id: string,
    text: string,
    selection: ModelSelection,
    attachments?: ChatAttachmentInput[],
    options?: { mode?: AilaExecutionMode; planId?: string },
  ) => void
  enqueueRetryLast: (
    id: string,
    selection: ModelSelection,
    options?: { mode?: AilaExecutionMode; planId?: string },
  ) => void
  enqueueApprovePlan: (
    id: string,
    planId: string,
    selection: ModelSelection,
    expectedRevisionId?: string,
  ) => void
  refreshPlans: (id: string) => Promise<void>
  compact: (id: string, selection: ModelSelection) => Promise<RuntimeCompactConversationResult>
  abort: (id: string) => void
  drop: (id: string) => void
}

interface UseChatStreamsOptions {
  onConversationUpdated?: (summary: ConversationSummary) => void
}

export type ChatStreamsStateForTest = State
export type ChatStreamsActionForTest = Action

export function createChatStreamsStateForTest(): ChatStreamsStateForTest {
  return {
    streams: new Map<string, ConversationStream>(),
    droppedConversationIds: new Set<string>(),
  }
}

export function reduceChatStreamsForTest(
  state: ChatStreamsStateForTest,
  action: ChatStreamsActionForTest,
): ChatStreamsStateForTest {
  return reducer(state, action)
}

export function useChatStreams(options: UseChatStreamsOptions = {}): ChatStreamsApi {
  const [state, dispatch] = useReducer(reducer, {
    streams: new Map<string, ConversationStream>(),
    droppedConversationIds: new Set<string>(),
  })
  const stateRef = useRef(state)
  stateRef.current = state

  const onConversationUpdatedRef = useRef(options.onConversationUpdated)
  onConversationUpdatedRef.current = options.onConversationUpdated

  // Conversations with an in-flight startRun. The drain effect uses this to
  // skip a second concurrent kick during the async window between
  // POP_QUEUE_HEAD and RUN_STARTED, where runningMessageId is still null but
  // a run is already on its way.
  const startingRef = useRef<Set<string>>(new Set())

  const startRun = useCallback(async (id: string, queued: QueuedRun): Promise<void> => {
    let result: Awaited<ReturnType<typeof window.api.runtime.send>>
    try {
      result =
        queued.kind === 'send'
          ? await window.api.runtime.send({
              conversationId: id,
              userText: queued.text,
              selection: queued.selection,
              ...(queued.mode ? { mode: queued.mode } : {}),
              ...(queued.planId ? { planId: queued.planId } : {}),
              attachments: queued.attachments,
            })
          : queued.kind === 'retryLast'
            ? await window.api.runtime.retryLast({
                conversationId: id,
                selection: queued.selection,
                ...(queued.mode ? { mode: queued.mode } : {}),
                ...(queued.planId ? { planId: queued.planId } : {}),
              })
            : await window.api.runtime.approvePlan({
                conversationId: id,
                planId: queued.planId,
                selection: queued.selection,
                ...(queued.expectedRevisionId
                  ? { expectedRevisionId: queued.expectedRevisionId }
                  : {}),
              })
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      // Surface as a synthetic error message in the conversation so it isn't lost.
      const stub: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        blocks: [],
        status: 'error',
        error: errorText,
        model: queued.selection,
      }
      if (queued.kind === 'send') {
        dispatch({
          type: 'RUN_STARTED',
          conversationId: id,
          queuedId: queued.id,
          userMessage: {
            ...queuedSendToMessage(queued, crypto.randomUUID(), 'done'),
          },
          assistantMessage: stub,
        })
      } else if (queued.kind === 'retryLast') {
        dispatch({
          type: 'RETRY_STARTED',
          conversationId: id,
          queuedId: queued.id,
          assistantMessage: stub,
        })
      } else {
        dispatch({
          type: 'RETRY_STARTED',
          conversationId: id,
          queuedId: queued.id,
          assistantMessage: stub,
        })
      }
      dispatch({
        type: 'FINISH',
        conversationId: id,
        messageId: stub.id,
        message: stub,
      })
      return
    }
    const userMessage = persistedToMessage(result.userMessage)
    const assistantMessage: Message = {
      id: result.assistantMessageId,
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      model: queued.selection,
    }
    dispatch(
      queued.kind === 'send'
        ? {
            type: 'RUN_STARTED',
            conversationId: id,
            queuedId: queued.id,
            userMessage,
            assistantMessage,
          }
        : queued.kind === 'approvePlan'
          ? {
              type: 'RUN_STARTED',
              conversationId: id,
              queuedId: queued.id,
              userMessage,
              assistantMessage,
            }
          : {
              type: 'RETRY_STARTED',
              conversationId: id,
              queuedId: queued.id,
              assistantMessage,
            },
    )
  }, [])

  // Single source of truth for "run the next queued send". An earlier version
  // called a startNext() helper from chat:done via queueMicrotask, but the
  // microtask flushed before React committed the FINISH state — so the queue
  // runner saw a stale runningMessageId, bailed out, and stranded any send
  // the user typed mid-stream until the app restarted. A post-commit effect
  // sees the latest state by construction.
  useEffect(() => {
    for (const [id, stream] of state.streams) {
      if (
        stream.runningMessageId === null &&
        stream.queue.length > 0 &&
        !startingRef.current.has(id)
      ) {
        const head = stream.queue[0]
        startingRef.current.add(id)
        void startRun(id, head).finally(() => {
          startingRef.current.delete(id)
        })
      }
    }
  }, [state, startRun])

  const enqueueSend = useCallback(
    (
      id: string,
      text: string,
      selection: ModelSelection,
      attachments: ChatAttachmentInput[] = [],
      options: { mode?: AilaExecutionMode; planId?: string } = {},
    ): void => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return
      // Just enqueue — the drain effect above picks up the head once React
      // commits, regardless of whether the conversation is idle, mid-stream,
      // or has other prompts already queued ahead.
      dispatch({
        type: 'ENQUEUE',
        conversationId: id,
        queued: {
          id: crypto.randomUUID(),
          kind: 'send',
          text: trimmed,
          attachments,
          selection,
          ...(options.mode ? { mode: options.mode } : {}),
          ...(options.planId ? { planId: options.planId } : {}),
        },
      })
    },
    [],
  )

  const enqueueRetryLast = useCallback(
    (
      id: string,
      selection: ModelSelection,
      options: { mode?: AilaExecutionMode; planId?: string } = {},
    ): void => {
      dispatch({
        type: 'ENQUEUE',
        conversationId: id,
        queued: {
          id: crypto.randomUUID(),
          kind: 'retryLast',
          selection,
          ...(options.mode ? { mode: options.mode } : {}),
          ...(options.planId ? { planId: options.planId } : {}),
        },
      })
    },
    [],
  )

  const enqueueApprovePlan = useCallback(
    (id: string, planId: string, selection: ModelSelection, expectedRevisionId?: string): void => {
      dispatch({
        type: 'ENQUEUE',
        conversationId: id,
        queued: {
          id: crypto.randomUUID(),
          kind: 'approvePlan',
          planId,
          selection,
          ...(expectedRevisionId ? { expectedRevisionId } : {}),
        },
      })
    },
    [],
  )

  const refreshPlans = useCallback(async (id: string): Promise<void> => {
    const plans = await window.api.runtime.listPlans(id)
    dispatch({ type: 'SET_PLANS', conversationId: id, plans })
  }, [])

  const compact = useCallback(
    (id: string, selection: ModelSelection): Promise<RuntimeCompactConversationResult> =>
      window.api.runtime.compactConversation({ conversationId: id, selection }),
    [],
  )

  const hydrate = useCallback(async (id: string): Promise<void> => {
    if (stateRef.current.streams.get(id)?.isHydrated) return
    const { record, events, runtimeState, activeTurn, plans } =
      await window.api.runtime.hydrateConversation(id)
    if (stateRef.current.streams.get(id)?.isHydrated) return
    const messages = record.messages.map(persistedToMessage)
    const usage = record.meta.usage
      ? {
          promptTokens: record.meta.usage.promptTokens,
          completionTokens: record.meta.usage.completionTokens,
          totalTokens: record.meta.usage.totalTokens,
        }
      : null
    dispatch({
      type: 'HYDRATE',
      conversationId: id,
      messages,
      usage,
      events,
      plans,
      runtimeState,
      activeTurn,
    })
  }, [])

  // Mark a freshly-created conversation as hydrated without a disk read. Used
  // when the renderer just created the conversation so we know it's empty —
  // skips the runtime hydrate round-trip and prevents a race
  // with an immediate enqueueSend.
  const markHydrated = useCallback((id: string): void => {
    if (stateRef.current.streams.get(id)?.isHydrated) return
    dispatch({
      type: 'HYDRATE',
      conversationId: id,
      messages: [],
      usage: null,
      events: [],
      plans: [],
    })
  }, [])

  const abort = useCallback((id: string): void => {
    dispatch({ type: 'CLEAR_QUEUE', conversationId: id })
    void window.api.runtime.abort(id)
  }, [])

  const drop = useCallback((id: string): void => {
    dispatch({ type: 'DROP', conversationId: id })
  }, [])

  // IPC subscriptions — registered once. Routing happens via conversationId on
  // every payload.
  useEffect(() => {
    const cleanups = [
      window.api.runtime.onTextDelta((event: TextDeltaEvent) =>
        dispatch({
          type: 'TEXT_DELTA',
          conversationId: event.conversationId,
          messageId: event.messageId,
          kind: 'text',
          delta: event.delta,
        }),
      ),
      window.api.runtime.onReasoningDelta((event: ReasoningDeltaEvent) =>
        dispatch({
          type: 'TEXT_DELTA',
          conversationId: event.conversationId,
          messageId: event.messageId,
          kind: 'reasoning',
          delta: event.delta,
        }),
      ),
      window.api.runtime.onToolCallStart((event: ToolCallStartEvent) =>
        dispatch({
          type: 'TOOL_CALL_START',
          conversationId: event.conversationId,
          messageId: event.messageId,
          toolCallId: event.toolCallId,
          name: event.name,
          args: event.arguments,
        }),
      ),
      window.api.runtime.onToolCallArgsDelta((event: ToolCallArgsDeltaEvent) =>
        dispatch({
          type: 'TOOL_CALL_ARGS_DELTA',
          conversationId: event.conversationId,
          messageId: event.messageId,
          toolCallId: event.toolCallId,
          delta: event.delta,
        }),
      ),
      window.api.runtime.onToolCallResult((event: ToolCallResultEvent) =>
        dispatch({
          type: 'TOOL_CALL_RESULT',
          conversationId: event.conversationId,
          messageId: event.messageId,
          toolCallId: event.toolCallId,
          name: event.name,
          result: event.result,
          isError: event.isError,
        }),
      ),
      window.api.runtime.onImageBlock((event: ImageBlockEvent) =>
        dispatch({
          type: 'IMAGE_BLOCK',
          conversationId: event.conversationId,
          messageId: event.messageId,
          block: {
            type: 'image',
            url: event.block.url,
            mime: event.block.mime,
            prompt: event.block.prompt,
          },
        }),
      ),
      window.api.runtime.onDone((event: ChatDoneEvent) => {
        dispatch({
          type: 'FINISH',
          conversationId: event.conversationId,
          messageId: event.messageId,
          message: persistedToMessage(event.message),
          usage: event.usage,
        })
        // Drain effect picks up the next queued send after FINISH commits.
      }),
      window.api.runtime.onError((event: ChatErrorEvent) => {
        dispatch({
          type: 'FINISH',
          conversationId: event.conversationId,
          messageId: event.messageId,
          message: persistedToMessage(event.message),
        })
      }),
      window.api.runtime.onAgentEvent((event) => {
        dispatch({ type: 'AGENT_EVENT', event })
        if (event.type.startsWith('plan.')) void refreshPlans(event.conversationId)
      }),
      window.api.runtime.conversations.onUpdated((summary) => {
        onConversationUpdatedRef.current?.(summary)
      }),
    ]
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [refreshPlans])

  const busyIds = useMemo(() => {
    const set = new Set<string>()
    for (const [id, stream] of state.streams) {
      if (stream.runningMessageId !== null || stream.queue.length > 0) set.add(id)
    }
    return set
  }, [state])

  const getStreamFn = useCallback(
    (id: string): ConversationStream => materializeStream(state.streams.get(id) ?? EMPTY_STREAM),
    [state],
  )

  return {
    getStream: getStreamFn,
    busyIds,
    hydrate,
    markHydrated,
    enqueueSend,
    enqueueRetryLast,
    enqueueApprovePlan,
    refreshPlans,
    compact,
    abort,
    drop,
  }
}
