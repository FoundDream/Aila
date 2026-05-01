import type { ReactElement } from 'react'
import { Streamdown } from 'streamdown'
import { useStickToBottom } from 'use-stick-to-bottom'
import type { Block, Message } from './types'

const SERIF_STYLE: React.CSSProperties = { fontFamily: 'var(--font-serif)' }

export function Transcript({ messages }: { messages: Message[] }): ReactElement {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    initial: 'instant',
    resize: 'instant',
  })

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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-10">
        <div ref={contentRef} className="mx-auto flex max-w-[680px] flex-col gap-10">
          {messages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
        </div>
      </div>
      {!isAtBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom()}
          aria-label="Jump to latest"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-1 text-[12px] italic text-[var(--text-dim)] shadow-sm transition-colors hover:text-[var(--text)]"
          style={SERIF_STYLE}
        >
          ↓ jump to latest
        </button>
      )}
    </div>
  )
}

function MessageRow({ message }: { message: Message }): ReactElement {
  const isUser = message.role === 'user'
  const isStreaming = message.status === 'streaming'
  return (
    <article className="flex flex-col gap-2">
      <header
        className={`text-xs italic ${isUser ? 'text-[var(--text-soft)]' : 'text-[var(--text-dim)]'}`}
        style={SERIF_STYLE}
      >
        {isUser ? 'You' : 'Assistant'}
      </header>
      <div className="flex flex-col gap-3">
        {message.blocks.length === 0 && isStreaming ? (
          <StreamingDots />
        ) : (
          message.blocks.map((block, index) => (
            <BlockView
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are append-only per message
              key={index}
              block={block}
              isStreaming={isStreaming}
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

function BlockView({ block, isStreaming }: { block: Block; isStreaming: boolean }): ReactElement {
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
  if (block.type === 'tool_call') {
    const statusLabel =
      block.status === 'running' ? 'running' : block.status === 'error' ? 'error' : 'done'
    return (
      <aside className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-soft,transparent)] p-3 font-mono text-[12px] text-[var(--text-soft)]">
        <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--text-dim)]">
          <span>
            tool · <span className="text-[var(--text)]">{block.name}</span>
          </span>
          <span>{statusLabel}</span>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[var(--text-soft)]">
          {block.arguments || '{}'}
        </pre>
        {block.result !== undefined && (
          <pre
            className={`mt-2 overflow-x-auto whitespace-pre-wrap break-all border-t border-[var(--border-strong)] pt-2 ${
              block.status === 'error' ? 'text-[var(--error)]' : 'text-[var(--text-soft)]'
            }`}
          >
            {block.result}
          </pre>
        )}
      </aside>
    )
  }
  return (
    <Streamdown
      mode={isStreaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown
      className="aila-md text-[15px] leading-[1.7]"
    >
      {block.content}
    </Streamdown>
  )
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
