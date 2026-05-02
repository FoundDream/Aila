import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatMessage,
  ConversationRecord,
  ConversationSummary,
  ModelInfo,
  UsageInfo,
} from '../../../../preload/index'
import { Composer } from './Composer'
import { Transcript } from './Transcript'
import type { Block, Message, TextBlock, ToolCallBlock } from './types'

interface ChatPageProps {
  conversation: ConversationRecord | null
  onCreateConversation: () => Promise<ConversationSummary>
  onAppendMessage: (id: string, message: Message) => Promise<void>
}

function createId(): string {
  return crypto.randomUUID()
}

function appendDeltaToBlocks(blocks: Block[], type: 'text' | 'reasoning', delta: string): Block[] {
  if (!delta) return blocks
  const last = blocks[blocks.length - 1]
  if (last && last.type === type) {
    return [
      ...blocks.slice(0, -1),
      { type, content: (last as { content: string }).content + delta },
    ]
  }
  return [...blocks, { type, content: delta }]
}

// Reconstructs OpenRouter wire-format messages from rendered blocks. Reasoning is
// dropped (provider doesn't accept it as input). Each tool_call block produces both
// a `tool_calls` entry on the parent assistant message and a following role:'tool'
// message carrying its result.
function blocksToApiMessages(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const content = message.blocks
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.content)
        .join('')
      if (content) out.push({ role: 'user', content })
      continue
    }

    const text = message.blocks
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.content)
      .join('')
    const toolCalls = message.blocks.filter((b): b is ToolCallBlock => b.type === 'tool_call')

    if (text || toolCalls.length > 0) {
      const assistant: ChatMessage = {
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 && {
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments || '{}' },
          })),
        }),
      }
      out.push(assistant)
    }

    for (const tc of toolCalls) {
      out.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: tc.result ?? '',
      })
    }
  }
  return out
}

export function ChatPage({
  conversation,
  onCreateConversation,
  onAppendMessage,
}: ChatPageProps): ReactElement {
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [currentUsage, setCurrentUsage] = useState<UsageInfo | null>(null)
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null)

  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages

  useEffect(() => {
    let cancelled = false
    void window.api.getModelInfo().then((info) => {
      if (!cancelled) setModelInfo(info)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const streamingIdRef = useRef<string | null>(null)
  const streamConversationIdRef = useRef<string | null>(null)
  const pendingTextRef = useRef('')
  const pendingReasoningRef = useRef('')
  const rafRef = useRef<number | null>(null)
  const persistedIdsRef = useRef<Set<string>>(new Set())
  const hydratedIdRef = useRef<string | null>(null)

  // Hydrate messages when the active conversation changes (or clears).
  // Track lastHydratedIdRef so:
  //   - we don't re-hydrate (and clobber in-flight state) on every parent re-render
  //   - handleSubmit can pre-set this to a freshly-created id to dodge a hydrate race
  useEffect(() => {
    if (!conversation) {
      if (hydratedIdRef.current === null) return
      hydratedIdRef.current = null
      void window.api.abort()
      streamingIdRef.current = null
      streamConversationIdRef.current = null
      pendingTextRef.current = ''
      pendingReasoningRef.current = ''
      persistedIdsRef.current = new Set()
      setMessages([])
      setCurrentUsage(null)
      setIsStreaming(false)
      return
    }
    if (hydratedIdRef.current === conversation.meta.id) return
    hydratedIdRef.current = conversation.meta.id
    void window.api.abort()
    streamingIdRef.current = null
    streamConversationIdRef.current = null
    pendingTextRef.current = ''
    pendingReasoningRef.current = ''
    const loaded = conversation.messages as Message[]
    persistedIdsRef.current = new Set(loaded.map((m) => m.id))
    setMessages(loaded)
    setCurrentUsage(
      conversation.meta.usage
        ? {
            promptTokens: conversation.meta.usage.promptTokens,
            completionTokens: conversation.meta.usage.completionTokens,
            totalTokens: conversation.meta.usage.totalTokens,
          }
        : null,
    )
    setIsStreaming(false)
  }, [conversation])

  const flushPending = useCallback(() => {
    rafRef.current = null
    const text = pendingTextRef.current
    const reasoning = pendingReasoningRef.current
    pendingTextRef.current = ''
    pendingReasoningRef.current = ''
    const targetId = streamingIdRef.current
    if (!targetId || (!text && !reasoning)) return

    setMessages((prev) =>
      prev.map((message) => {
        if (message.id !== targetId) return message
        let nextBlocks = message.blocks
        if (reasoning) nextBlocks = appendDeltaToBlocks(nextBlocks, 'reasoning', reasoning)
        if (text) nextBlocks = appendDeltaToBlocks(nextBlocks, 'text', text)
        return { ...message, blocks: nextBlocks }
      }),
    )
  }, [])

  const scheduleFlush = useCallback(() => {
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flushPending)
    }
  }, [flushPending])

  const finishStreaming = useCallback(
    (status: 'done' | 'error', errorMessage?: string, usage?: UsageInfo) => {
      flushPending()
      const targetId = streamingIdRef.current
      const conversationId = streamConversationIdRef.current
      streamingIdRef.current = null
      streamConversationIdRef.current = null
      setIsStreaming(false)

      if (usage && conversationId) {
        setCurrentUsage(usage)
        queueMicrotask(() => {
          void window.api.conversations.setUsage(conversationId, usage)
        })
      }

      if (!targetId) return

      setMessages((prev) => {
        const next = prev.map((message) =>
          message.id === targetId ? { ...message, status, error: errorMessage } : message,
        )
        if (conversationId && !persistedIdsRef.current.has(targetId)) {
          const finalMessage = next.find((m) => m.id === targetId)
          if (finalMessage) {
            persistedIdsRef.current.add(targetId)
            queueMicrotask(() => {
              void onAppendMessage(conversationId, finalMessage)
            })
          }
        }
        return next
      })
    },
    [flushPending, onAppendMessage],
  )

  const upsertToolCall = useCallback(
    (id: string, updater: (block: ToolCallBlock) => ToolCallBlock, fallback?: ToolCallBlock) => {
      const targetId = streamingIdRef.current
      if (!targetId) return
      flushPending()
      setMessages((prev) =>
        prev.map((message) => {
          if (message.id !== targetId) return message
          const idx = message.blocks.findIndex(
            (block) => block.type === 'tool_call' && block.id === id,
          )
          if (idx === -1) {
            if (!fallback) return message
            return { ...message, blocks: [...message.blocks, fallback] }
          }
          const next = [...message.blocks]
          next[idx] = updater(next[idx] as ToolCallBlock)
          return { ...message, blocks: next }
        }),
      )
    },
    [flushPending],
  )

  useEffect(() => {
    const cleanups = [
      window.api.onTextDelta((delta) => {
        if (!streamingIdRef.current) return
        pendingTextRef.current += delta
        scheduleFlush()
      }),
      window.api.onReasoningDelta((delta) => {
        if (!streamingIdRef.current) return
        pendingReasoningRef.current += delta
        scheduleFlush()
      }),
      window.api.onToolCallStart((event) => {
        upsertToolCall(
          event.id,
          (block) => ({ ...block, name: event.name, arguments: event.arguments }),
          {
            type: 'tool_call',
            id: event.id,
            name: event.name,
            arguments: event.arguments,
            status: 'running',
          },
        )
      }),
      window.api.onToolCallResult((event) => {
        upsertToolCall(event.id, (block) => ({
          ...block,
          status: event.isError ? 'error' : 'done',
          result: event.result,
        }))
      }),
      window.api.onDone((full) => finishStreaming('done', undefined, full.usage)),
      window.api.onError((message) => finishStreaming('error', message)),
    ]
    return () => {
      for (const cleanup of cleanups) cleanup()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [scheduleFlush, finishStreaming, upsertToolCall])

  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return

      let conversationId = conversation?.meta.id ?? null
      if (!conversationId) {
        const summary = await onCreateConversation()
        conversationId = summary.id
        // Pre-claim the hydrate slot so the activeRecord-fetch effect doesn't
        // wipe the user/assistant messages we're about to add locally.
        hydratedIdRef.current = summary.id
        persistedIdsRef.current = new Set()
      }

      const userMessage: Message = {
        id: createId(),
        role: 'user',
        blocks: [{ type: 'text', content: trimmed }],
        status: 'done',
      }
      const assistantMessage: Message = {
        id: createId(),
        role: 'assistant',
        blocks: [],
        status: 'streaming',
      }

      streamingIdRef.current = assistantMessage.id
      streamConversationIdRef.current = conversationId
      pendingTextRef.current = ''
      pendingReasoningRef.current = ''
      persistedIdsRef.current.add(userMessage.id)

      const nextMessages = [...messagesRef.current, userMessage, assistantMessage]
      setMessages(nextMessages)
      setIsStreaming(true)

      // Crash-safety: persist the user message before the network call.
      void onAppendMessage(conversationId, userMessage)

      // Drop the empty assistant placeholder — server doesn't need it.
      const apiPayload = blocksToApiMessages(nextMessages.slice(0, -1))

      try {
        await window.api.send(apiPayload)
      } catch (error) {
        finishStreaming('error', error instanceof Error ? error.message : String(error))
      }
    },
    [conversation, onCreateConversation, onAppendMessage, finishStreaming],
  )

  const handleAbort = useCallback(() => {
    void window.api.abort()
  }, [])

  return (
    <div className="flex h-full flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="flex h-10 shrink-0 items-center justify-center [-webkit-app-region:drag]">
        <span
          className="text-[13px] italic tracking-wide text-[var(--text-dim)]"
          style={{ fontFamily: 'var(--font-serif)' }}
        >
          Aila
        </span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <Transcript messages={messages} />
        <Composer
          isStreaming={isStreaming}
          onSubmit={handleSubmit}
          onAbort={handleAbort}
          usage={currentUsage}
          contextLength={modelInfo?.contextLength ?? null}
        />
      </main>
    </div>
  )
}
