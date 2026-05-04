import {
  type ReactElement,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useState,
} from 'react'

interface SidePanelProps {
  open: boolean
  storageKey: string
  defaultWidth: number
  minWidth: number
  maxWidth?: number
  children: ReactNode
}

function readStoredWidth(key: string, fallback: number, min: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < min) return fallback
    return parsed
  } catch {
    return fallback
  }
}

export function SidePanel({
  open,
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  children,
}: SidePanelProps): ReactElement | null {
  const [width, setWidth] = useState(() => readStoredWidth(storageKey, defaultWidth, minWidth))

  // Persist width as it changes. Drag emits many updates; localStorage writes
  // are cheap enough that debouncing isn't worth the complexity.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(Math.round(width)))
    } catch {
      // ignore quota / privacy-mode errors
    }
  }, [storageKey, width])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = width
      const cap = maxWidth ?? Math.max(minWidth, Math.floor(window.innerWidth * 0.8))

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: PointerEvent): void => {
        // Handle is on the panel's left edge; dragging left widens the panel.
        const delta = startX - ev.clientX
        let next = startWidth + delta
        if (next < minWidth) next = minWidth
        if (next > cap) next = cap
        setWidth(next)
      }

      const onUp = (): void => {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [width, minWidth, maxWidth],
  )

  if (!open) return null

  return (
    <div
      className="relative shrink-0 border-l border-[var(--border)] bg-[var(--bg)]"
      style={{ width: `${width}px` }}
    >
      <div
        aria-hidden="true"
        onPointerDown={onPointerDown}
        title="Drag to resize"
        className="group absolute top-0 bottom-0 z-10 w-1 cursor-col-resize"
        style={{ left: '-2px' }}
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-[var(--border-strong)] group-active:bg-[var(--border-strong)]" />
      </div>
      <div className="h-full">{children}</div>
    </div>
  )
}
