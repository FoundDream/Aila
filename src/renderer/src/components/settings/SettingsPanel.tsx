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
    <div className="min-w-0">
      {configured.length > 0 && (
        <section className="mb-5">
          <h3 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--term-dim)]">
            Configured
          </h3>
          <div className="space-y-1.5">
            {configured.map((provider) => (
              <div key={provider.id}>
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === provider.id ? null : provider.id)}
                  className="flex w-full items-center justify-between rounded-xl border border-[var(--term-border)] bg-[var(--term-surface)] px-3 py-3 text-left text-xs transition hover:bg-[var(--term-surface-soft)]"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--term-cyan)]" />
                    <span className="text-[var(--term-text)]">{provider.displayName}</span>
                    <span className="text-[var(--term-dim)]">{provider.models.length} models</span>
                  </div>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className={`text-[var(--term-dim)] transition ${expandedId === provider.id ? 'rotate-180' : ''}`}
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
          <h3 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--term-dim)]">
            {configured.length === 0 ? 'Add an API key to get started' : 'Available'}
          </h3>
          <div className="space-y-1.5">
            {unconfigured.map((provider) => (
              <div key={provider.id}>
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === provider.id ? null : provider.id)}
                  className="flex w-full items-center justify-between rounded-xl border border-[var(--term-border)] bg-[var(--term-surface)] px-3 py-3 text-left text-xs transition hover:bg-[var(--term-surface-soft)]"
                >
                  <span className="text-[var(--term-text-soft)]">{provider.displayName}</span>
                  <span className="text-[var(--term-dim)]">+ add key</span>
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
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--term-border)] bg-[var(--term-surface)] px-3 py-3 text-xs text-[var(--term-dim)] transition hover:bg-[var(--term-surface-soft)] hover:text-[var(--term-text)]"
          >
            + custom provider
          </button>
        ) : (
          <div className="rounded-2xl border border-[var(--term-border)] bg-[var(--term-surface)] p-3">
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
  )

  const navItems: Array<{ id: SettingsSection; label: string; description: string }> = [
    { id: 'model', label: 'Model', description: 'Providers and model setup' },
    { id: 'memory', label: 'Memory', description: 'User preference memory' },
    { id: 'websearch', label: 'Web Search', description: 'Search provider settings' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5">
      <div
        className="absolute inset-0 bg-[var(--term-overlay)] backdrop-blur-[2px]"
        onClick={onClose}
      />

      <div className="relative z-10 flex h-[min(660px,calc(100vh-24px))] w-[min(900px,calc(100vw-24px))] min-w-0 overflow-hidden rounded-[24px] border border-[var(--term-border)] bg-[var(--term-bg)] shadow-[0_24px_72px_rgba(92,118,154,0.16)] sm:h-[min(680px,calc(100vh-40px))] sm:w-[min(940px,calc(100vw-48px))] xl:rounded-[28px]">
        <aside className="flex w-[176px] shrink-0 flex-col border-r border-[var(--term-border)] bg-[linear-gradient(180deg,#eef3f9_0%,#e7edf6_100%)] sm:w-[208px] xl:w-[240px]">
          <div className="border-b border-[var(--term-border)] px-4 py-4 sm:px-5 sm:py-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--term-blue-strong)]">
              Settings
            </div>
            <div className="mt-2 text-base text-[var(--term-text)] sm:mt-3 sm:text-lg">
              Workspace control
            </div>
            <div className="mt-2 hidden text-xs leading-6 text-[var(--term-text-soft)] sm:block">
              Manage model access, memory, and retrieval behavior in one place.
            </div>
          </div>

          <nav className="flex flex-1 flex-col gap-2 p-2.5 sm:p-3">
            {navItems.map((item) => {
              const isActive = item.id === activeSection

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveSection(item.id)}
                  className={`w-full rounded-2xl px-3 py-2.5 text-left transition sm:px-4 sm:py-3 ${
                    isActive
                      ? 'border border-[var(--term-accent-soft-strong)] bg-[var(--term-accent-soft)] text-[var(--term-blue-strong)] shadow-[0_14px_40px_rgba(120,166,248,0.14)]'
                      : 'border border-transparent bg-transparent text-[var(--term-text-soft)] hover:border-[var(--term-border)] hover:bg-[var(--term-surface)]'
                  }`}
                >
                  <div className="text-sm">{item.label}</div>
                  <div
                    className={`mt-1 hidden text-[11px] sm:block ${isActive ? 'text-[#7c94bc]' : 'text-[var(--term-dim)]'}`}
                  >
                    {item.description}
                  </div>
                </button>
              )
            })}
          </nav>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between border-b border-[var(--term-border)] bg-[var(--term-surface-soft)] px-4 py-4 sm:px-5 sm:py-5 md:px-6">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--term-dim)]">
                {activeSection}
              </div>
              <div className="mt-2 text-base text-[var(--term-text)] sm:text-lg">
                {navItems.find((item) => item.id === activeSection)?.label}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl p-2 text-[var(--term-dim)] transition hover:bg-[var(--term-surface)] hover:text-[var(--term-text)]"
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

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5 md:px-6 md:py-6">
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
