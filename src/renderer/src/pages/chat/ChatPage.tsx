import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { Composer } from './Composer'
import { Transcript } from './Transcript'
import type { Block, Message } from './types'

function createId(): string {
  return crypto.randomUUID()
}

function appendDeltaToBlocks(blocks: Block[], type: Block['type'], delta: string): Block[] {
  if (!delta) return blocks
  const last = blocks[blocks.length - 1]
  if (last && last.type === type) {
    return [...blocks.slice(0, -1), { type, content: last.content + delta }]
  }
  return [...blocks, { type, content: delta }]
}

function blocksToApiContent(blocks: Block[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.content)
    .join('')
}

export function ChatPage(): ReactElement {
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)

  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages

  const streamingIdRef = useRef<string | null>(null)
  const pendingTextRef = useRef('')
  const pendingReasoningRef = useRef('')
  const rafRef = useRef<number | null>(null)

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
    (status: 'done' | 'error', errorMessage?: string) => {
      flushPending()
      const targetId = streamingIdRef.current
      streamingIdRef.current = null
      setIsStreaming(false)
      if (!targetId) return
      setMessages((prev) =>
        prev.map((message) =>
          message.id === targetId ? { ...message, status, error: errorMessage } : message,
        ),
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
      window.api.onDone(() => finishStreaming('done')),
      window.api.onError((message) => finishStreaming('error', message)),
    ]
    return () => {
      for (const cleanup of cleanups) cleanup()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [scheduleFlush, finishStreaming])

  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return

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
      pendingTextRef.current = ''
      pendingReasoningRef.current = ''

      const nextMessages = [...messagesRef.current, userMessage, assistantMessage]
      setMessages(nextMessages)
      setIsStreaming(true)

      const apiPayload = nextMessages
        .filter((message) => message.role !== 'assistant' || message.blocks.length > 0)
        .map((message) => ({
          role: message.role,
          content:
            message.role === 'assistant'
              ? blocksToApiContent(message.blocks)
              : message.blocks[0].content,
        }))
        .filter((message) => message.content.length > 0 || message.role === 'user')

      // Drop the empty assistant placeholder — server doesn't need it.
      const payloadForServer = apiPayload.filter(
        (_, index) => index < apiPayload.length - 1 || apiPayload[index].role !== 'assistant',
      )

      try {
        await window.api.send(payloadForServer)
      } catch (error) {
        finishStreaming('error', error instanceof Error ? error.message : String(error))
      }
    },
    [finishStreaming],
  )

  const handleAbort = useCallback(() => {
    void window.api.abort()
  }, [])

  return (
    <div className="flex h-full flex-col bg-[var(--term-bg)] text-[var(--term-text)]">
      <header className="h-8 shrink-0 [-webkit-app-region:drag] border-b border-[var(--term-border)]" />
      <main className="flex min-h-0 flex-1 flex-col">
        <Transcript messages={messages} />
        <Composer isStreaming={isStreaming} onSubmit={handleSubmit} onAbort={handleAbort} />
      </main>
    </div>
  )
}
