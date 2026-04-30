import { type ReactElement, useEffect, useRef } from 'react'
import type { Block, Message } from './types'

const SERIF_STYLE: React.CSSProperties = { fontFamily: 'var(--font-serif)' }

export function Transcript({ messages }: { messages: Message[] }): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = scrollRef.current
    if (!node || messages.length === 0) return
    node.scrollTop = node.scrollHeight
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-lg italic text-[var(--text-dim)]" style={SERIF_STYLE}>
          A blank page.
        </p>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-10">
      <div className="mx-auto flex max-w-[680px] flex-col gap-10">
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
    <article className="flex flex-col gap-2">
      <header
        className={`text-xs italic ${isUser ? 'text-[var(--text-soft)]' : 'text-[var(--text-dim)]'}`}
        style={SERIF_STYLE}
      >
        {isUser ? 'You' : 'Assistant'}
      </header>
      <div className="flex flex-col gap-3">
        {message.blocks.length === 0 && message.status === 'streaming' ? (
          <StreamingDots />
        ) : (
          message.blocks.map((block, index) => (
            <BlockView
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are append-only per message
              key={index}
              block={block}
            />
          ))
        )}
        {message.status === 'error' && message.error && (
          <p className="text-sm text-[var(--error)]">Error: {message.error}</p>
        )}
      </div>
    </article>
  )
}

function BlockView({ block }: { block: Block }): ReactElement {
  if (block.type === 'reasoning') {
    return (
      <aside className="border-l-2 border-[var(--border-strong)] pl-4 text-[14px] italic text-[var(--text-soft)]">
        <div className="mb-1 text-[11px] not-italic text-[var(--text-dim)]" style={SERIF_STYLE}>
          thinking
        </div>
        <div className="whitespace-pre-wrap">{block.content}</div>
      </aside>
    )
  }
  return <p className="whitespace-pre-wrap text-[15px] leading-[1.7]">{block.content}</p>
}

function StreamingDots(): ReactElement {
  return (
    <div className="flex items-center gap-1.5 py-1">
      <Dot delay="0s" />
      <Dot delay="0.15s" />
      <Dot delay="0.3s" />
    </div>
  )
}

function Dot({ delay }: { delay: string }): ReactElement {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--text-dim)]"
      style={{ animation: 'pulse-dot 1.2s ease-in-out infinite', animationDelay: delay }}
    />
  )
}
