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
          <span className="text-[#e5c07b]">!</span>
          <span className="text-sm text-[#ccc]">setup required</span>
        </div>
        <p className="text-[13px] text-[#999]">
          Add an AI provider in settings before starting a chat session.
        </p>
        <div className="mt-4 rounded border border-[#2a2a2a] bg-[#161616] p-4 text-[12px] leading-relaxed text-[#999]">
          Open settings, add an API key for a built-in provider or create a custom provider, then
          pick a model.
        </div>
        <div className="mt-4">
          <button
            type="button"
            onClick={onSettingsClick}
            className="rounded bg-[#4af626] px-3 py-1.5 text-[11px] font-medium text-black transition hover:bg-[#3dd51e]"
          >
            open settings
          </button>
        </div>
      </div>
    </main>
  )
}
