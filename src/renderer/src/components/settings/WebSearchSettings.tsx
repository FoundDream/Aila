import type { FormEvent, ReactElement } from 'react'
import { useState } from 'react'

interface WebSearchData {
  hasTavilyApiKey: boolean
}

export function WebSearchSettings({
  settings,
  onSave,
}: {
  settings: WebSearchData | null
  onSave: (data: { tavilyApiKey?: string }) => Promise<void>
}): ReactElement {
  const [tavilyApiKey, setTavilyApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const inputClass =
    'w-full rounded border border-[var(--term-border)] bg-[var(--term-surface)] px-2.5 py-1.5 text-[12px] text-[var(--term-text)] placeholder:text-[var(--term-dim)] outline-none transition focus:border-[var(--term-blue)]'

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    setSaved(false)

    if (!settings?.hasTavilyApiKey && !tavilyApiKey.trim()) {
      setError('Tavily API key is required')
      return
    }

    setSaving(true)
    try {
      await onSave({
        tavilyApiKey: tavilyApiKey.trim() || undefined,
      })
      setTavilyApiKey('')
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h3 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--term-dim)]">
        Web Search
      </h3>
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="space-y-3 rounded-xl border border-[var(--term-border)] bg-[var(--term-surface)] p-4"
      >
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-[var(--term-text)]">Tavily</span>
          <span
            className={
              settings?.hasTavilyApiKey ? 'text-[var(--term-cyan)]' : 'text-[var(--term-dim)]'
            }
          >
            {settings?.hasTavilyApiKey ? 'configured' : 'not configured'}
          </span>
        </div>

        <p className="text-[12px] leading-relaxed text-[var(--term-text-soft)]">
          Enables the <code>web_search</code> and <code>web_extract</code> tools.
        </p>

        <div>
          <label className="mb-1 block text-[11px] text-[var(--term-dim)]">Tavily API Key</label>
          <input
            type="password"
            value={tavilyApiKey}
            onChange={(e) => setTavilyApiKey(e.target.value)}
            placeholder={
              settings?.hasTavilyApiKey ? 'leave blank to keep current key' : 'enter key'
            }
            className={inputClass}
          />
        </div>

        {error && <p className="text-[11px] text-[var(--term-red)]">{error}</p>}
        {saved && <p className="text-[11px] text-[var(--term-cyan)]">saved</p>}

        <div className="pt-1">
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-[var(--term-blue)] px-3 py-1.5 text-[11px] font-medium text-white transition hover:bg-[var(--term-blue-strong)] disabled:opacity-50"
          >
            {saving ? 'saving...' : 'save'}
          </button>
        </div>
      </form>
    </section>
  )
}
