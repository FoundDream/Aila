import type { ReactElement } from 'react'
import type { MarkdownHeading } from './markdownHeadings'

interface DocTocProps {
  headings: MarkdownHeading[]
  collapsed: boolean
  onToggleCollapsed: () => void
  onSelect: (heading: MarkdownHeading) => void
  className?: string
}

export function DocToc({
  headings,
  collapsed,
  onToggleCollapsed,
  onSelect,
  className = '',
}: DocTocProps): ReactElement | null {
  if (headings.length === 0) return null

  const minLevel = Math.min(...headings.map((heading) => heading.level))

  if (collapsed) {
    return (
      <button
        type="button"
        aria-label="Expand document outline"
        title="Expand outline"
        onClick={onToggleCollapsed}
        className={`flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-soft)_86%,var(--bg))] text-[var(--text-soft)] shadow-[0_8px_24px_rgba(31,31,28,0.08)] transition hover:border-[var(--border-strong)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)] ${className}`}
      >
        <OutlineIcon />
      </button>
    )
  }

  return (
    <nav
      aria-label="Document outline"
      className={`w-[220px] rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-soft)_88%,var(--bg))] p-2 shadow-[0_18px_50px_rgba(31,31,28,0.10)] backdrop-blur-md ${className}`}
    >
      <div className="mb-1 flex items-center gap-2 px-1">
        <div
          className="min-w-0 flex-1 text-[11px] tracking-wide text-[var(--text-dim)] uppercase"
          style={{ fontFamily: 'var(--font-sans)' }}
        >
          Outline
        </div>
        <button
          type="button"
          aria-label="Collapse document outline"
          title="Collapse outline"
          onClick={onToggleCollapsed}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <ChevronRightIcon />
        </button>
      </div>
      <ol className="max-h-[min(420px,calc(100vh-140px))] space-y-0.5 overflow-y-auto">
        {headings.map((heading) => (
          <li key={`${heading.id}-${heading.line}`}>
            <button
              type="button"
              title={heading.text}
              onClick={() => onSelect(heading)}
              className="block w-full truncate rounded px-1.5 py-1 text-left text-[12px] leading-snug text-[var(--text-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              style={{ paddingLeft: `${4 + (heading.level - minLevel) * 12}px` }}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

function OutlineIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

function ChevronRightIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}
