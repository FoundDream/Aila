import { WIDGET_FRAME_URL } from '@shared/widget/receiver'
import { sanitizeForIframe, sanitizeForStreaming } from '@shared/widget/sanitizer'
import { resolveThemeVars } from '@shared/widget/theme'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WidgetErrorBoundary } from './WidgetErrorBoundary'

interface WidgetRendererProps {
  widgetCode: string
  isStreaming: boolean
  title?: string
  /** Extra buttons rendered alongside the "show code" button (top-right). */
  extraButtons?: ReactNode
}

/** Max iframe height to prevent runaway widgets. */
const MAX_IFRAME_HEIGHT = 2000

/** Debounce delay for streaming updates (ms). */
const STREAM_DEBOUNCE = 120

/** CDN hosts that indicate a complex widget needing load time. */
const CDN_PATTERN = /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|esm\.sh/

/**
 * Height cache preserved across remounts (streaming → persisted swap remounts
 * the renderer). Keyed by the first 200 chars of widgetCode (stable across the
 * transition). Without this the iframe height resets to 0 → scroll jump.
 */
const heightCache = new Map<string, number>()
const cacheKey = (code: string): string => code.slice(0, 200)

function WidgetRendererInner({
  widgetCode,
  isStreaming,
  title,
  extraButtons,
}: WidgetRendererProps): ReactNode {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSentRef = useRef<string>('')
  const [iframeReady, setIframeReady] = useState(false)
  const [iframeHeight, setIframeHeight] = useState(() => heightCache.get(cacheKey(widgetCode)) || 0)
  const [finalized, setFinalized] = useState(false)
  const hasReceivedFirstHeight = useRef((heightCache.get(cacheKey(widgetCode)) || 0) > 0)
  const heightLockedRef = useRef(false)

  const hasCDN = useMemo(() => CDN_PATTERN.test(widgetCode), [widgetCode])

  const postTheme = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'widget:theme', vars: resolveThemeVars() },
      '*',
    )
  }, [])

  // ── postMessage handler ────────────────────────────────────────────────
  useEffect(() => {
    function handleMessage(e: MessageEvent): void {
      if (!e.data || typeof e.data.type !== 'string') return
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return

      switch (e.data.type) {
        case 'widget:ready':
          setIframeReady(true)
          postTheme()
          break

        case 'widget:resize': {
          if (typeof e.data.height !== 'number' || e.data.height <= 0) break
          const newH = Math.min(e.data.height, MAX_IFRAME_HEIGHT)
          const key = cacheKey(widgetCode)
          if (heightLockedRef.current) {
            setIframeHeight((prev) => {
              const h = Math.max(prev, newH)
              heightCache.set(key, h)
              return h
            })
            break
          }
          heightCache.set(key, newH)
          if (!hasReceivedFirstHeight.current) {
            hasReceivedFirstHeight.current = true
            const el = iframeRef.current
            if (el) {
              el.style.transition = 'none'
              void el.offsetHeight
            }
            setIframeHeight(newH)
            requestAnimationFrame(() => {
              if (el) el.style.transition = 'height 0.3s ease-out'
            })
          } else {
            setIframeHeight(newH)
          }
          break
        }

        case 'widget:link': {
          const href = String(e.data.href || '')
          if (href && !/^\s*(javascript|data)\s*:/i.test(href)) {
            window.open(href, '_blank', 'noopener,noreferrer')
          }
          break
        }
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [widgetCode, postTheme])

  // ── Streaming updates ──────────────────────────────────────────────────
  const sendUpdate = useCallback((html: string) => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    if (html === lastSentRef.current) return
    lastSentRef.current = html
    iframe.contentWindow.postMessage({ type: 'widget:update', html }, '*')
  }, [])

  useEffect(() => {
    if (!isStreaming || !iframeReady) return
    const sanitized = sanitizeForStreaming(widgetCode)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => sendUpdate(sanitized), STREAM_DEBOUNCE)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [widgetCode, isStreaming, iframeReady, sendUpdate])

  // ── Finalize ───────────────────────────────────────────────────────────
  const finalizedCodeRef = useRef('')
  useEffect(() => {
    if (isStreaming || !iframeReady) return
    if (finalizedCodeRef.current === widgetCode) return
    const sanitized = sanitizeForIframe(widgetCode)
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    finalizedCodeRef.current = widgetCode
    lastSentRef.current = sanitized
    heightLockedRef.current = true
    iframe.contentWindow.postMessage({ type: 'widget:finalize', html: sanitized }, '*')
    const timer = setTimeout(() => {
      heightLockedRef.current = false
      setFinalized(true)
    }, 400)
    return () => clearTimeout(timer)
  }, [isStreaming, iframeReady, widgetCode])

  const showLoadingOverlay = hasCDN && !isStreaming && iframeReady && !finalized

  return (
    // No card chrome — the widget sits directly in the conversation flow. The
    // iframe body is transparent; the model's own .w-card/.w-node surfaces
    // supply any structure.
    <div className="group/widget relative my-2">
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        src={WIDGET_FRAME_URL}
        title={title || 'Widget'}
        onLoad={() => {
          // Fallback if the widget:ready postMessage races our listener setup.
          setIframeReady(true)
          postTheme()
        }}
        style={{
          width: '100%',
          height: iframeHeight,
          border: 'none',
          display: 'block',
          overflow: 'hidden',
          colorScheme: 'light',
        }}
      />

      {showLoadingOverlay && (
        <div
          className="pointer-events-none absolute inset-0 rounded-lg"
          style={{
            background:
              'linear-gradient(90deg, transparent 0%, rgba(128,128,128,0.08) 50%, transparent 100%)',
            backgroundSize: '200% 100%',
            animation: 'widget-shimmer 1.5s ease-in-out infinite',
          }}
        />
      )}

      {extraButtons && (
        <div className="absolute top-2 right-2 flex items-center gap-1">{extraButtons}</div>
      )}
    </div>
  )
}

export function WidgetRenderer(props: WidgetRendererProps): ReactNode {
  return (
    <WidgetErrorBoundary>
      <WidgetRendererInner {...props} />
    </WidgetErrorBoundary>
  )
}
