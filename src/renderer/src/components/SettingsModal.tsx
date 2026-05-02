import { MODEL_CATALOG, PROVIDER_LABELS, PROVIDER_ORDER } from '@shared/models'
import { XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { type ReactElement, useEffect, useState } from 'react'
import type { ModelSelection, ProviderId, Settings } from '../types'
import { ProviderLogo } from './ProviderLogo'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: Settings
  onSave: (settings: Settings) => Promise<void> | void
}

export function SettingsModal({ open, onOpenChange, settings, onSave }: Props): ReactElement {
  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)

  // Reset draft each time we re-open with fresh settings.
  useEffect(() => {
    if (open) setDraft(settings)
  }, [open, settings])

  const updateKey = (id: ProviderId, value: string): void => {
    setDraft((prev) => ({ ...prev, apiKeys: { ...prev.apiKeys, [id]: value } }))
  }

  const setDefaultModel = (selection: ModelSelection | null): void => {
    setDraft((prev) => ({ ...prev, defaultModel: selection }))
  }

  const configuredInDraft = PROVIDER_ORDER.filter((p) => Boolean(draft.apiKeys[p]?.trim()))

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      // Auto-fix defaultModel if it points to a now-unconfigured provider.
      let next = draft
      if (next.defaultModel && !configuredInDraft.includes(next.defaultModel.providerId)) {
        const first = configuredInDraft[0]
        if (first) {
          const firstModel = MODEL_CATALOG.find((m) => m.providerId === first)
          next = {
            ...next,
            defaultModel: firstModel ? { providerId: first, modelId: firstModel.modelId } : null,
          }
        } else {
          next = { ...next, defaultModel: null }
        }
      }
      await onSave(next)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <div className="mb-4 flex items-center justify-between">
            <DialogPrimitive.Title className="text-[15px] font-semibold text-[var(--text)]">
              Settings
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="grid size-6 place-items-center rounded-md text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              >
                <XIcon className="size-4" />
              </button>
            </DialogPrimitive.Close>
          </div>

          <DialogPrimitive.Description className="mb-3 text-[12px] text-[var(--text-dim)]">
            API keys are stored unencrypted in <code>settings.json</code> in your user data
            directory. Empty fields fall back to .env variables.
          </DialogPrimitive.Description>

          <div className="space-y-3">
            {PROVIDER_ORDER.map((id) => (
              <div key={id} className="flex items-center gap-3">
                <div className="flex w-28 shrink-0 items-center gap-1.5 text-[12px] text-[var(--text)]">
                  <ProviderLogo id={id} size={14} />
                  {PROVIDER_LABELS[id]}
                </div>
                <input
                  type="password"
                  value={draft.apiKeys[id] ?? ''}
                  onChange={(e) => updateKey(id, e.target.value)}
                  placeholder={
                    id === 'anthropic'
                      ? 'sk-ant-...'
                      : id === 'openai'
                        ? 'sk-...'
                        : id === 'google'
                          ? 'AIza...'
                          : 'sk-or-...'
                  }
                  className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--border-strong)]"
                />
              </div>
            ))}
          </div>

          <div className="mt-5 border-t border-[var(--border)] pt-4">
            <label
              htmlFor="default-model-select"
              className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]"
            >
              Default Model
            </label>
            <select
              id="default-model-select"
              value={
                draft.defaultModel
                  ? `${draft.defaultModel.providerId}:${draft.defaultModel.modelId}`
                  : ''
              }
              onChange={(e) => {
                const v = e.target.value
                if (!v) return setDefaultModel(null)
                const [providerId, ...rest] = v.split(':')
                setDefaultModel({
                  providerId: providerId as ProviderId,
                  modelId: rest.join(':'),
                })
              }}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--border-strong)]"
            >
              <option value="">(none)</option>
              {PROVIDER_ORDER.filter((p) => configuredInDraft.includes(p)).flatMap((p) =>
                MODEL_CATALOG.filter((m) => m.providerId === p).map((m) => (
                  <option key={`${p}:${m.modelId}`} value={`${p}:${m.modelId}`}>
                    {PROVIDER_LABELS[p]} · {m.displayName}
                  </option>
                )),
              )}
            </select>
            {configuredInDraft.length === 0 && (
              <p className="mt-1.5 text-[11px] text-amber-600">
                Add at least one API key above to pick a default model.
              </p>
            )}
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px] hover:bg-[var(--surface-hover)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="rounded-md bg-[var(--brand-ink)] px-3 py-1.5 text-[12px] text-[var(--brand-ink-fg)] transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
