import type { EditorView } from '@codemirror/view'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { MarkdownEditor } from '@/components/markdown-editor/MarkdownEditor'
import type { DocContent } from './types'

interface DocEditorProps {
  initialTitle: string
  initialContent: DocContent
  onChange: (patch: { title?: string; content?: DocContent }) => Promise<void> | void
  onCreateView?: (view: EditorView) => void
}

const SAVE_DEBOUNCE_MS = 500

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved'

type DocPatch = { title?: string; content?: DocContent }

export function DocEditor({
  initialTitle,
  initialContent,
  onChange,
  onCreateView,
}: DocEditorProps): ReactElement {
  const [title, setTitle] = useState(initialTitle)
  const [content, setContent] = useState(initialContent)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

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

  const handleContentChange = useCallback(
    (next: string) => {
      setContent(next)
      scheduleSave({ content: next })
    },
    [scheduleSave],
  )

  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      <div className="flex-1 overflow-y-auto">
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
          <div className="mt-6">
            <MarkdownEditor
              value={content}
              onChange={handleContentChange}
              onBlur={() => void flush()}
              onSave={() => void flush()}
              onCreateView={onCreateView}
              autoFocus
              placeholder="Type markdown — # for headings, * for lists, ``` for code…"
            />
          </div>
        </div>
      </div>
    </div>
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
