import { WIDGET_FENCE_LANG } from '@shared/widget/wire-format'
import { CheckIcon, CopyIcon, DownloadIcon, Maximize2Icon, XIcon } from 'lucide-react'
import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  type Components,
  type ExtraProps,
  extractTableDataFromElement,
  StreamdownContext,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV,
} from 'streamdown'
import { WidgetFence } from '@/components/widget/WidgetFence'
import { cn } from '@/lib/utils'

type MarkdownTableProps = ComponentProps<'table'> & ExtraProps
type CopyFormat = 'md' | 'csv' | 'tsv'
type DownloadFormat = 'csv' | 'markdown'

const copyFormats: Array<{ format: CopyFormat; label: string }> = [
  { format: 'md', label: 'Markdown' },
  { format: 'csv', label: 'CSV' },
  { format: 'tsv', label: 'TSV' },
]

const downloadFormats: Array<{ format: DownloadFormat; label: string }> = [
  { format: 'csv', label: 'CSV' },
  { format: 'markdown', label: 'Markdown' },
]

export const markdownComponents = {
  table: MarkdownTable,
  pre: MarkdownPre,
} satisfies Components

// ── Widget fence interception ───────────────────────────────────────────────
// A fenced code block ```show-widget``` is rendered as a live widget instead of
// a code block. We hook at `pre` (not `code`) so every other fence falls
// through to streamdown's default code rendering untouched.

interface HastNode {
  type?: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

type MarkdownPreProps = ComponentProps<'pre'> & ExtraProps

function MarkdownPre({ children, node }: MarkdownPreProps): ReactNode {
  // `mode` (driven by message.status) is the reliable "still streaming" signal.
  // `isAnimating` only tracks the text fade and flips false mid-stream, which
  // would make a half-streamed fence look malformed instead of in-progress.
  const { mode } = useContext(StreamdownContext)
  const fence = extractFence(node as HastNode | undefined)

  if (fence && fence.lang === WIDGET_FENCE_LANG) {
    return <WidgetFence body={fence.code} isStreaming={mode === 'streaming'} />
  }

  // Default streamdown <pre> behavior: pass the rendered code block through.
  return isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, { 'data-block': 'true' })
    : (children as ReactNode)
}

/** Pull the language tag + raw text out of a fenced-code HAST `<pre>` node. */
function extractFence(node: HastNode | undefined): { lang: string; code: string } | null {
  const codeEl = node?.children?.find((c) => c.type === 'element' && c.tagName === 'code')
  if (!codeEl) return null
  const raw = codeEl.properties?.className
  const classes = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const langClass = classes.find(
    (c): c is string => typeof c === 'string' && c.startsWith('language-'),
  )
  return {
    lang: langClass ? langClass.slice('language-'.length) : '',
    code: collectText(codeEl),
  }
}

function collectText(el: HastNode): string {
  if (el.type === 'text') return el.value ?? ''
  return (el.children ?? []).map(collectText).join('')
}

function MarkdownTable({
  children,
  className,
  node: _node,
  ...props
}: MarkdownTableProps): ReactElement {
  const tableRef = useRef<HTMLTableElement | null>(null)
  const fullscreenTableRef = useRef<HTMLTableElement | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const { controls, isAnimating } = useContext(StreamdownContext)
  const showCopy = tableControlEnabled(controls, 'copy')
  const showDownload = tableControlEnabled(controls, 'download')
  const showFullscreen = tableControlEnabled(controls, 'fullscreen')
  const showActions = showCopy || showDownload || showFullscreen

  const closeFullscreen = useCallback(() => setFullscreen(false), [])

  useEffect(() => {
    if (!fullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeFullscreen()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [fullscreen, closeFullscreen])

  return (
    <>
      <div className="group/table relative my-3" data-streamdown="table-wrapper">
        {showActions && (
          <div className="absolute top-1 right-1 z-10 flex items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--surface)] p-0.5 opacity-0 shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-opacity group-hover/table:opacity-100 focus-within:opacity-100">
            {showCopy && <TableCopyDropdown disabled={isAnimating} tableRef={tableRef} />}
            {showDownload && <TableDownloadDropdown disabled={isAnimating} tableRef={tableRef} />}
            {showFullscreen && (
              <IconButton
                ariaLabel="View fullscreen"
                disabled={isAnimating}
                onClick={() => setFullscreen(true)}
                title="View fullscreen"
              >
                <Maximize2Icon className="size-3.5" />
              </IconButton>
            )}
          </div>
        )}
        <div className="overflow-auto border-y border-[var(--border)]">
          <table
            {...props}
            className={cn('w-full', className)}
            data-streamdown="table"
            ref={tableRef}
          >
            {children}
          </table>
        </div>
      </div>
      {fullscreen &&
        createPortal(
          <div
            aria-label="View fullscreen"
            aria-modal="true"
            className="fixed inset-0 z-[1000] flex flex-col bg-[var(--bg)]"
            data-streamdown="table-fullscreen"
            role="dialog"
          >
            <div className="flex shrink-0 items-center justify-end gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
              {showCopy && (
                <TableCopyDropdown disabled={isAnimating} tableRef={fullscreenTableRef} />
              )}
              {showDownload && (
                <TableDownloadDropdown disabled={isAnimating} tableRef={fullscreenTableRef} />
              )}
              <IconButton
                ariaLabel="Exit fullscreen"
                onClick={closeFullscreen}
                title="Exit fullscreen"
              >
                <XIcon className="size-5" />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4 pt-3">
              <table
                {...props}
                className={cn(
                  'w-full border-collapse border-y border-[var(--border)] bg-[var(--surface)]',
                  className,
                )}
                data-streamdown="table"
                ref={fullscreenTableRef}
              >
                {children}
              </table>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

function tableControlEnabled(
  controls:
    | boolean
    | { table?: boolean | { copy?: boolean; download?: boolean; fullscreen?: boolean } },
  key: 'copy' | 'download' | 'fullscreen',
): boolean {
  if (typeof controls === 'boolean') return controls
  const tableControls = controls.table
  if (tableControls === false) return false
  if (tableControls === true || tableControls === undefined) return true
  return tableControls[key] !== false
}

function TableCopyDropdown({
  disabled,
  tableRef,
}: {
  disabled: boolean
  tableRef: RefObject<HTMLTableElement | null>
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const menuRef = useOutsideMenu(() => setOpen(false))

  const copy = useCallback(
    async (format: CopyFormat): Promise<void> => {
      const table = tableRef.current
      if (!table) return
      try {
        await copyTable(table, format)
        setCopied(true)
        setOpen(false)
        window.setTimeout(() => setCopied(false), 2000)
      } catch {
        setOpen(false)
      }
    },
    [tableRef],
  )

  return (
    <div className="relative" ref={menuRef}>
      <IconButton
        ariaLabel="Copy table"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title="Copy table"
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </IconButton>
      {open && (
        <ActionMenu>
          {copyFormats.map(({ format, label }) => (
            <MenuItem key={format} onClick={() => void copy(format)} title={`Copy as ${label}`}>
              {label}
            </MenuItem>
          ))}
        </ActionMenu>
      )}
    </div>
  )
}

function TableDownloadDropdown({
  disabled,
  tableRef,
}: {
  disabled: boolean
  tableRef: RefObject<HTMLTableElement | null>
}): ReactElement {
  const [open, setOpen] = useState(false)
  const menuRef = useOutsideMenu(() => setOpen(false))

  const download = useCallback(
    (format: DownloadFormat): void => {
      const table = tableRef.current
      if (!table) return
      downloadTable(table, format)
      setOpen(false)
    },
    [tableRef],
  )

  return (
    <div className="relative" ref={menuRef}>
      <IconButton
        ariaLabel="Download table"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title="Download table"
      >
        <DownloadIcon className="size-3.5" />
      </IconButton>
      {open && (
        <ActionMenu>
          {downloadFormats.map(({ format, label }) => (
            <MenuItem key={format} onClick={() => download(format)} title={`Download as ${label}`}>
              {label}
            </MenuItem>
          ))}
        </ActionMenu>
      )}
    </div>
  )
}

function IconButton({
  ariaLabel,
  children,
  disabled = false,
  onClick,
  title,
}: {
  ariaLabel: string
  children: ReactNode
  disabled?: boolean
  onClick: () => void
  title: string
}): ReactElement {
  return (
    <button
      aria-label={ariaLabel}
      className="flex size-6 items-center justify-center rounded-[5px] p-1 text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  )
}

function ActionMenu({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="absolute top-full right-0 z-[1001] mt-1 min-w-[132px] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
      {children}
    </div>
  )
}

function MenuItem({
  children,
  onClick,
  title,
}: {
  children: ReactNode
  onClick: () => void
  title: string
}): ReactElement {
  return (
    <button
      className="w-full px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)]"
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  )
}

function useOutsideMenu(onOutside: () => void): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && ref.current && !ref.current.contains(target)) onOutside()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onOutside])

  return ref
}

async function copyTable(table: HTMLTableElement, format: CopyFormat): Promise<void> {
  const text = serializeTable(table, format)
  const clipboard = navigator.clipboard

  if (!clipboard) throw new Error('Clipboard API not available')

  if (typeof ClipboardItem !== 'undefined' && clipboard.write) {
    await clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([table.outerHTML], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ])
    return
  }

  await clipboard.writeText(text)
}

function downloadTable(table: HTMLTableElement, format: DownloadFormat): void {
  const isCsv = format === 'csv'
  const text = serializeTable(table, isCsv ? 'csv' : 'md')
  const extension = isCsv ? 'csv' : 'md'
  const mimeType = isCsv ? 'text/csv' : 'text/markdown'
  const blob = new Blob([isCsv ? `\uFEFF${text}` : text], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = `table.${extension}`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function serializeTable(table: HTMLTableElement, format: CopyFormat): string {
  const tableData = extractTableDataFromElement(table)
  if (format === 'csv') return tableDataToCSV(tableData)
  if (format === 'tsv') return tableDataToTSV(tableData)
  return tableDataToMarkdown(tableData)
}
