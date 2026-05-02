import { Plate, usePlateEditor } from 'platejs/react'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { createNoteEditorKit } from '@/components/editor/editor-kit'
import { Editor, EditorContainer } from '@/components/ui/editor'
import { type DocContent, EMPTY_DOC_CONTENT } from './types'

interface DocEditorProps {
  initialTitle: string
  initialContent: DocContent
  onChange: (patch: { title?: string; content?: DocContent }) => Promise<void> | void
}

const SAVE_DEBOUNCE_MS = 500

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved'

type DocPatch = { title?: string; content?: DocContent }

export function DocEditor({
  initialTitle,
  initialContent,
  onChange,
}: DocEditorProps): ReactElement {
  const [title, setTitle] = useState(initialTitle)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = usePlateEditor({
    plugins: createNoteEditorKit(),
    value: initialContent.length > 0 ? initialContent : EMPTY_DOC_CONTENT,
  })

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPatchRef = useRef<DocPatch | null>(null)

  const flush = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    const patch = pendingPatchRef.current
    if (!patch) return
    pendingPatchRef.current = null
    setStatus('saving')
    try {
      await onChangeRef.current(patch)
      setLastSavedAt(Date.now())
      setStatus((prev) => (prev === 'saving' ? 'saved' : prev))
    } catch (err) {
      console.error('Failed to save doc', err)
      pendingPatchRef.current = { ...patch, ...(pendingPatchRef.current ?? {}) }
      setStatus('dirty')
    }
  }, [])

  const scheduleSave = useCallback(
    (patch: DocPatch) => {
      pendingPatchRef.current = { ...pendingPatchRef.current, ...patch }
      setStatus('dirty')
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        void flush()
      }, SAVE_DEBOUNCE_MS)
    },
    [flush],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === 's') {
        event.preventDefault()
        void flush()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flush])

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      const patch = pendingPatchRef.current
      if (patch) {
        pendingPatchRef.current = null
        void onChangeRef.current(patch)
      }
    }
  }, [])

  const handleEditorBlur = (event: React.FocusEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    void flush()
  }

  return (
    <Plate editor={editor} onChange={({ value }) => scheduleSave({ content: value })}>
      <div className="flex h-full flex-col bg-[var(--bg)]">
        <EditorContainer variant="default" className="flex-1">
          <div className="relative mx-auto w-full max-w-[760px] px-12 pt-12 pb-24">
            <div className="pointer-events-none absolute top-3 right-12 text-[12px] text-[var(--text-dim)]">
              <SaveStatusLabel status={status} lastSavedAt={lastSavedAt} />
            </div>
            <input
              value={title}
              onChange={(event) => {
                const next = event.target.value
                setTitle(next)
                scheduleSave({ title: next })
              }}
              onBlur={() => void flush()}
              placeholder="无标题文档"
              className="w-full bg-transparent text-[34px] leading-[1.2] font-normal tracking-tight text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
              style={{ fontFamily: 'var(--font-serif)' }}
            />
            <div className="mt-6" onBlur={handleEditorBlur}>
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

function SaveStatusLabel({
  status,
  lastSavedAt,
}: {
  status: SaveStatus
  lastSavedAt: number | null
}): ReactElement | null {
  if (status === 'idle') return null
  if (status === 'dirty') return <span>Edited</span>
  if (status === 'saving') return <span>Saving…</span>
  if (status === 'saved' && lastSavedAt !== null) {
    return <span>Saved · {formatRelative(lastSavedAt)}</span>
  }
  return null
}

function formatRelative(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}
