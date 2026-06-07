import { IMAGE_MODEL_CATALOG, MODEL_CATALOG, PROVIDER_LABELS, PROVIDER_ORDER } from '@shared/models'
import { BoxIcon, KeyRoundIcon, XIcon } from 'lucide-react'
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

const API_KEY_PLACEHOLDERS: Record<ProviderId, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  google: 'AIza...',
  openrouter: 'sk-or-...',
}

type SettingsTab = 'provider' | 'models'

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof KeyRoundIcon }> = [
  { id: 'provider', label: 'Provider', icon: KeyRoundIcon },
  { id: 'models', label: 'Models', icon: BoxIcon },
]

export function SettingsModal({ open, onOpenChange, settings, onSave }: Props): ReactElement {
  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<SettingsTab>('provider')

  // Reset draft each time we re-open with fresh settings.
  useEffect(() => {
    if (open) {
      setDraft(settings)
      setTab('provider')
    }
  }, [open, settings])

  const updateKey = (id: ProviderId, value: string): void => {
    setDraft((prev) => ({ ...prev, apiKeys: { ...prev.apiKeys, [id]: value } }))
  }

  const setDefaultModel = (selection: ModelSelection | null): void => {
    setDraft((prev) => ({ ...prev, defaultModel: selection }))
  }

  const setDefaultImageModel = (selection: ModelSelection | null): void => {
    setDraft((prev) => ({ ...prev, defaultImageModel: selection }))
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
      if (
        next.defaultImageModel &&
        !configuredInDraft.includes(next.defaultImageModel.providerId)
      ) {
        next = { ...next, defaultImageModel: null }
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
        <DialogPrimitive.Overlay className="fixed inset-0 z-[900] bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[1000] flex h-[460px] w-[680px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          {/* Left tab rail */}
          <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-[var(--border)] bg-[var(--bg-soft)] p-3">
            <DialogPrimitive.Title className="mb-2 px-2 pt-1 text-[13px] font-semibold text-[var(--text)]">
              Settings
            </DialogPrimitive.Title>
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                  tab === id
                    ? 'bg-[var(--surface-hover)] font-medium text-[var(--text)]'
                    : 'text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
                }`}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </nav>

          {/* Right page */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
              <h2 className="text-[13px] font-semibold text-[var(--text)]">
                {TABS.find((t) => t.id === tab)?.label}
              </h2>
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

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {tab === 'provider' && (
                <>
                  <DialogPrimitive.Description className="mb-4 text-[12px] text-[var(--text-dim)]">
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
                          placeholder={API_KEY_PLACEHOLDERS[id]}
                          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--border-strong)]"
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}

              {tab === 'models' && (
                <>
                  <div>
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
                        Add at least one API key in the Provider tab to pick a default model.
                      </p>
                    )}
                  </div>

                  <div className="mt-4">
                    <label
                      htmlFor="default-image-model-select"
                      className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]"
                    >
                      Default Image Model
                    </label>
                    <select
                      id="default-image-model-select"
                      value={
                        draft.defaultImageModel
                          ? `${draft.defaultImageModel.providerId}:${draft.defaultImageModel.modelId}`
                          : ''
                      }
                      onChange={(e) => {
                        const v = e.target.value
                        if (!v) return setDefaultImageModel(null)
                        const [providerId, ...rest] = v.split(':')
                        setDefaultImageModel({
                          providerId: providerId as ProviderId,
                          modelId: rest.join(':'),
                        })
                      }}
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--border-strong)]"
                    >
                      <option value="">(none — disable image generation)</option>
                      {IMAGE_MODEL_CATALOG.filter((m) =>
                        configuredInDraft.includes(m.providerId),
                      ).map((m) => (
                        <option
                          key={`${m.providerId}:${m.modelId}`}
                          value={`${m.providerId}:${m.modelId}`}
                        >
                          {PROVIDER_LABELS[m.providerId]} · {m.displayName}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1.5 text-[11px] text-[var(--text-dim)]">
                      Used by the <code>generate_image</code> tool when the model decides to draw
                      something.
                    </p>
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
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
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
