import { type ReactElement, useCallback, useMemo, useState } from 'react'
import { DocMarkdownView } from './DocMarkdownView'
import { DocToc } from './DocToc'
import { extractMarkdownHeadings } from './markdownHeadings'

interface DocReadViewProps {
  title: string
  content: string
  tocCollapsed: boolean
  onToggleToc: () => void
  onScrollContainer?: (el: HTMLDivElement | null) => void
}

function escapeSelector(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replace(/["\\]/g, '\\$&')
}

export function DocReadView({
  title,
  content,
  tocCollapsed,
  onToggleToc,
  onScrollContainer,
}: DocReadViewProps): ReactElement {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null)
  const headings = useMemo(() => {
    const allHeadings = extractMarkdownHeadings(content)
    return allHeadings.filter((heading) => heading.level >= 2 && heading.level <= 4)
  }, [content])
  const selectHeading = useCallback(
    (heading: (typeof headings)[number]) => {
      const target = scrollContainer?.querySelector<HTMLElement>(`#${escapeSelector(heading.id)}`)
      target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    },
    [scrollContainer],
  )
  const handleScrollContainer = useCallback(
    (el: HTMLDivElement | null) => {
      setScrollContainer(el)
      onScrollContainer?.(el)
    },
    [onScrollContainer],
  )

  return (
    <div className="relative flex h-full flex-col bg-[var(--bg)]">
      <div ref={handleScrollContainer} className="flex-1 overflow-y-auto">
        <article className="mx-auto w-full max-w-[760px] px-12 pt-12 pb-24">
          <DocMarkdownView
            title={title}
            content={content}
            contentClassName="aila-md-document"
            titleSpacingClassName="mb-6"
            titleClassName="text-[33px] leading-[1.18] font-normal tracking-tight text-[var(--text)]"
          />
        </article>
      </div>
      <DocToc
        headings={headings}
        collapsed={tocCollapsed}
        onToggleCollapsed={onToggleToc}
        onSelect={selectHeading}
        className="absolute top-4 right-4 z-20 max-[900px]:hidden"
      />
    </div>
  )
}
