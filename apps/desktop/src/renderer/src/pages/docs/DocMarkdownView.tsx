import { type ReactElement, useMemo } from 'react'
import { Streamdown } from 'streamdown'
import { markdownComponents } from '@/components/markdown/streamdownComponents'
import { markdownPlugins } from '@/components/markdown/streamdownPlugins'
import { docsRehypePlugins } from './docHtmlRendering'

interface DocMarkdownViewProps {
  title: string
  content: string
  contentClassName?: string
  titleClassName: string
  titleSpacingClassName: string
}

export function DocMarkdownView({
  title,
  content,
  contentClassName = '',
  titleClassName,
  titleSpacingClassName,
}: DocMarkdownViewProps): ReactElement {
  const trimmedTitle = title.trim()
  const rehypePlugins = useMemo(() => docsRehypePlugins, [])

  return (
    <>
      {trimmedTitle && (
        <h1
          className={`${titleSpacingClassName} ${titleClassName}`}
          style={{ fontFamily: 'var(--font-doc-title)' }}
        >
          {trimmedTitle}
        </h1>
      )}
      <Streamdown
        mode="static"
        components={markdownComponents}
        lineNumbers={false}
        plugins={markdownPlugins}
        rehypePlugins={rehypePlugins}
        className={`aila-md aila-md-read ${contentClassName}`}
      >
        {content}
      </Streamdown>
    </>
  )
}
