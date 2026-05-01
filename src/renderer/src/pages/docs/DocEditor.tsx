import { Plate, usePlateEditor } from 'platejs/react'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { NoteEditorKit } from '@/components/editor/editor-kit'
import { Editor, EditorContainer } from '@/components/ui/editor'
import { type DocContent, EMPTY_DOC_CONTENT } from './types'

interface DocEditorProps {
  initialTitle: string
  initialContent: DocContent
  onChange: (patch: { title?: string; content?: DocContent }) => void
}

const SAVE_DEBOUNCE_MS = 500

export function DocEditor({
  initialTitle,
  initialContent,
  onChange,
}: DocEditorProps): ReactElement {
  const [title, setTitle] = useState(initialTitle)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = usePlateEditor({
    plugins: NoteEditorKit,
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

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    [],
  )

  return (
    <Plate
      editor={editor}
      onChange={({ value }) => scheduleSave({ content: value })}
    >
      <div className="flex h-full flex-col bg-[var(--bg)]">
        <EditorContainer variant="default" className="flex-1">
          <div className="mx-auto w-full max-w-[760px] px-12 pt-12 pb-24">
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
            <div className="mt-6">
              <Editor
                variant="none"
                autoFocus
                placeholder="Type / to insert blocks, or just start writing…"
                className="text-[15.5px] leading-[1.75] text-[var(--text)]"
              />
            </div>
          </div>
        </EditorContainer>
      </div>
    </Plate>
  )
}
