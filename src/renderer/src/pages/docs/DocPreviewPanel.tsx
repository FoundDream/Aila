import type { ReactElement } from 'react'
import { Streamdown } from 'streamdown'

interface DocPreviewPanelProps {
  title: string
  content: string
  onClose: () => void
  onScrollContainer?: (el: HTMLElement | null) => void
}

export function DocPreviewPanel({
  title,
  content,
  onClose,
  onScrollContainer,
}: DocPreviewPanelProps): ReactElement {
  const trimmedTitle = title.trim()
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 px-2">
        <div
          className="min-w-0 flex-1 truncate px-1.5 text-[12.5px] tracking-wide text-[var(--text-dim)]"
          style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
        >
          Preview
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <CloseIcon />
        </button>
      </header>
      <main ref={onScrollContainer} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="px-6 pt-4 pb-12">
          {trimmedTitle && (
            <h1
              className="mb-4 text-[26px] leading-[1.25] font-normal tracking-tight text-[var(--text)]"
              style={{ fontFamily: 'var(--font-serif)' }}
            >
              {trimmedTitle}
            </h1>
          )}
          <Streamdown mode="static" className="aila-md text-[15px] leading-[1.7]">
            {content}
          </Streamdown>
        </div>
      </main>
    </div>
  )
}

function CloseIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
