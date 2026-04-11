import type { ReactElement } from 'react'

import { Button } from '@/components/Button'

export function SetupRequiredState({
  onSettingsClick,
}: {
  onSettingsClick: () => void
}): ReactElement {
  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-lg">
        <div className="mb-4 flex items-center gap-2">
          <span className="text-[var(--term-yellow)]">!</span>
          <span className="text-sm text-[var(--term-text)]">setup required</span>
        </div>
        <p className="text-[13px] text-[var(--term-text-soft)]">
          Add a provider with a reachable endpoint and at least one model before starting a chat
          session.
        </p>
        <div className="mt-4 rounded border border-[var(--term-border)] bg-[var(--term-surface)] p-4 text-[12px] leading-relaxed text-[var(--term-text-soft)]">
          Open settings, add credentials for a built-in provider or configure a compatible custom
          endpoint, then return here and choose a model.
        </div>
        <div className="mt-4">
          <Button variant="primary" onClick={onSettingsClick}>
            open settings
          </Button>
        </div>
      </div>
    </main>
  )
}
