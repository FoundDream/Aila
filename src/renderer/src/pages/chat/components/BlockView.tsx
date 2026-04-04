import type { ReactElement } from 'react'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import type { Block } from '@/types/chat'
import { formatArgs } from '@/utils/formatArgs'

const remarkPlugins = [remarkGfm]
const rehypePlugins = [rehypeHighlight]

export function BlockView({ block }: { block: Block }): ReactElement | null {
  const [expanded, setExpanded] = useState(false)

  if (block.type === 'text') {
    return (
      <div className="markdown-body text-[13px] text-[var(--term-text)]">
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
          {block.content}
        </ReactMarkdown>
      </div>
    )
  }

  if (block.type === 'thinking') {
    return (
      <details className="group">
        <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--term-dim)] transition select-none hover:text-[var(--term-text-soft)]">
          <svg
            className="h-3 w-3 transition group-open:rotate-90"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
          <path d="M6 4l4 4-4 4" />
          </svg>
          thinking...
        </summary>
        <div className="mt-2 border-l border-[var(--term-border-strong)] pl-3">
          <div className="markdown-body text-[12px] leading-relaxed text-[var(--term-text-soft)]">
            <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
              {block.content}
            </ReactMarkdown>
          </div>
        </div>
      </details>
    )
  }

  if (block.type === 'tool') {
    const isRunning = block.status === 'running'
    const isError = block.isError

    return (
      <div className="overflow-hidden rounded border border-[var(--term-border)] bg-[var(--term-surface)]">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] transition hover:bg-[var(--term-surface-soft)]"
        >
          <span
            className={`text-[11px] ${
              isRunning
                ? 'text-[var(--term-yellow)]'
                : isError
                  ? 'text-[var(--term-red)]'
                  : 'text-[var(--term-cyan)]'
            }`}
          >
            {isRunning ? '...' : isError ? 'x' : 'ok'}
          </span>
          <span className="text-[var(--term-text)]">{block.name}</span>
          <span className="min-w-0 flex-1 truncate text-[var(--term-dim)]">
            {formatArgs(block.args)}
          </span>
          <svg
            className={`h-3 w-3 shrink-0 text-[var(--term-dim)] transition ${expanded ? 'rotate-90' : ''}`}
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
        </button>
        {expanded && block.result && (
          <pre className="max-h-60 overflow-auto border-t border-[var(--term-border)] bg-[var(--term-surface-soft)] px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-all text-[var(--term-text-soft)]">
            {block.result}
          </pre>
        )}
        {!expanded && block.result && (
          <div className="truncate border-t border-[var(--term-border)] bg-[var(--term-surface-soft)] px-3 py-1.5 text-[11px] text-[var(--term-dim)]">
            {block.result.length > 200 ? `${block.result.slice(0, 200)}...` : block.result}
          </div>
        )}
      </div>
    )
  }

  return null
}
