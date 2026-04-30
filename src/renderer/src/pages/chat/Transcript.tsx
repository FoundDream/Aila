import { type ReactElement, useEffect, useRef } from 'react'
import type { Message } from './types'

export function Transcript({ messages }: { messages: Message[] }): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = scrollRef.current
    if (!node || messages.length === 0) return
    node.scrollTop = node.scrollHeight
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--term-dim)]">
        Type something to start.
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
      </div>
    </div>
  )
}

function MessageRow({ message }: { message: Message }): ReactElement {
  const isUser = message.role === 'user'
  return (
    <div className={`flex flex-col gap-2 ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`text-[10px] uppercase tracking-wider ${
          isUser ? 'text-[var(--term-blue-strong)]' : 'text-[var(--term-dim)]'
        }`}
      >
        {isUser ? 'you' : 'assistant'}
      </div>
      <div
        className={`max-w-full whitespace-pre-wrap rounded-md px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? 'bg-[var(--term-accent-soft)] text-[var(--term-text)]'
            : 'bg-[var(--term-surface)] border border-[var(--term-border)] text-[var(--term-text)]'
        }`}
      >
        {message.blocks.length === 0 && message.status === 'streaming' ? (
          <span className="text-[var(--term-dim)]">…</span>
        ) : (
          message.blocks.map((block, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are append-only per message
              key={index}
              className={
                block.type === 'reasoning'
                  ? 'mb-1 rounded border-l-2 border-[var(--term-border-strong)] bg-[var(--term-surface-soft)] px-2 py-1 text-xs italic text-[var(--term-text-soft)]'
                  : ''
              }
            >
              {block.type === 'reasoning' && (
                <div className="mb-0.5 text-[10px] uppercase tracking-wider not-italic text-[var(--term-dim)]">
                  thinking
                </div>
              )}
              {block.content}
            </div>
          ))
        )}
        {message.status === 'error' && message.error && (
          <div className="mt-2 text-xs text-[var(--term-red)]">Error: {message.error}</div>
        )}
      </div>
    </div>
  )
}
