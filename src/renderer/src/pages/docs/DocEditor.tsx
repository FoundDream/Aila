import {
  BlockquoteRules,
  BoldRules,
  HeadingRules,
  ItalicRules,
  StrikethroughRules,
  UnderlineRules,
} from '@platejs/basic-nodes'
import {
  BlockquotePlugin,
  BoldPlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  ItalicPlugin,
  StrikethroughPlugin,
  UnderlinePlugin,
} from '@platejs/basic-nodes/react'
import {
  Plate,
  PlateContent,
  PlateElement,
  type PlateElementProps,
  usePlateEditor,
} from 'platejs/react'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { type DocContent, EMPTY_DOC_CONTENT } from './types'

interface DocEditorProps {
  initialTitle: string
  initialContent: DocContent
  onChange: (patch: { title?: string; content?: DocContent }) => void
}

const SAVE_DEBOUNCE_MS = 500

function H1Element(props: PlateElementProps): ReactElement {
  return (
    <PlateElement
      as="h1"
      className="mt-10 mb-3 text-[26px] leading-tight font-medium tracking-tight text-[var(--text)]"
      {...props}
    />
  )
}

function H2Element(props: PlateElementProps): ReactElement {
  return (
    <PlateElement
      as="h2"
      className="mt-8 mb-2 text-[20px] leading-snug font-medium tracking-tight text-[var(--text)]"
      {...props}
    />
  )
}

function H3Element(props: PlateElementProps): ReactElement {
  return (
    <PlateElement
      as="h3"
      className="mt-6 mb-2 text-[16px] leading-snug font-semibold text-[var(--text)]"
      {...props}
    />
  )
}

function BlockquoteElement(props: PlateElementProps): ReactElement {
  return (
    <PlateElement
      as="blockquote"
      className="my-3 border-l-2 border-[var(--border-strong)] pl-5 text-[var(--text-soft)]"
      style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
      {...props}
    />
  )
}

export function DocEditor({
  initialTitle,
  initialContent,
  onChange,
}: DocEditorProps): ReactElement {
  const [title, setTitle] = useState(initialTitle)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = usePlateEditor({
    plugins: [
      BoldPlugin.configure({ inputRules: [BoldRules.markdown()] }),
      ItalicPlugin.configure({ inputRules: [ItalicRules.markdown()] }),
      UnderlinePlugin.configure({ inputRules: [UnderlineRules.markdown()] }),
      StrikethroughPlugin.configure({ inputRules: [StrikethroughRules.markdown()] }),
      H1Plugin.withComponent(H1Element).configure({
        inputRules: [HeadingRules.markdown()],
      }),
      H2Plugin.withComponent(H2Element),
      H3Plugin.withComponent(H3Element),
      BlockquotePlugin.withComponent(BlockquoteElement).configure({
        inputRules: [BlockquoteRules.markdown()],
      }),
    ],
    value: initialContent.length > 0 ? initialContent : EMPTY_DOC_CONTENT,
  })

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleSave = useCallback((patch: { title?: string; content?: DocContent }) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      onChangeRef.current(patch)
    }, SAVE_DEBOUNCE_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-12 pt-16 pb-24">
          <input
            value={title}
            onChange={(event) => {
              const next = event.target.value
              setTitle(next)
              scheduleSave({ title: next })
            }}
            placeholder="无标题文档"
            className="w-full bg-transparent text-[34px] leading-[1.2] font-normal tracking-tight text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
            style={{ fontFamily: 'var(--font-serif)' }}
          />
          <div className="mt-8">
            <Plate
              editor={editor}
              onChange={({ value }) => {
                scheduleSave({ content: value })
              }}
            >
              <PlateContent
                autoFocus
                placeholder="Start writing…"
                className="aila-prose text-[15.5px] leading-[1.75] text-[var(--text)] outline-none"
              />
            </Plate>
          </div>
        </div>
      </div>
    </div>
  )
}
