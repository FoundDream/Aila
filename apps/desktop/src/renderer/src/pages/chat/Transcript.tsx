import {
  AlertCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FileTextIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
} from 'lucide-react'
import { type ReactElement, useCallback, useEffect, useState } from 'react'
import { Streamdown } from 'streamdown'
import { useStickToBottom } from 'use-stick-to-bottom'
import { markdownComponents } from '@/components/markdown/streamdownComponents'
import { markdownPlugins } from '@/components/markdown/streamdownPlugins'
import type { PersistedAgentEvent } from '../../types'
import { ContextCompactionStatus } from './ContextCompactionStatus'
import type { Block, Message, ToolCallBlock } from './types'

export function Transcript({
  messages,
  events = [],
  canRetryLast = false,
  onRetryLast,
  submitScrollKey = 0,
}: {
  messages: Message[]
  events?: PersistedAgentEvent[]
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
          <ContextCompactionStatus events={events} />
          {canRetryLast && onRetryLast && <RetryLastTurn onRetryLast={onRetryLast} />}
        </div>
      </div>
      {!isAtBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom()}
          aria-label="Jump to latest"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px] shadow-[0_2px_10px_rgba(0,0,0,0.08)"
        >
          ↓
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
  const isQueued = message.status === 'queued'
  const canCopy = !isStreaming && messageToPlainText(message).length > 0

  if (isUser) {
    return (
      <article className="group flex flex-col items-end gap-1">
        <div
          className={`max-w-[85%] rounded-[18px] px-4 py-2.5 ${
            isQueued
              ? 'border border-dashed border-[var(--border-strong)] bg-transparent text-[var(--text-soft)]'
              : 'bg-[var(--bg-soft)]'
          }`}
        >
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
        {isQueued && (
          <div className="mr-1 flex items-center gap-1 text-[11px] text-[var(--text-dim)]">
            <LoaderCircleIcon className="size-3 animate-spin" />
            Queued
          </div>
        )}
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
    return <ReasoningView content={block.content} isStreaming={isStreaming} />
  }
  if (block.type === 'image') {
    return (
      <figure className="flex w-64 max-w-full flex-col gap-1">
        <div className="grid h-44 w-64 max-w-full place-items-center overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <img
            src={block.url}
            alt={block.prompt ?? 'generated image'}
            className="h-full w-full object-contain"
          />
        </div>
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
      lineNumbers={false}
      parseIncompleteMarkdown
      plugins={markdownPlugins}
      className="aila-md text-[15px] leading-[1.7]"
    >
      {block.content}
    </Streamdown>
  )
}

function ReasoningView({
  content,
  isStreaming,
}: {
  content: string
  isStreaming: boolean
}): ReactElement {
  const [expanded, setExpanded] = useState(isStreaming)

  useEffect(() => {
    setExpanded(isStreaming)
  }, [isStreaming])

  return (
    <aside className="my-0.5 text-[13px] text-[var(--text-dim)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left outline-none transition-colors hover:text-[var(--text)] focus-visible:text-[var(--text)]"
        aria-expanded={expanded}
      >
        <ChevronRightIcon
          className={`size-3 shrink-0 text-[var(--text-dim)] transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
        />
        <span className="font-medium text-[var(--text-soft)]">Thinking</span>
      </button>
      {expanded && (
        <div className="ml-4 mt-1 border-l border-[var(--border)] pl-3">
          <Streamdown
            mode={isStreaming ? 'streaming' : 'static'}
            components={markdownComponents}
            lineNumbers={false}
            parseIncompleteMarkdown
            plugins={markdownPlugins}
            className="aila-md aila-md-reasoning text-[13px] leading-[1.6]"
          >
            {content}
          </Streamdown>
        </div>
      )}
    </aside>
  )
}

function ToolCallView({ block }: { block: ToolCallBlock }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const summary = toolCallSummary(block)
  const resultLabel = block.status === 'error' ? 'Error' : 'Result'
  const statusColor =
    block.status === 'error'
      ? 'text-[var(--error)]'
      : block.status === 'running'
        ? 'text-[var(--blue)]'
        : 'text-[var(--text-dim)]'
  return (
    <aside className="my-0.5 text-[13px] text-[var(--text-soft)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left outline-none transition-colors hover:text-[var(--text)] focus-visible:text-[var(--text)]"
        aria-expanded={expanded}
      >
        <ChevronRightIcon
          className={`size-3 shrink-0 text-[var(--text-dim)] transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
        />
        <ToolStatusIcon status={block.status} />
        <span className="shrink-0 font-medium text-[var(--text)]">{summary.action}</span>
        {summary.detail && (
          <span className="min-w-0 truncate text-[var(--text-dim)]">{summary.detail}</span>
        )}
        <span className={`ml-auto shrink-0 text-[11px] ${statusColor}`}>{summary.status}</span>
      </button>
      {expanded && (
        <div className="ml-6 mt-1 border-l border-[var(--border)] pl-3">
          <ToolPayload label="Input" value={block.arguments || '{}'} />
          {block.result !== undefined && (
            <ToolPayload
              label={resultLabel}
              value={block.result}
              tone={block.status === 'error' ? 'error' : 'neutral'}
            />
          )}
        </div>
      )}
    </aside>
  )
}

function ToolStatusIcon({ status }: { status: ToolCallBlock['status'] }): ReactElement {
  if (status === 'running') {
    return <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-[var(--blue)]" />
  }
  if (status === 'error') {
    return <AlertCircleIcon className="size-3.5 shrink-0 text-[var(--error)]" />
  }
  return <CheckIcon className="size-3.5 shrink-0 text-[var(--text-dim)]" />
}

function ToolPayload({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'error'
}): ReactElement {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 text-[11px] font-medium text-[var(--text-dim)]">{label}</div>
      <pre
        className={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--bg-soft)] px-3 py-2 font-mono text-[11.5px] leading-relaxed ${
          tone === 'error' ? 'text-[var(--error)]' : 'text-[var(--text-soft)]'
        }`}
      >
        {formatToolPayload(value)}
      </pre>
    </div>
  )
}

function toolCallSummary(block: ToolCallBlock): {
  action: string
  detail?: string
  status: string
} {
  const args = parseToolArguments(block.arguments)
  const detail =
    stringArg(args, 'command') ??
    stringArg(args, 'cmd') ??
    stringArg(args, 'path') ??
    stringArg(args, 'file') ??
    stringArg(args, 'query') ??
    stringArg(args, 'q') ??
    stringArg(args, 'prompt')

  return {
    action: toolActionLabel(block.name),
    ...(detail ? { detail } : {}),
    status: block.status === 'running' ? 'Running' : block.status === 'error' ? 'Failed' : 'Done',
  }
}

function toolActionLabel(name: string): string {
  const normalized = name.toLowerCase().replaceAll('-', '_')
  if (['bash', 'shell', 'run_shell', 'exec_command'].includes(normalized)) return 'Ran command'
  if (['read', 'read_file', 'open_file'].includes(normalized)) return 'Read file'
  if (['write', 'write_file', 'create_file'].includes(normalized)) return 'Wrote file'
  if (['edit', 'apply_patch', 'replace'].includes(normalized)) return 'Edited file'
  if (['list', 'ls', 'list_files'].includes(normalized)) return 'Listed files'
  if (['grep', 'search', 'rg', 'find'].includes(normalized)) return 'Searched'
  if (['web_search', 'search_web'].includes(normalized)) return 'Searched web'
  if (['generate_image', 'image_generation'].includes(normalized)) return 'Generated image'
  return `Called ${name}`
}

function parseToolArguments(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringArg(args: Record<string, unknown> | null, key: string): string | null {
  const value = args?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function formatToolPayload(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
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
      style={{
        animation: 'pulse-dot 1.2s ease-in-out infinite',
        animationDelay: delay,
      }}
    />
  )
}
