import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FileTextIcon,
  RotateCcwIcon,
  TerminalIcon,
} from 'lucide-react'
import { type ReactElement, useCallback, useEffect, useState } from 'react'
import { Streamdown } from 'streamdown'
import { useStickToBottom } from 'use-stick-to-bottom'
import { markdownComponents } from '@/components/markdown/streamdownComponents'
import type { Block, Message, ToolCallBlock } from './types'

export function Transcript({
  messages,
  canRetryLast = false,
  onRetryLast,
  submitScrollKey = 0,
}: {
  messages: Message[]
  canRetryLast?: boolean
  onRetryLast?: () => void
  submitScrollKey?: number
}): ReactElement {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    initial: 'instant',
    resize: 'instant',
  })

  useEffect(() => {
    if (submitScrollKey === 0) return
    void scrollToBottom({ animation: 'instant', ignoreEscapes: true })
  }, [submitScrollKey, scrollToBottom])

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-[22px] font-medium text-[var(--text)]">What can I help with?</p>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-8">
        <div ref={contentRef} className="mx-auto flex max-w-[680px] flex-col gap-7">
          {messages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
          {canRetryLast && onRetryLast && <RetryLastTurn onRetryLast={onRetryLast} />}
        </div>
      </div>
      {!isAtBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom()}
          aria-label="Jump to latest"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-[12px] text-[var(--text-soft)] shadow-[0_2px_10px_rgba(0,0,0,0.08)] transition-colors hover:text-[var(--text)]"
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  )
}

function RetryLastTurn({ onRetryLast }: { onRetryLast: () => void }): ReactElement {
  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={onRetryLast}
        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3.5 py-1.5 text-[12.5px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      >
        <RotateCcwIcon className="h-3.5 w-3.5" />
        Resume last turn
      </button>
    </div>
  )
}

function MessageRow({ message }: { message: Message }): ReactElement {
  const isUser = message.role === 'user'
  const isStreaming = message.status === 'streaming'
  const canCopy = !isStreaming && messageToPlainText(message).length > 0

  if (isUser) {
    return (
      <article className="group flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-[18px] bg-[var(--bg-soft)] px-4 py-2.5">
          <div className="flex flex-col gap-3">
            {message.blocks.map((block, index) => (
              <BlockView
                // biome-ignore lint/suspicious/noArrayIndexKey: blocks are append-only per message
                key={index}
                block={block}
                isStreaming={isStreaming}
              />
            ))}
          </div>
        </div>
        {canCopy && <CopyButton message={message} />}
      </article>
    )
  }

  return (
    <article className="group flex flex-col gap-1">
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
      {canCopy && <CopyButton message={message} />}
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
      title={copied ? 'Copied' : 'Copy'}
      className={`grid size-6 place-items-center rounded-md text-[var(--text-dim)] transition-opacity hover:bg-[var(--surface-hover)] hover:text-[var(--text)] ${
        copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
      }`}
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
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
      <aside className="text-[13.5px] leading-[1.6] text-[var(--text-dim)]">
        <div className="mb-1 text-[12px] font-medium text-[var(--text-soft)]">Thinking</div>
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
          className="max-w-full rounded-xl border border-[var(--border)]"
        />
        {block.prompt && (
          <figcaption className="text-[11.5px] text-[var(--text-dim)]">{block.prompt}</figcaption>
        )}
      </figure>
    )
  }
  if (block.type === 'file') {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5 self-start rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[12px] text-[var(--text-soft)]">
        <FileTextIcon className="size-3.5 shrink-0 text-[var(--text-dim)]" />
        <span className="min-w-0 truncate">{block.name}</span>
      </span>
    )
  }
  if (block.type === 'tool_call') {
    return <ToolCallView block={block} />
  }
  return (
    <Streamdown
      mode={isStreaming ? 'streaming' : 'static'}
      components={markdownComponents}
      parseIncompleteMarkdown
      className="aila-md text-[15px] leading-[1.7]"
    >
      {block.content}
    </Streamdown>
  )
}

function ToolCallView({ block }: { block: ToolCallBlock }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const statusLabel =
    block.status === 'running' ? 'Running' : block.status === 'error' ? 'Error' : 'Done'
  const statusColor =
    block.status === 'error'
      ? 'text-[var(--error)]'
      : block.status === 'running'
        ? 'text-[var(--blue)]'
        : 'text-[var(--text-dim)]'
  return (
    <aside className="overflow-hidden rounded-xl bg-[var(--bg-soft)] font-mono text-[12px] text-[var(--text-soft)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11.5px] text-[var(--text-dim)] hover:text-[var(--text)]"
        aria-expanded={expanded}
      >
        <ChevronRightIcon
          className={`h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <TerminalIcon className="h-3 w-3 shrink-0" />
        <span className="truncate text-[var(--text-soft)]">{block.name}</span>
        <span className={`ml-auto shrink-0 ${statusColor}`}>{statusLabel}</span>
      </button>
      {expanded && (
        <div className="border-t border-[var(--border)] px-3 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[var(--text-soft)]">
            {block.arguments || '{}'}
          </pre>
          {block.result !== undefined && (
            <pre
              className={`mt-2 overflow-x-auto whitespace-pre-wrap break-all border-t border-[var(--border)] pt-2 ${
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
