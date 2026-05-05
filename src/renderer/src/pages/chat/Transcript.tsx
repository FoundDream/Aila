import { CheckIcon, ChevronRightIcon, CopyIcon, WrenchIcon } from 'lucide-react'
import { type ReactElement, useCallback, useState } from 'react'
import { Streamdown } from 'streamdown'
import { useStickToBottom } from 'use-stick-to-bottom'
import type { Block, Message, ToolCallBlock } from './types'

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
  const canCopy = !isStreaming && messageToPlainText(message).length > 0
  return (
    <article className="group flex flex-col gap-2">
      <header
        className={`flex items-center justify-between text-xs italic ${
          isUser ? 'text-[var(--text-soft)]' : 'text-[var(--text-dim)]'
        }`}
        style={SERIF_STYLE}
      >
        <span>{isUser ? 'You' : 'Assistant'}</span>
        {canCopy && <CopyButton message={message} />}
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

function CopyButton({ message }: { message: Message }): ReactElement {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(async () => {
    const text = messageToPlainText(message)
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore — clipboard may be unavailable
    }
  }, [message])
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy message'}
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] not-italic text-[var(--text-dim)] transition-opacity hover:text-[var(--text)] ${
        copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
      }`}
    >
      {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
      <span style={SERIF_STYLE} className="italic">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  )
}

function messageToPlainText(message: Message): string {
  return message.blocks
    .filter((b): b is Extract<Block, { type: 'text' | 'reasoning' }> => b.type === 'text')
    .map((b) => b.content)
    .join('\n\n')
    .trim()
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
  if (block.type === 'image') {
    return (
      <figure className="flex flex-col gap-1">
        <img
          src={block.url}
          alt={block.prompt ?? 'generated image'}
          className="max-w-full rounded-md border border-[var(--border-strong)]"
        />
        {block.prompt && (
          <figcaption className="text-[11px] italic text-[var(--text-dim)]" style={SERIF_STYLE}>
            {block.prompt}
          </figcaption>
        )}
      </figure>
    )
  }
  if (block.type === 'tool_call') {
    return <ToolCallView block={block} />
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

function ToolCallView({ block }: { block: ToolCallBlock }): ReactElement {
  // Auto-expand while running so streaming arguments are visible — long
  // payloads (e.g. edit_doc's new_string) used to look like a frozen UI.
  const [expanded, setExpanded] = useState(block.status === 'running')
  const statusLabel =
    block.status === 'running' ? 'running' : block.status === 'error' ? 'error' : 'done'
  const statusColor =
    block.status === 'error'
      ? 'text-[var(--error)]'
      : block.status === 'running'
        ? 'text-[var(--text-soft)]'
        : 'text-[var(--text-dim)]'
  return (
    <aside className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-soft,transparent)] font-mono text-[12px] text-[var(--text-soft)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]"
        aria-expanded={expanded}
      >
        <ChevronRightIcon
          className={`h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <WrenchIcon className="h-3 w-3 shrink-0" />
        <span className="truncate text-[var(--text)]">{block.name}</span>
        <span className={`ml-auto shrink-0 ${statusColor}`}>{statusLabel}</span>
      </button>
      {expanded && (
        <div className="border-t border-[var(--border-strong)] px-3 py-2">
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
        </div>
      )}
    </aside>
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
