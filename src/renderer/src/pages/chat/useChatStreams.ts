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
  ChatDoneEvent,
  ChatErrorEvent,
  ConversationSummary,
  ImageBlockEvent,
  ModelSelection,
  PersistedMessage,
  ReasoningDeltaEvent,
  TextDeltaEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  UsageInfo,
} from '../../types'
import type { Block, ImageBlock, Message, TextBlock, ToolCallBlock } from './types'

interface QueuedPrompt {
  text: string
  selection: ModelSelection
}

export interface ConversationStream {
  messages: Message[]
  isHydrated: boolean
  queue: QueuedPrompt[]
  runningMessageId: string | null
  usage: UsageInfo | null
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
}

type Action =
  | {
      type: 'HYDRATE'
      conversationId: string
      messages: Message[]
      usage: UsageInfo | null
    }
  | { type: 'ENQUEUE'; conversationId: string; queued: QueuedPrompt }
  | { type: 'POP_QUEUE_HEAD'; conversationId: string }
  | {
      type: 'RUN_STARTED'
      conversationId: string
      userMessage: Message
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
      type: 'TOOL_CALL_RESULT'
      conversationId: string
      messageId: string
      toolCallId: string
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

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'HYDRATE':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        messages: action.messages,
        usage: action.usage,
        isHydrated: true,
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
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        messages: [...current.messages, action.userMessage, action.assistantMessage],
        runningMessageId: action.assistantMessage.id,
      }))

    case 'TEXT_DELTA':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        messages: patchMessage(current.messages, action.messageId, (m) => ({
          ...m,
          blocks: appendDelta(m.blocks, action.kind, action.delta),
        })),
      }))

    case 'TOOL_CALL_START':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        messages: patchMessage(current.messages, action.messageId, (m) => ({
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
      }))

    case 'TOOL_CALL_RESULT':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        messages: patchMessage(current.messages, action.messageId, (m) => ({
          ...m,
          blocks: m.blocks.map((b) =>
            b.type === 'tool_call' && b.id === action.toolCallId
              ? { ...b, status: action.isError ? 'error' : 'done', result: action.result }
              : b,
          ),
        })),
      }))

    case 'IMAGE_BLOCK':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        messages: patchMessage(current.messages, action.messageId, (m) => ({
          ...m,
          blocks: [...m.blocks, action.block],
        })),
      }))

    case 'FINISH':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        messages: patchMessage(current.messages, action.messageId, () => action.message),
        runningMessageId:
          current.runningMessageId === action.messageId ? null : current.runningMessageId,
        usage: action.usage ?? current.usage,
      }))

    case 'CLEAR_QUEUE':
      return withStream(state, action.conversationId, (current) => ({
        ...current,
        queue: [],
      }))

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
  enqueueSend: (id: string, text: string, selection: ModelSelection) => void
  abort: (id: string) => void
  drop: (id: string) => void
}

interface UseChatStreamsOptions {
  onConversationUpdated?: (summary: ConversationSummary) => void
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

  const startRun = useCallback(async (id: string, queued: QueuedPrompt): Promise<void> => {
    dispatch({ type: 'POP_QUEUE_HEAD', conversationId: id })
    let result: Awaited<ReturnType<typeof window.api.send>>
    try {
      result = await window.api.send(id, queued.text, queued.selection)
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
    dispatch({
      type: 'RUN_STARTED',
      conversationId: id,
      userMessage,
      assistantMessage,
    })
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

  const enqueueSend = useCallback((id: string, text: string, selection: ModelSelection): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    // Just enqueue — the drain effect above picks up the head once React
    // commits, regardless of whether the conversation is idle, mid-stream,
    // or has other prompts already queued ahead.
    dispatch({
      type: 'ENQUEUE',
      conversationId: id,
      queued: { text: trimmed, selection },
    })
  }, [])

  const hydrate = useCallback(async (id: string): Promise<void> => {
    if (stateRef.current.streams.get(id)?.isHydrated) return
    const record = await window.api.conversations.get(id)
    if (stateRef.current.streams.get(id)?.isHydrated) return
    const messages = record.messages.map(persistedToMessage)
    const usage = record.meta.usage
      ? {
          promptTokens: record.meta.usage.promptTokens,
          completionTokens: record.meta.usage.completionTokens,
          totalTokens: record.meta.usage.totalTokens,
        }
      : null
    dispatch({ type: 'HYDRATE', conversationId: id, messages, usage })
  }, [])

  // Mark a freshly-created conversation as hydrated without a disk read. Used
  // when the renderer just created the conversation so we know it's empty —
  // skips the await window.api.conversations.get round-trip and prevents a race
  // with an immediate enqueueSend.
  const markHydrated = useCallback((id: string): void => {
    if (stateRef.current.streams.get(id)?.isHydrated) return
    dispatch({ type: 'HYDRATE', conversationId: id, messages: [], usage: null })
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
      window.api.onToolCallResult((event: ToolCallResultEvent) =>
        dispatch({
          type: 'TOOL_CALL_RESULT',
          conversationId: event.conversationId,
          messageId: event.messageId,
          toolCallId: event.toolCallId,
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
    abort,
    drop,
  }
}
