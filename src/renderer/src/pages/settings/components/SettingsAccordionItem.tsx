import type { ReactElement, ReactNode } from 'react'

export function SettingsAccordionItem({
  expanded,
  header,
  trailing,
  children,
  onToggle,
}: {
  expanded: boolean
  header: ReactNode
  trailing: ReactNode
  children?: ReactNode
  onToggle: () => void
}): ReactElement {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-xl border border-[var(--term-border)] bg-[var(--term-surface)] px-3 py-3 text-left text-xs transition hover:bg-[var(--term-surface-soft)]"
      >
        <div className="min-w-0">{header}</div>
        <div className="shrink-0">{trailing}</div>
      </button>
      {expanded && children ? <div className="mt-2">{children}</div> : null}
    </div>
  )
}
