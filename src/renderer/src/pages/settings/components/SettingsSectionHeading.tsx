import type { ReactElement } from 'react'

export function SettingsSectionHeading({ children }: { children: string }): ReactElement {
  return (
    <h3 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--term-dim)]">{children}</h3>
  )
}
