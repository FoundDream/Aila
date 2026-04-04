import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'

import { DragRegion } from '@/components/DragRegion'
import { MemorySettings } from '@/pages/settings/components/MemorySettings'
import { ProviderForm } from '@/pages/settings/components/ProviderForm'
import { SettingsAccordionItem } from '@/pages/settings/components/SettingsAccordionItem'
import { SettingsSectionHeading } from '@/pages/settings/components/SettingsSectionHeading'
import { WebSearchSettings } from '@/pages/settings/components/WebSearchSettings'

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

export function SettingsPage({ onBack }: { onBack: () => void }): ReactElement {
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
    void loadProviders()
    void loadWebSearch()
  }, [loadProviders, loadWebSearch])

  useEffect(() => {
    const unsub = window.api.onConfigChanged(() => {
      void loadProviders()
    })
    return unsub
  }, [loadProviders])

  const configured = providers.filter((provider) => provider.hasApiKey)
  const unconfigured = providers.filter((provider) => !provider.hasApiKey && provider.isBuiltIn)
  const toggleExpanded = (providerId: string): void => {
    setExpandedId((current) => (current === providerId ? null : providerId))
  }

  const renderModelSection = (): ReactElement => (
    <div className="min-w-0">
      {configured.length > 0 && (
        <section className="mb-5">
          <SettingsSectionHeading>Configured</SettingsSectionHeading>
          <div className="space-y-1.5">
            {configured.map((provider) => (
              <SettingsAccordionItem
                key={provider.id}
                expanded={expandedId === provider.id}
                onToggle={() => toggleExpanded(provider.id)}
                header={
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--term-cyan)]" />
                    <span className="text-[var(--term-text)]">{provider.displayName}</span>
                    <span className="text-[var(--term-dim)]">{provider.models.length} models</span>
                  </div>
                }
                trailing={
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
                }
              >
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
              </SettingsAccordionItem>
            ))}
          </div>
        </section>
      )}

      {unconfigured.length > 0 && (
        <section className="mb-5">
          <SettingsSectionHeading>
            {configured.length === 0 ? 'Add an API key to get started' : 'Available'}
          </SettingsSectionHeading>
          <div className="space-y-1.5">
            {unconfigured.map((provider) => (
              <SettingsAccordionItem
                key={provider.id}
                expanded={expandedId === provider.id}
                onToggle={() => toggleExpanded(provider.id)}
                header={
                  <span className="text-[var(--term-text-soft)]">{provider.displayName}</span>
                }
                trailing={<span className="text-[var(--term-dim)]">+ add key</span>}
              >
                <ProviderForm
                  provider={provider}
                  onSave={async (updated) => {
                    await window.api.saveProvider(updated)
                    void loadProviders()
                  }}
                />
              </SettingsAccordionItem>
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
    <div className="flex h-full bg-[var(--term-bg)] text-[var(--term-text)]">
      <aside className="flex h-full w-[236px] shrink-0 flex-col overflow-hidden border-r border-[var(--term-border)] bg-[linear-gradient(180deg,#eef3f9_0%,#e7edf6_100%)]">
        <DragRegion />

        <div className="border-b border-[var(--term-border)] px-4 py-4 sm:px-5 sm:py-5">
          <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--term-blue-strong)]">
            Settings
          </div>
          <div className="mt-3 text-lg text-[var(--term-text)]">Workspace control</div>
          <div className="mt-2 text-xs leading-6 text-[var(--term-text-soft)]">
            Manage model access, memory, and retrieval behavior in one place.
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-2 p-3">
          {navItems.map((item) => {
            const isActive = item.id === activeSection

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
                className={`w-full rounded-2xl px-4 py-3 text-left transition ${
                  isActive
                    ? 'border border-[var(--term-accent-soft-strong)] bg-[var(--term-accent-soft)] text-[var(--term-blue-strong)] shadow-[0_14px_40px_rgba(120,166,248,0.14)]'
                    : 'border border-transparent bg-transparent text-[var(--term-text-soft)] hover:border-[var(--term-border)] hover:bg-[var(--term-surface)]'
                }`}
              >
                <div className="text-sm">{item.label}</div>
                <div
                  className={`mt-1 text-[11px] ${isActive ? 'text-[#7c94bc]' : 'text-[var(--term-dim)]'}`}
                >
                  {item.description}
                </div>
              </button>
            )
          })}
        </nav>

        <div className="border-t border-[var(--term-border)] p-3">
          <button
            type="button"
            onClick={onBack}
            className="flex h-10 w-full items-center justify-center rounded border border-[var(--term-border)] bg-[var(--term-surface)] text-[12px] text-[var(--term-text-soft)] transition hover:bg-[var(--term-surface-soft)] hover:text-[var(--term-text)]"
          >
            back to chat
          </button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <DragRegion className="bg-[var(--term-bg)]" />

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
            onClick={onBack}
            className="rounded-xl px-3 py-2 text-[12px] text-[var(--term-dim)] transition hover:bg-[var(--term-surface)] hover:text-[var(--term-text)]"
          >
            close
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
  )
}
