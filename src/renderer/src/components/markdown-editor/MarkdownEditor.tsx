import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import type { Extension } from '@codemirror/state'
import { drawSelection, EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { GFM } from '@lezer/markdown'
import CodeMirror from '@uiw/react-codemirror'
import { type ReactElement, useMemo, useRef } from 'react'

interface MarkdownEditorProps {
  value: string
  onChange: (next: string) => void
  onBlur?: () => void
  onSave?: () => void
  autoFocus?: boolean
  placeholder?: string
}

// Token-level highlighting. `processingInstruction` covers the visible
// markdown markers (`#`, `**`, list bullets) — fading them gives the
// "source mode but readable" feel we want without hiding them outright.
const highlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.7em', fontWeight: '600', color: 'var(--text)' },
  { tag: t.heading2, fontSize: '1.4em', fontWeight: '600', color: 'var(--text)' },
  { tag: t.heading3, fontSize: '1.2em', fontWeight: '600', color: 'var(--text)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600', color: 'var(--text)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-dim)' },
  { tag: t.processingInstruction, color: 'var(--text-dim)' },
  {
    tag: t.monospace,
    fontFamily: 'var(--font-mono)',
    fontSize: '0.92em',
    backgroundColor: 'var(--surface-hover)',
    padding: '0.05em 0.35em',
    borderRadius: '3px',
  },
  { tag: t.link, color: '#1e6fd9' },
  { tag: t.url, color: 'var(--text-dim)' },
  { tag: t.contentSeparator, color: 'var(--text-dim)' },
  { tag: t.list, color: 'var(--text-dim)' },
  { tag: t.quote, color: 'var(--text-soft)', fontStyle: 'italic' },
  { tag: t.meta, color: 'var(--text-dim)' },
])

const editorTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'transparent',
    fontFamily: 'var(--font-serif)',
    fontSize: '15.5px',
    lineHeight: '1.75',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    caretColor: 'var(--text)',
    padding: '0',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(30, 111, 217, 0.18) !important',
  },
  '.cm-scroller': { fontFamily: 'inherit' },
  '.cm-gutters': { display: 'none' },
  '.cm-panels': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    borderTop: '1px solid var(--border)',
  },
  '.cm-panel.cm-search': { padding: '6px 10px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    padding: '2px 6px',
  },
})

async function uploadFiles(view: EditorView, files: File[]): Promise<void> {
  // Sequential await: cursor head shifts after each insert, so dispatching
  // serially keeps the position math trivial.
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer()
      const { url } = await window.api.images.save(buf, file.name)
      const insert = `![](${url})`
      const head = view.state.selection.main.head
      view.dispatch({
        changes: { from: head, insert },
        selection: { anchor: head + insert.length },
      })
    } catch (err) {
      console.error('[markdown-editor] image upload failed', err)
    }
  }
}

const imageDomHandlers: Extension = EditorView.domEventHandlers({
  paste(event, view) {
    const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    )
    if (files.length === 0) return false
    event.preventDefault()
    void uploadFiles(view, files)
    return true
  },
  drop(event, view) {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    )
    if (files.length === 0) return false
    event.preventDefault()
    void uploadFiles(view, files)
    return true
  },
})

const baseExtensions: Extension[] = [
  history(),
  drawSelection(),
  EditorView.lineWrapping,
  markdown({
    codeLanguages: languages,
    addKeymap: true,
    extensions: GFM,
  }),
  syntaxHighlighting(highlightStyle),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
  editorTheme,
  imageDomHandlers,
]

export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  onSave,
  autoFocus,
  placeholder,
}: MarkdownEditorProps): ReactElement {
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  // The Cmd+S keymap is component-scoped because it reads from the latest
  // onSave via a ref. Combining it with the stable baseExtensions keeps the
  // overall extensions array referentially stable per-component.
  const extensions = useMemo<Extension[]>(
    () => [
      ...baseExtensions,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current?.()
            return true
          },
        },
      ]),
    ],
    [],
  )

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      autoFocus={autoFocus}
      basicSetup={false}
      placeholder={placeholder}
      extensions={extensions}
      theme="none"
    />
  )
}
