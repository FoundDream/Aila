import { EditorView } from '@codemirror/view'
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownEditor } from '@/components/markdown-editor/MarkdownEditor'
import { DocToc } from './DocToc'
import { extractMarkdownHeadings, type MarkdownHeading } from './markdownHeadings'
import type { DocContent } from './types'

interface DocEditorProps {
  initialTitle: string
  initialContent: DocContent
  onChange: (patch: { title?: string; content?: DocContent }) => Promise<void> | void
  // Fires synchronously on every keystroke. Use for live consumers like the
  // preview panel — distinct from `onChange`, which is debounced for saving.
  onLiveChange?: (patch: { title?: string; content?: DocContent }) => void
  onCreateView?: (view: EditorView) => void
  // Callback ref for the scroll container, used by DocsPage to drive scroll
  // sync between editor and preview.
  onScrollContainer?: (el: HTMLDivElement | null) => void
  tocCollapsed: boolean
  onToggleToc: () => void
}

const SAVE_DEBOUNCE_MS = 500

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved'

type DocPatch = { title?: string; content?: DocContent }

export function DocEditor({
  initialTitle,
  initialContent,
  onChange,
  onLiveChange,
  onCreateView,
  onScrollContainer,
  tocCollapsed,
  onToggleToc,
}: DocEditorProps): ReactElement {
  const [title, setTitle] = useState(initialTitle)
  const [content, setContent] = useState(initialContent)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onLiveChangeRef = useRef(onLiveChange)
  onLiveChangeRef.current = onLiveChange
  const viewRef = useRef<EditorView | null>(null)

  const headings = useMemo(() => {
    const allHeadings = extractMarkdownHeadings(content)
    return allHeadings.filter((heading) => heading.level >= 2 && heading.level <= 4)
  }, [content])

  // Title and content are tracked separately because they save under different
  // policies. Content is debounced (cheap writeFile, frequent edits). Title
  // commits only on blur / Cmd-S / unmount — every commit is `fs.rename`
  // followed by a meta-file cascade rewrite, so per-keystroke commits would
  // produce N renames + N event refreshes per word typed, plus break Chinese
  // IME (partial composition can briefly produce filename-illegal chars).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTitleRef = useRef<string | null>(null)
  const pendingContentRef = useRef<DocContent | null>(null)

  const flush = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    const patch: DocPatch = {}
    if (pendingTitleRef.current !== null) patch.title = pendingTitleRef.current
    if (pendingContentRef.current !== null) patch.content = pendingContentRef.current
    if (patch.title === undefined && patch.content === undefined) return
    pendingTitleRef.current = null
    pendingContentRef.current = null
    setStatus('saving')
    try {
      await onChangeRef.current(patch)
      setLastSavedAt(Date.now())
      setStatus((prev) => (prev === 'saving' ? 'saved' : prev))
    } catch (err) {
      console.error('Failed to save doc', err)
      // Re-stage what we tried to save so the next flush will retry. New
      // pending edits arriving in the meantime take precedence.
      if (patch.title !== undefined && pendingTitleRef.current === null) {
        pendingTitleRef.current = patch.title
      }
      if (patch.content !== undefined && pendingContentRef.current === null) {
        pendingContentRef.current = patch.content
      }
      setStatus('dirty')
    }
  }, [])

  const scheduleContentSave = useCallback(
    (next: DocContent) => {
      pendingContentRef.current = next
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
      const patch: DocPatch = {}
      if (pendingTitleRef.current !== null) patch.title = pendingTitleRef.current
      if (pendingContentRef.current !== null) patch.content = pendingContentRef.current
      if (patch.title === undefined && patch.content === undefined) return
      pendingTitleRef.current = null
      pendingContentRef.current = null
      void onChangeRef.current(patch)
    }
  }, [])

  const handleContentChange = useCallback(
    (next: string) => {
      setContent(next)
      scheduleContentSave(next)
      onLiveChangeRef.current?.({ content: next })
    },
    [scheduleContentSave],
  )

  const handleCreateView = useCallback(
    (view: EditorView) => {
      viewRef.current = view
      onCreateView?.(view)
    },
    [onCreateView],
  )

  const selectHeading = useCallback((heading: MarkdownHeading) => {
    const view = viewRef.current
    if (!view) return

    const lineNumber = Math.min(Math.max(heading.line, 1), view.state.doc.lines)
    const pos = view.state.doc.line(lineNumber).from
    view.focus()
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start' }),
    })
  }, [])

  return (
    <div className="relative flex h-full flex-col bg-[var(--bg)]">
      <div ref={onScrollContainer} className="flex-1 overflow-y-auto">
        <div className="relative mx-auto w-full max-w-[760px] px-12 pt-12 pb-24">
          <div className="pointer-events-none absolute top-3 right-12 text-[12px] text-[var(--text-dim)]">
            <SaveStatusLabel status={status} lastSavedAt={lastSavedAt} />
          </div>
          <input
            value={title}
            onChange={(event) => {
              const next = event.target.value
              setTitle(next)
              pendingTitleRef.current = next
              setStatus('dirty')
              onLiveChangeRef.current?.({ title: next })
            }}
            onBlur={() => void flush()}
            placeholder="无标题文档"
            className="w-full bg-transparent text-[34px] leading-[1.2] font-normal tracking-tight text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
            style={{ fontFamily: 'var(--font-doc-title)' }}
          />
          <div className="mt-6">
            <MarkdownEditor
              value={content}
              onChange={handleContentChange}
              onBlur={() => void flush()}
              onSave={() => void flush()}
              onCreateView={handleCreateView}
              autoFocus
              placeholder="Type markdown — # for headings, * for lists, ``` for code…"
            />
          </div>
        </div>
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
