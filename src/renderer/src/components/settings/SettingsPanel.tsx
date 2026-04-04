import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'

import { MemorySettings } from './MemorySettings'
import { ProviderForm } from './ProviderForm'
import { WebSearchSettings } from './WebSearchSettings'

interface ProviderData {
  id: string
  displayName: string
  api: string
  provider: string
  baseUrl: string
  hasApiKey: boolean
  protocol?: string
  models: {
    id: string
    name: string
    toolUse: boolean
    reasoning: boolean
    contextWindow: number
    maxTokens: number
  }[]
  isBuiltIn: boolean
}

interface WebSearchData {
  hasTavilyApiKey: boolean
}

type SettingsSection = 'model' | 'memory' | 'websearch'

export function SettingsPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): ReactElement | null {
  const [providers, setProviders] = useState<ProviderData[]>([])
  const [webSearch, setWebSearch] = useState<WebSearchData | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [addingCustom, setAddingCustom] = useState(false)
  const [activeSection, setActiveSection] = useState<SettingsSection>('model')

  const loadProviders = useCallback(async () => {
    const data = (await window.api.getProviders()) as ProviderData[]
    setProviders(data)
  }, [])

  const loadWebSearch = useCallback(async () => {
    const data = await window.api.getWebSearchConfig()
    setWebSearch(data)
  }, [])

  useEffect(() => {
    if (open) {
      void loadProviders()
      void loadWebSearch()
    }
  }, [open, loadProviders, loadWebSearch])

  useEffect(() => {
    const unsub = window.api.onConfigChanged(() => {
      void loadProviders()
    })
    return unsub
  }, [loadProviders])

  if (!open) return null

  const configured = providers.filter((provider) => provider.hasApiKey)
  const unconfigured = providers.filter((provider) => !provider.hasApiKey && provider.isBuiltIn)

  const renderModelSection = (): ReactElement => (
    <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]">
      <div className="min-w-0">
        {configured.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-[11px] uppercase tracking-wider text-[#555]">Configured</h3>
            <div className="space-y-1.5">
              {configured.map((provider) => (
                <div key={provider.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expandedId === provider.id ? null : provider.id)}
                    className="flex w-full items-center justify-between rounded-xl border border-[#262626] bg-[#151515] px-3 py-3 text-left text-xs transition hover:bg-[#1b1b1b]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#4af626]" />
                      <span className="text-[#ccc]">{provider.displayName}</span>
                      <span className="text-[#555]">{provider.models.length} models</span>
                    </div>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className={`text-[#555] transition ${expandedId === provider.id ? 'rotate-180' : ''}`}
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  {expandedId === provider.id && (
                    <div className="mt-2">
                      <ProviderForm
                        provider={provider}
                        onSave={async (updated) => {
                          await window.api.saveProvider(updated)
                          void loadProviders()
                        }}
                        onDelete={
                          provider.isBuiltIn
                            ? undefined
                            : async () => {
                                await window.api.deleteProvider(provider.id)
                                setExpandedId(null)
                                void loadProviders()
                              }
                        }
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {unconfigured.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-[11px] uppercase tracking-wider text-[#555]">
              {configured.length === 0 ? 'Add an API key to get started' : 'Available'}
            </h3>
            <div className="space-y-1.5">
              {unconfigured.map((provider) => (
                <div key={provider.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expandedId === provider.id ? null : provider.id)}
                    className="flex w-full items-center justify-between rounded-xl border border-[#232323] bg-[#121212] px-3 py-3 text-left text-xs transition hover:bg-[#171717]"
                  >
                    <span className="text-[#888]">{provider.displayName}</span>
                    <span className="text-[#555]">+ add key</span>
                  </button>
                  {expandedId === provider.id && (
                    <div className="mt-2">
                      <ProviderForm
                        provider={provider}
                        onSave={async (updated) => {
                          await window.api.saveProvider(updated)
                          void loadProviders()
                        }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          {!addingCustom ? (
            <button
              type="button"
              onClick={() => setAddingCustom(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#272727] bg-[#151515] px-3 py-3 text-xs text-[#666] transition hover:bg-[#1c1c1c] hover:text-[#999]"
            >
              + custom provider
            </button>
          ) : (
            <div className="rounded-2xl border border-[#282828] bg-[#151515] p-3">
              <ProviderForm
                provider={null}
                onSave={async (provider) => {
                  await window.api.saveProvider(provider)
                  setAddingCustom(false)
                  void loadProviders()
                }}
                onCancel={() => setAddingCustom(false)}
              />
            </div>
          )}
        </section>
      </div>

      <aside className="rounded-2xl border border-[#242424] bg-[linear-gradient(180deg,#111111_0%,#121822_100%)] p-5">
        <div className="text-[11px] uppercase tracking-[0.22em] text-[#6c86a7]">Model</div>
        <div className="mt-3 text-lg text-[#e5e7eb]">Provider and model setup</div>
        <p className="mt-3 text-xs leading-6 text-[#7f8b97]">
          Configure API keys, manage providers, and control which models are available to the
          selector in chat.
        </p>
        <div className="mt-6 space-y-3 text-xs">
          <div className="rounded-xl border border-[#273346] bg-[#101722] p-3 text-[#d8e6ff]">
            {configured.length} configured providers
          </div>
          <div className="rounded-xl border border-[#292929] bg-[#121212] p-3 text-[#8a8a8a]">
            Built-in providers without keys stay available here until you activate them.
          </div>
        </div>
      </aside>
    </div>
  )

  const navItems: Array<{ id: SettingsSection; label: string; description: string }> = [
    { id: 'model', label: 'Model', description: 'Providers and model setup' },
    { id: 'memory', label: 'Memory', description: 'User preference memory' },
    { id: 'websearch', label: 'Web Search', description: 'Search provider settings' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="relative z-10 flex h-[min(760px,calc(100vh-32px))] w-[min(1180px,calc(100vw-32px))] min-w-0 overflow-hidden rounded-[28px] border border-[#202020] bg-[#0f0f10] shadow-[0_28px_100px_rgba(0,0,0,0.55)]">
        <aside className="flex w-[260px] shrink-0 flex-col border-r border-[#1f1f1f] bg-[linear-gradient(180deg,#121212_0%,#0d1219_100%)]">
          <div className="border-b border-[#1f1f1f] px-5 py-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-[#6881a6]">Settings</div>
            <div className="mt-3 text-lg text-[#f0f2f5]">Workspace control</div>
            <div className="mt-2 text-xs leading-6 text-[#768190]">
              Manage model access, memory, and retrieval behavior in one place.
            </div>
          </div>

          <nav className="flex-1 space-y-2 p-3">
            {navItems.map((item) => {
              const isActive = item.id === activeSection

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveSection(item.id)}
                  className={`w-full rounded-2xl px-4 py-3 text-left transition ${
                    isActive
                      ? 'border border-[#2c4570] bg-[#132033] text-[#edf4ff] shadow-[0_14px_40px_rgba(17,31,51,0.45)]'
                      : 'border border-transparent bg-transparent text-[#9099a5] hover:border-[#252525] hover:bg-[#151515]'
                  }`}
                >
                  <div className="text-sm">{item.label}</div>
                  <div
                    className={`mt-1 text-[11px] ${isActive ? 'text-[#9eb6d6]' : 'text-[#626d79]'}`}
                  >
                    {item.description}
                  </div>
                </button>
              )
            })}
          </nav>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between border-b border-[#1f1f1f] bg-[#131313] px-6 py-5">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-[#5e6b79]">
                {activeSection}
              </div>
              <div className="mt-2 text-lg text-[#e8eaed]">
                {navItems.find((item) => item.id === activeSection)?.label}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl p-2 text-[#616161] transition hover:bg-[#1b1b1b] hover:text-[#d0d0d0]"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            {activeSection === 'model' && renderModelSection()}
            {activeSection === 'memory' && <MemorySettings />}
            {activeSection === 'websearch' && (
              <WebSearchSettings
                settings={webSearch}
                onSave={async (data) => {
                  await window.api.saveWebSearchConfig(data)
                  await loadWebSearch()
                }}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
