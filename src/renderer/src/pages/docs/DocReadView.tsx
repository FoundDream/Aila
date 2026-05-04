import type { ReactElement } from 'react'
import { Streamdown } from 'streamdown'

interface DocReadViewProps {
  title: string
  content: string
  onScrollContainer?: (el: HTMLDivElement | null) => void
}

export function DocReadView({
  title,
  content,
  onScrollContainer,
}: DocReadViewProps): ReactElement {
  const trimmedTitle = title.trim()
  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      <div ref={onScrollContainer} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-12 pt-12 pb-24">
          {trimmedTitle && (
            <h1
              className="mb-6 text-[34px] leading-[1.2] font-normal tracking-tight text-[var(--text)]"
              style={{ fontFamily: 'var(--font-serif)' }}
            >
              {trimmedTitle}
            </h1>
          )}
          <Streamdown mode="static" className="aila-md text-[15px] leading-[1.7]">
            {content}
          </Streamdown>
        </div>
      </div>
    </div>
  )
}
