import type { ReactElement } from 'react'

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
          Add an AI provider in settings before starting a chat session.
        </p>
        <div className="mt-4 rounded border border-[var(--term-border)] bg-[var(--term-surface)] p-4 text-[12px] leading-relaxed text-[var(--term-text-soft)]">
          Open settings, add an API key for a built-in provider or create a custom provider, then
          pick a model.
        </div>
        <div className="mt-4">
          <button
            type="button"
            onClick={onSettingsClick}
            className="rounded bg-[var(--term-blue)] px-3 py-1.5 text-[11px] font-medium text-white transition hover:bg-[var(--term-blue-strong)]"
          >
            open settings
          </button>
        </div>
      </div>
    </main>
  )
}
