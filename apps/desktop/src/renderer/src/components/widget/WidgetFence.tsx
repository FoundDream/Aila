import { parseShowWidget } from '@shared/widget/wire-format'
import { type ReactNode, useMemo } from 'react'
import { WidgetRenderer } from './WidgetRenderer'

interface WidgetFenceProps {
  /** Raw text inside the ```show-widget fence (a JSON object, possibly partial). */
  body: string
  isStreaming: boolean
}

/**
 * Bridges a `show-widget` fence to the renderer: parses the JSON wrapper
 * (tolerating partial streaming input) and renders the widget, a loading
 * placeholder, or a visible "malformed" notice — never silently dropping it.
 */
export function WidgetFence({ body, isStreaming }: WidgetFenceProps): ReactNode {
  const parsed = useMemo(() => parseShowWidget(body, isStreaming), [body, isStreaming])

  if (parsed.ok) {
    return (
      <WidgetRenderer
        widgetCode={parsed.widget.widgetCode}
        title={parsed.widget.title}
        isStreaming={isStreaming}
      />
    )
  }

  if (parsed.partial) {
    return (
      <div className="my-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--text-dim)]">
        正在生成可视化组件…
      </div>
    )
  }

  return (
    <div className="my-2 rounded-lg border border-[var(--error)] bg-[var(--error)]/10 p-3 text-sm">
      <p className="font-medium text-[var(--error)]">组件格式有误 / Malformed widget</p>
      <p className="mt-1 text-xs text-[var(--text-dim)]">{parsed.error}</p>
      <pre className="mt-2 max-h-40 overflow-auto rounded bg-[var(--bg-soft)] p-2 text-xs text-[var(--text-soft)]">
        <code>{parsed.body}</code>
      </pre>
    </div>
  )
}
