/// <reference path="../../env.d.ts" />

/**
 * Per-conversation streaming buffers. Lifts what used to live in ChatPage refs
 * out into an app-level hook so multiple conversations can stream in parallel:
 * switching the active sidebar entry is purely a view change.
 *
 * Concurrency: at most one in-flight chat:send per conversation. Additional
 * sends pile into a per-conversation queue and fire after the previous done.
 *
 * IPC events from main are tagged with conversationId/messageId; the reducer
 * routes by conversationId so events for inactive conversations land in their
 * own buffer instead of clobbering the active view.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type {
  ActiveAssistantTurn,
  AgentProfileId,
  ChatDoneEvent,
  ChatErrorEvent,
  ConversationSummary,
  ImageBlockEvent,
  ModelSelection,
  PersistedAgentEvent,
  PersistedMessage,
  ReasoningDeltaEvent,
  TextDeltaEvent,
  ToolCallArgsDeltaEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  UsageInfo,
} from '../../types'
import type { Block, ImageBlock, Message, TextBlock, ToolCallBlock } from './types'

type QueuedRun =
  | {
      kind: 'send'
      text: string
      selection: ModelSelection
      profileId?: AgentProfileId
    }
  | {
      kind: 'retryLast'
      selection: ModelSelection
      profileId?: AgentProfileId
    }

export interface ConversationStream {
  messages: Message[]
  isHydrated: boolean
  queue: QueuedRun[]
  runningMessageId: string | null
  usage: UsageInfo | null
  events: PersistedAgentEvent[]
}

interface State {
  streams: Map<string, ConversationStream>
}

const EMPTY_STREAM: ConversationStream = {
  messages: [],
  isHydrated: false,
  queue: [],
  runningMessageId: null,
  usage: null,
  events: [],
}

type Action =
  | {
      type: 'HYDRATE'
      conversationId: string
      messages: Message[]
      usage: UsageInfo | null
      events: PersistedAgentEvent[]
      activeTurn?: ActiveAssistantTurn | null
    }
  | { type: 'ENQUEUE'; conversationId: string; queued: QueuedRun }
  | { type: 'POP_QUEUE_HEAD'; conversationId: string }
  | {
      type: 'RUN_STARTED'
      conversationId: string
      userMessage: Message
      assistantMessage: Message
    }
  | {
      type: 'RETRY_STARTED'
      conversationId: string
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
  | { type: 'AGENT_EVENT'; event: PersistedAgentEvent }
  | { type: 'DROP'; conversationId: string }

function getStream(state: State, id: string): ConversationStream {
  return state.streams.get(id) ?? EMPTY_STREAM
}

function withStream(
  state: State,
  id: string,
  updater: (current: ConversationStream) => ConversationStream,
): State {
  const next = new Map(state.streams)
  next.set(id, updater(getStream(state, id)))
  return { streams: next }
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
  switch (action.type) {
    case 'HYDRATE':
      return withStream(state, action.conversationId, (current) => {
        const messages = mergeHydratedMessages(current.messages, action.messages, action.activeTurn)
        return {
          ...current,
          messages,
          usage: action.usage,
          events: mergeAgentEvents(current.events, action.events),
          runningMessageId:
            action.activeTurn?.assistantMessageId ??
            (hasTerminalMessage(messages, current.runningMessageId)
              ? null
              : current.runningMessageId),
          isHydrated: true,
        }
      })

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
          runningMessageId:
            assistant?.status === 'streaming'
              ? action.assistantMessage.id
              : current.runningMessageId,
        }
      })

    case 'TEXT_DELTA':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        messages: patchOrAppendAssistantMessage(current.messages, action.messageId, (m) => ({
          ...m,
          blocks: appendDelta(m.blocks, action.kind, action.delta),
        })),
        runningMessageId: current.runningMessageId ?? action.messageId,
      }))

    case 'TOOL_CALL_START':
      return withStream(state, action.conversationId, (current) => ({
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
      }))

    case 'TOOL_CALL_ARGS_DELTA':
      if (!action.delta) return state
      return withStream(state, action.conversationId, (current) => ({
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
      }))

    case 'TOOL_CALL_RESULT':
      return withStream(state, action.conversationId, (current) => ({
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
      }))

    case 'IMAGE_BLOCK':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        messages: patchOrAppendAssistantMessage(current.messages, action.messageId, (m) => ({
          ...m,
          blocks: [...m.blocks, action.block],
        })),
        runningMessageId: current.runningMessageId ?? action.messageId,
      }))

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
              ? ensureAssistantMessage(
                  current.messages,
                  action.event.messageId,
                  selectionFromAgentEventData(action.event.data),
                )
              : terminalError
                ? patchOrAppendAssistantMessage(
                    current.messages,
                    action.event.messageId,
                    (message) => ({
                      ...message,
                      status: 'error',
                      error: terminalError,
                    }),
                  )
                : current.messages,
          runningMessageId:
            action.event.type === 'turn.started'
              ? action.event.messageId
              : shouldClearRunningFromAgentEvent(action.event) &&
                  current.runningMessageId === action.event.messageId
                ? null
                : current.runningMessageId,
          events: mergeAgentEvents(current.events, [action.event]),
        }
      })

    case 'DROP': {
      if (!state.streams.has(action.conversationId)) return state
      const next = new Map(state.streams)
      next.delete(action.conversationId)
      return { streams: next }
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
    profileId?: AgentProfileId,
  ) => void
  enqueueRetryLast: (id: string, selection: ModelSelection, profileId?: AgentProfileId) => void
  abort: (id: string) => void
  drop: (id: string) => void
}

interface UseChatStreamsOptions {
  onConversationUpdated?: (summary: ConversationSummary) => void
}

export type ChatStreamsStateForTest = State
export type ChatStreamsActionForTest = Action

export function createChatStreamsStateForTest(): ChatStreamsStateForTest {
  return { streams: new Map() }
}

export function reduceChatStreamsForTest(
  state: ChatStreamsStateForTest,
  action: ChatStreamsActionForTest,
): ChatStreamsStateForTest {
  return reducer(state, action)
}

export function useChatStreams(options: UseChatStreamsOptions = {}): ChatStreamsApi {
  const [state, dispatch] = useReducer(reducer, { streams: new Map() })
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
    dispatch({ type: 'POP_QUEUE_HEAD', conversationId: id })
    let result: Awaited<ReturnType<typeof window.api.send>>
    try {
      result =
        queued.kind === 'send'
          ? await window.api.send(id, queued.text, queued.selection, queued.profileId)
          : await window.api.retryLast(id, queued.selection, queued.profileId)
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
          userMessage: {
            id: crypto.randomUUID(),
            role: 'user',
            blocks: [{ type: 'text', content: queued.text }],
            status: 'done',
          },
          assistantMessage: stub,
        })
      } else {
        dispatch({
          type: 'RETRY_STARTED',
          conversationId: id,
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
            userMessage,
            assistantMessage,
          }
        : {
            type: 'RETRY_STARTED',
            conversationId: id,
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
    (id: string, text: string, selection: ModelSelection, profileId?: AgentProfileId): void => {
      const trimmed = text.trim()
      if (!trimmed) return
      // Just enqueue — the drain effect above picks up the head once React
      // commits, regardless of whether the conversation is idle, mid-stream,
      // or has other prompts already queued ahead.
      dispatch({
        type: 'ENQUEUE',
        conversationId: id,
        queued: { kind: 'send', text: trimmed, selection, profileId },
      })
    },
    [],
  )

  const enqueueRetryLast = useCallback(
    (id: string, selection: ModelSelection, profileId?: AgentProfileId): void => {
      dispatch({
        type: 'ENQUEUE',
        conversationId: id,
        queued: { kind: 'retryLast', selection, profileId },
      })
    },
    [],
  )

  const hydrate = useCallback(async (id: string): Promise<void> => {
    if (stateRef.current.streams.get(id)?.isHydrated) return
    const [record, events, activeTurns] = await Promise.all([
      window.api.conversations.get(id),
      window.api.conversations.listEvents(id),
      window.api.listActiveStreams(),
    ])
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
      activeTurn: activeTurns.find((turn) => turn.conversationId === id) ?? null,
    })
  }, [])

  // Mark a freshly-created conversation as hydrated without a disk read. Used
  // when the renderer just created the conversation so we know it's empty —
  // skips the await window.api.conversations.get round-trip and prevents a race
  // with an immediate enqueueSend.
  const markHydrated = useCallback((id: string): void => {
    if (stateRef.current.streams.get(id)?.isHydrated) return
    dispatch({ type: 'HYDRATE', conversationId: id, messages: [], usage: null, events: [] })
  }, [])

  const abort = useCallback((id: string): void => {
    dispatch({ type: 'CLEAR_QUEUE', conversationId: id })
    void window.api.abort(id)
  }, [])

  const drop = useCallback((id: string): void => {
    dispatch({ type: 'DROP', conversationId: id })
  }, [])

  // IPC subscriptions — registered once. Routing happens via conversationId on
  // every payload.
  useEffect(() => {
    const cleanups = [
      window.api.onTextDelta((event: TextDeltaEvent) =>
        dispatch({
          type: 'TEXT_DELTA',
          conversationId: event.conversationId,
          messageId: event.messageId,
          kind: 'text',
          delta: event.delta,
        }),
      ),
      window.api.onReasoningDelta((event: ReasoningDeltaEvent) =>
        dispatch({
          type: 'TEXT_DELTA',
          conversationId: event.conversationId,
          messageId: event.messageId,
          kind: 'reasoning',
          delta: event.delta,
        }),
      ),
      window.api.onToolCallStart((event: ToolCallStartEvent) =>
        dispatch({
          type: 'TOOL_CALL_START',
          conversationId: event.conversationId,
          messageId: event.messageId,
          toolCallId: event.toolCallId,
          name: event.name,
          args: event.arguments,
        }),
      ),
      window.api.onToolCallArgsDelta((event: ToolCallArgsDeltaEvent) =>
        dispatch({
          type: 'TOOL_CALL_ARGS_DELTA',
          conversationId: event.conversationId,
          messageId: event.messageId,
          toolCallId: event.toolCallId,
          delta: event.delta,
        }),
      ),
      window.api.onToolCallResult((event: ToolCallResultEvent) =>
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
      window.api.onImageBlock((event: ImageBlockEvent) =>
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
      window.api.onDone((event: ChatDoneEvent) => {
        dispatch({
          type: 'FINISH',
          conversationId: event.conversationId,
          messageId: event.messageId,
          message: persistedToMessage(event.message),
          usage: event.usage,
        })
        // Drain effect picks up the next queued send after FINISH commits.
      }),
      window.api.onError((event: ChatErrorEvent) => {
        dispatch({
          type: 'FINISH',
          conversationId: event.conversationId,
          messageId: event.messageId,
          message: persistedToMessage(event.message),
        })
      }),
      window.api.onAgentEvent((event) => {
        dispatch({ type: 'AGENT_EVENT', event })
      }),
      window.api.conversations.onUpdated((summary) => {
        onConversationUpdatedRef.current?.(summary)
      }),
    ]
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [])

  const busyIds = useMemo(() => {
    const set = new Set<string>()
    for (const [id, stream] of state.streams) {
      if (stream.runningMessageId !== null || stream.queue.length > 0) set.add(id)
    }
    return set
  }, [state])

  const getStreamFn = useCallback(
    (id: string): ConversationStream => state.streams.get(id) ?? EMPTY_STREAM,
    [state],
  )

  return {
    getStream: getStreamFn,
    busyIds,
    hydrate,
    markHydrated,
    enqueueSend,
    enqueueRetryLast,
    abort,
    drop,
  }
}
