import { type ReactElement, useMemo } from 'react'
import { Streamdown } from 'streamdown'
import { createHeadingIdRehypePlugin } from './markdownHeadings'

interface DocMarkdownViewProps {
  title: string
  content: string
  titleClassName: string
  titleSpacingClassName: string
}

export function DocMarkdownView({
  title,
  content,
  titleClassName,
  titleSpacingClassName,
}: DocMarkdownViewProps): ReactElement {
  const trimmedTitle = title.trim()
  const rehypePlugins = useMemo(() => [createHeadingIdRehypePlugin()], [])

  return (
    <>
      {trimmedTitle && (
        <h1
          className={`${titleSpacingClassName} ${titleClassName}`}
          style={{ fontFamily: 'var(--font-serif)' }}
        >
          {trimmedTitle}
        </h1>
      )}
      <Streamdown
        mode="static"
        rehypePlugins={rehypePlugins}
        className="aila-md aila-md-read text-[15px] leading-[1.75]"
      >
        {content}
      </Streamdown>
    </>
  )
}
