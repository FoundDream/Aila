import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * Catches render errors thrown by a widget so a single bad widget can't take
 * down the whole transcript. Ported from CodePilot's WidgetErrorBoundary,
 * minus the i18n dependency (Aila has no translation hook yet).
 */
export class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error): void {
    console.warn('[WidgetErrorBoundary]', error)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div className="my-2 rounded-lg border border-[var(--error)] bg-[var(--error)]/10 p-3 text-sm">
          <p className="font-medium text-[var(--error)]">
            无法渲染该组件 / Failed to render widget
          </p>
          {this.state.error && (
            <p className="mt-1 text-xs text-[var(--text-dim)]">{this.state.error.message}</p>
          )}
        </div>
      )
    }
    return this.props.children
  }
}
