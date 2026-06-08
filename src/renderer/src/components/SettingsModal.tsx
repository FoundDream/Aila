import { IMAGE_MODEL_CATALOG, MODEL_CATALOG, PROVIDER_LABELS, PROVIDER_ORDER } from '@shared/models'
import {
  BoxIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  SearchIcon,
  ShieldIcon,
  XIcon,
} from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react'
import type { ModelSelection, OrCatalog, ProviderId, Settings } from '../types'
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

type SettingsTab = 'provider' | 'models' | 'tools'
type ApprovalMode = NonNullable<Settings['approvalMode']>

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof KeyRoundIcon }> = [
  { id: 'provider', label: 'Provider', icon: KeyRoundIcon },
  { id: 'models', label: 'Default Models', icon: BoxIcon },
  { id: 'tools', label: 'Tools', icon: ShieldIcon },
]

const APPROVAL_MODES: Array<{ id: ApprovalMode; label: string; description: string }> = [
  { id: 'safe', label: 'Safe', description: 'Ask before write, edit, and shell tools.' },
  { id: 'yolo', label: 'Yolo', description: 'Run tools without approval prompts.' },
]

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${parseFloat((tokens / 1_000_000).toFixed(2))}M`
  return `${Math.round(tokens / 1000)}K`
}

function SectionTitle({ children }: { children: ReactNode }): ReactElement {
  return (
    <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
      {children}
    </h3>
  )
}

export function SettingsModal({ open, onOpenChange, settings, onSave }: Props): ReactElement {
  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<SettingsTab>('provider')
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('anthropic')
  const [revealKey, setRevealKey] = useState(false)
  // Live OpenRouter catalog, fetched lazily the first time that detail page
  // is shown. The static MODEL_CATALOG only carries a couple of curated
  // OpenRouter entries — the real list comes from the API.
  const [orCatalog, setOrCatalog] = useState<OrCatalog | null>(null)
  const [orError, setOrError] = useState<string | null>(null)
  const [orQuery, setOrQuery] = useState('')

  // Reset draft each time we re-open with fresh settings.
  useEffect(() => {
    if (open) {
      setDraft(settings)
      setTab('provider')
      setRevealKey(false)
    }
  }, [open, settings])

  useEffect(() => {
    if (!open || tab !== 'provider' || selectedProvider !== 'openrouter' || orCatalog) return
    let cancelled = false
    setOrError(null)
    void window.api.openrouter
      .listModels()
      .then((catalog) => {
        if (!cancelled) setOrCatalog(catalog)
      })
      .catch((err: unknown) => {
        if (!cancelled) setOrError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, tab, selectedProvider, orCatalog])

  const orFilteredFamilies = useMemo(() => {
    if (!orCatalog) return []
    if (!orQuery.trim()) return orCatalog.families
    const q = orQuery.toLowerCase()
    return orCatalog.families
      .map((f) => ({
        ...f,
        models: f.models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q) ||
            f.label.toLowerCase().includes(q),
        ),
      }))
      .filter((f) => f.models.length > 0)
  }, [orCatalog, orQuery])

  const orModelCount = useMemo(
    () => (orCatalog ? orCatalog.families.reduce((sum, f) => sum + f.models.length, 0) : 0),
    [orCatalog],
  )

  const updateKey = (id: ProviderId, value: string): void => {
    setDraft((prev) => ({ ...prev, apiKeys: { ...prev.apiKeys, [id]: value } }))
  }

  const setDefaultModel = (selection: ModelSelection | null): void => {
    setDraft((prev) => ({ ...prev, defaultModel: selection }))
  }

  const setDefaultImageModel = (selection: ModelSelection | null): void => {
    setDraft((prev) => ({ ...prev, defaultImageModel: selection }))
  }

  const setApprovalMode = (approvalMode: ApprovalMode): void => {
    setDraft((prev) => ({ ...prev, approvalMode }))
  }

  const configuredInDraft = PROVIDER_ORDER.filter((p) => Boolean(draft.apiKeys[p]?.trim()))
  const providerConfigured = configuredInDraft.includes(selectedProvider)
  const providerModels = MODEL_CATALOG.filter((m) => m.providerId === selectedProvider)
  const providerImageModels = IMAGE_MODEL_CATALOG.filter((m) => m.providerId === selectedProvider)

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
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[1000] flex h-[560px] max-h-[88vh] w-[820px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
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

            {tab === 'provider' && (
              <div className="flex min-h-0 flex-1">
                {/* Provider list */}
                <div className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--border)] p-2">
                  {PROVIDER_ORDER.map((id) => {
                    const configured = configuredInDraft.includes(id)
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => {
                          setSelectedProvider(id)
                          setRevealKey(false)
                        }}
                        className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                          selectedProvider === id
                            ? 'bg-[var(--surface-hover)] font-medium text-[var(--text)]'
                            : 'text-[var(--text-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
                        }`}
                      >
                        <ProviderLogo id={id} size={14} />
                        <span className="min-w-0 flex-1 truncate">{PROVIDER_LABELS[id]}</span>
                        <span
                          title={configured ? 'Configured' : 'Not configured'}
                          className={`size-1.5 shrink-0 rounded-full ${
                            configured ? 'bg-emerald-500' : 'bg-[var(--border-strong)]'
                          }`}
                        />
                      </button>
                    )
                  })}
                </div>

                {/* Provider detail */}
                <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
                  <div className="mb-4 flex items-center gap-2.5">
                    <ProviderLogo id={selectedProvider} size={22} />
                    <span className="text-[15px] font-semibold text-[var(--text)]">
                      {PROVIDER_LABELS[selectedProvider]}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                        providerConfigured
                          ? 'bg-emerald-500/10 text-emerald-600'
                          : 'bg-[var(--surface-hover)] text-[var(--text-dim)]'
                      }`}
                    >
                      {providerConfigured ? 'Configured' : 'Not configured'}
                    </span>
                  </div>

                  <section className="mb-5">
                    <SectionTitle>API Key</SectionTitle>
                    <div className="relative">
                      <input
                        type={revealKey ? 'text' : 'password'}
                        value={draft.apiKeys[selectedProvider] ?? ''}
                        onChange={(e) => updateKey(selectedProvider, e.target.value)}
                        placeholder={API_KEY_PLACEHOLDERS[selectedProvider]}
                        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-soft)] py-1.5 pl-2 pr-8 text-[12px] outline-none focus:border-[var(--border-strong)]"
                      />
                      <button
                        type="button"
                        onClick={() => setRevealKey((v) => !v)}
                        aria-label={revealKey ? 'Hide API key' : 'Show API key'}
                        className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-[var(--text-dim)] hover:text-[var(--text)]"
                      >
                        {revealKey ? (
                          <EyeOffIcon className="size-3.5" />
                        ) : (
                          <EyeIcon className="size-3.5" />
                        )}
                      </button>
                    </div>
                    <DialogPrimitive.Description className="mt-1.5 text-[11px] text-[var(--text-dim)]">
                      Stored unencrypted in <code>settings.json</code> in your user data directory.
                      Leave empty to fall back to .env variables.
                    </DialogPrimitive.Description>
                  </section>

                  {selectedProvider === 'openrouter' ? (
                    <section>
                      <div className="mb-1.5 flex items-center gap-2">
                        <h3 className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
                          Models
                        </h3>
                        {orCatalog && (
                          <span className="rounded-full bg-[var(--surface-hover)] px-1.5 py-px text-[10px] tabular-nums text-[var(--text-dim)]">
                            {orModelCount}
                          </span>
                        )}
                        <div className="ml-auto flex w-48 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1">
                          <SearchIcon className="size-3 shrink-0 text-[var(--text-dim)]" />
                          <input
                            type="text"
                            value={orQuery}
                            onChange={(e) => setOrQuery(e.target.value)}
                            placeholder="Filter models..."
                            className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-[var(--text-dim)]"
                          />
                        </div>
                      </div>

                      {orError && (
                        <p className="rounded-md border border-[var(--border)] px-2.5 py-2 text-[12px] text-[var(--error)]">
                          Failed to load OpenRouter models: {orError}
                        </p>
                      )}
                      {!orCatalog && !orError && (
                        <p className="rounded-md border border-[var(--border)] px-2.5 py-2 text-[12px] text-[var(--text-dim)]">
                          Loading models…
                        </p>
                      )}

                      {orCatalog && orFilteredFamilies.length === 0 && (
                        <p className="rounded-md border border-[var(--border)] px-2.5 py-2 text-[12px] text-[var(--text-dim)]">
                          No models match “{orQuery}”.
                        </p>
                      )}

                      {orFilteredFamilies.map((family) => (
                        <div key={family.family} className="mb-3">
                          <h4 className="mb-1 text-[11px] font-medium text-[var(--text-soft)]">
                            {family.label}
                          </h4>
                          <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                            {family.models.map((m) => (
                              <li key={m.id} className="flex items-center gap-2 px-2.5 py-1.5">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="truncate text-[12px] text-[var(--text)]">
                                      {m.name}
                                    </span>
                                    {m.tags.map((tag) => (
                                      <span
                                        key={tag}
                                        className="rounded bg-[var(--surface-hover)] px-1 py-px text-[9.5px] uppercase tracking-wide text-[var(--text-dim)]"
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                  </div>
                                  <div className="truncate font-mono text-[10.5px] text-[var(--text-dim)]">
                                    {m.id}
                                  </div>
                                </div>
                                {m.promptPricePerMTok !== null && (
                                  <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--text-dim)]">
                                    ${m.promptPricePerMTok}/M
                                  </span>
                                )}
                                <span className="w-14 shrink-0 text-right text-[10.5px] tabular-nums text-[var(--text-dim)]">
                                  {formatContext(m.contextLength)} ctx
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </section>
                  ) : (
                    <section>
                      <SectionTitle>Models</SectionTitle>
                      <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                        {providerModels.map((m) => (
                          <li key={m.modelId} className="flex items-center gap-2 px-2.5 py-1.5">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[12px] text-[var(--text)]">
                                  {m.displayName}
                                </span>
                                {m.tags?.map((tag) => (
                                  <span
                                    key={tag}
                                    className="rounded bg-[var(--surface-hover)] px-1 py-px text-[9.5px] uppercase tracking-wide text-[var(--text-dim)]"
                                  >
                                    {tag}
                                  </span>
                                ))}
                              </div>
                              <div className="truncate font-mono text-[10.5px] text-[var(--text-dim)]">
                                {m.modelId}
                              </div>
                            </div>
                            <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--text-dim)]">
                              {formatContext(m.contextLength)} ctx
                            </span>
                          </li>
                        ))}
                        {providerModels.length === 0 && (
                          <li className="px-2.5 py-2 text-[12px] text-[var(--text-dim)]">
                            No chat models on this provider.
                          </li>
                        )}
                      </ul>

                      {providerImageModels.length > 0 && (
                        <>
                          <h4 className="mb-1.5 mt-3 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
                            Image
                          </h4>
                          <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                            {providerImageModels.map((m) => (
                              <li key={m.modelId} className="px-2.5 py-1.5">
                                <div className="truncate text-[12px] text-[var(--text)]">
                                  {m.displayName}
                                </div>
                                <div className="truncate font-mono text-[10.5px] text-[var(--text-dim)]">
                                  {m.modelId}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </section>
                  )}
                </div>
              </div>
            )}

            {tab === 'models' && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {configuredInDraft.length === 0 && (
                  <p className="mb-3 text-[12px] text-amber-600">
                    Add at least one API key in the Provider tab to pick defaults.
                  </p>
                )}

                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <label
                      htmlFor="default-model-select"
                      className="w-24 shrink-0 pt-1.5 text-[12px] text-[var(--text)]"
                    >
                      Chat
                    </label>
                    <div className="min-w-0 flex-1">
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
                      <p className="mt-1 text-[11px] text-[var(--text-dim)]">
                        Used for new conversations.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <label
                      htmlFor="default-image-model-select"
                      className="w-24 shrink-0 pt-1.5 text-[12px] text-[var(--text)]"
                    >
                      Image
                    </label>
                    <div className="min-w-0 flex-1">
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
                      <p className="mt-1 text-[11px] text-[var(--text-dim)]">
                        Used by the <code>generate_image</code> tool when the model decides to draw
                        something.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'tools' && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <section>
                  <SectionTitle>Execution Mode</SectionTitle>
                  <div className="grid gap-2">
                    {APPROVAL_MODES.map((mode) => {
                      const selected = (draft.approvalMode ?? 'safe') === mode.id
                      return (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => setApprovalMode(mode.id)}
                          className={`rounded-md border px-3 py-2 text-left transition-colors ${
                            selected
                              ? 'border-[var(--border-strong)] bg-[var(--surface-hover)]'
                              : 'border-[var(--border)] bg-[var(--bg-soft)] hover:bg-[var(--surface-hover)]'
                          }`}
                        >
                          <span className="block text-[12px] font-medium text-[var(--text)]">
                            {mode.label}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-[var(--text-dim)]">
                            {mode.description}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              </div>
            )}

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
