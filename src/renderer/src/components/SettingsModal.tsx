import {
  IMAGE_MODEL_CATALOG,
  MODEL_CATALOG,
  modelSupportsVision,
  PROVIDER_LABELS,
  PROVIDER_ORDER,
} from '@shared/models'
import {
  BoxIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LinkIcon,
  LogOutIcon,
  MailIcon,
  PackagePlusIcon,
  PowerIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
  TestTubeIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react'
import type {
  ExtensionMcpServerConfigInput,
  ExtensionMcpTestResult,
  ExtensionReport,
  ModelSelection,
  OrCatalog,
  ProviderId,
  Settings,
} from '../types'
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
  deepseek: 'sk-...',
  openrouter: 'sk-or-...',
}

const OPENROUTER_MODELS_TIMEOUT_MS = 20_000
const EXTENSIONS_REPORT_TIMEOUT_MS = 10_000
const EXTENSIONS_RELOAD_TIMEOUT_MS = 15_000
const MCP_TEST_TIMEOUT_MS = 20_000
const MCP_OAUTH_TIMEOUT_MS = 180_000

const DEFAULT_MCP_SERVER_JSON = JSON.stringify(
  {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    approval: 'ask',
  },
  null,
  2,
)

type SettingsTab = 'provider' | 'models' | 'search' | 'extensions'
type ExtensionsBusy =
  | 'report'
  | 'reload'
  | 'install'
  | 'integration-save'
  | 'mcp-oauth'
  | 'mcp-oauth-clear'
  | 'mcp-save'
  | 'mcp-delete'
  | 'mcp-toggle'
  | 'mcp-test'
  | null

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof KeyRoundIcon }> = [
  { id: 'provider', label: 'Provider', icon: KeyRoundIcon },
  { id: 'models', label: 'Default Models', icon: BoxIcon },
  { id: 'search', label: 'Search', icon: SearchIcon },
  { id: 'extensions', label: 'Extensions', icon: PuzzleIcon },
]

type WebSearchProviders = NonNullable<NonNullable<Settings['webSearch']>['providers']>
type WebSearchProviderKey = keyof WebSearchProviders

const FREE_SEARCH_PROVIDERS: Array<{
  id: Extract<
    WebSearchProviderKey,
    'duckduckgo' | 'wikimedia' | 'hackernews' | 'arxiv' | 'stackexchange'
  >
  label: string
  detail: string
}> = [
  { id: 'duckduckgo', label: 'DuckDuckGo', detail: 'Instant answers fallback' },
  { id: 'wikimedia', label: 'Wikimedia', detail: 'Encyclopedic search' },
  { id: 'hackernews', label: 'Hacker News', detail: 'Technical news and project discussion' },
  { id: 'arxiv', label: 'arXiv', detail: 'Research paper search' },
  { id: 'stackexchange', label: 'Stack Exchange', detail: 'Technical Q&A search' },
]

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${parseFloat((tokens / 1_000_000).toFixed(2))}M`
  return `${Math.round(tokens / 1000)}K`
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    )
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function SectionTitle({ children }: { children: ReactNode }): ReactElement {
  return (
    <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
      {children}
    </h3>
  )
}

function PathRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 px-2.5 py-1.5 text-[11px]">
      <span className="text-[var(--text-soft)]">{label}</span>
      <span className="truncate font-mono text-[var(--text-dim)]" title={value}>
        {value}
      </span>
    </div>
  )
}

function parseMcpServerJson(value: string): ExtensionMcpServerConfigInput {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP config JSON must be an object')
  }
  return parsed as ExtensionMcpServerConfigInput
}

function formatMcpTestResult(result: ExtensionMcpTestResult): string {
  if (!result.ok) return result.error ?? 'Connection failed'
  return `Connected. ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'} found.`
}

export function SettingsModal({ open, onOpenChange, settings, onSave }: Props): ReactElement {
  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<SettingsTab>('provider')
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('anthropic')
  const [revealKey, setRevealKey] = useState(false)
  const [revealSearchKeys, setRevealSearchKeys] = useState(false)
  // Live OpenRouter catalog, fetched lazily the first time that detail page
  // is shown. The static MODEL_CATALOG only carries a couple of curated
  // OpenRouter entries — the real list comes from the API.
  const [orCatalog, setOrCatalog] = useState<OrCatalog | null>(null)
  const [orError, setOrError] = useState<string | null>(null)
  const [orQuery, setOrQuery] = useState('')
  const [extensionsReport, setExtensionsReport] = useState<ExtensionReport | null>(null)
  const [extensionsError, setExtensionsError] = useState<string | null>(null)
  const [extensionsNotice, setExtensionsNotice] = useState<string | null>(null)
  const [extensionsBusy, setExtensionsBusy] = useState<ExtensionsBusy>(null)
  const [mcpServerName, setMcpServerName] = useState('')
  const [mcpServerJson, setMcpServerJson] = useState(DEFAULT_MCP_SERVER_JSON)
  const [mcpTestResults, setMcpTestResults] = useState<Record<string, string>>({})
  const [gmailClientId, setGmailClientId] = useState('')
  const [gmailClientSecret, setGmailClientSecret] = useState('')
  const [gmailRedirectUri, setGmailRedirectUri] = useState('')

  // Reset draft each time we re-open with fresh settings.
  useEffect(() => {
    if (open) {
      setDraft(settings)
      setTab('provider')
      setRevealKey(false)
      setRevealSearchKeys(false)
      setOrError(null)
      setExtensionsReport(null)
      setExtensionsError(null)
      setExtensionsNotice(null)
      setExtensionsBusy(null)
      setMcpServerName('')
      setMcpServerJson(DEFAULT_MCP_SERVER_JSON)
      setMcpTestResults({})
      setGmailClientId('')
      setGmailClientSecret('')
      setGmailRedirectUri('')
    }
  }, [open, settings])

  useEffect(() => {
    if (!open || tab !== 'provider' || selectedProvider !== 'openrouter' || orCatalog) return
    let cancelled = false
    setOrError(null)
    void (async () => {
      try {
        const catalog = await withTimeout(
          window.api.openrouter.listModels(),
          OPENROUTER_MODELS_TIMEOUT_MS,
          'OpenRouter model catalog',
        )
        if (!cancelled) setOrCatalog(catalog)
      } catch (err) {
        if (!cancelled) setOrError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, tab, selectedProvider, orCatalog])

  useEffect(() => {
    if (!open || tab !== 'extensions' || extensionsReport || extensionsError) {
      return
    }
    let cancelled = false
    setExtensionsBusy('report')
    setExtensionsError(null)
    void (async () => {
      try {
        const report = await withTimeout(
          window.api.extensions.report(),
          EXTENSIONS_REPORT_TIMEOUT_MS,
          'Extensions report',
        )
        if (!cancelled) setExtensionsReport(report)
      } catch (err) {
        if (!cancelled) setExtensionsError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setExtensionsBusy(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, tab, extensionsReport, extensionsError])

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

  const setDefaultVisionModel = (selection: ModelSelection | null): void => {
    setDraft((prev) => ({ ...prev, defaultVisionModel: selection }))
  }

  const setVisionFallbackMode = (mode: NonNullable<Settings['visionFallbackMode']>): void => {
    setDraft((prev) => ({ ...prev, visionFallbackMode: mode }))
  }

  const updateWebSearchProvider = <K extends WebSearchProviderKey>(
    provider: K,
    patch: Partial<NonNullable<WebSearchProviders[K]>>,
  ): void => {
    setDraft((prev) => ({
      ...prev,
      webSearch: {
        ...(prev.webSearch ?? {}),
        providers: {
          ...(prev.webSearch?.providers ?? {}),
          [provider]: {
            ...(prev.webSearch?.providers?.[provider] ?? {}),
            ...patch,
          },
        },
      },
    }))
  }

  const searchProviders = draft.webSearch?.providers ?? {}

  const configuredInDraft = PROVIDER_ORDER.filter((p) => Boolean(draft.apiKeys[p]?.trim()))
  const providerConfigured = configuredInDraft.includes(selectedProvider)
  const providerModels = MODEL_CATALOG.filter((m) => m.providerId === selectedProvider)
  const providerImageModels = IMAGE_MODEL_CATALOG.filter((m) => m.providerId === selectedProvider)
  const visionModels = MODEL_CATALOG.filter(
    (m) => configuredInDraft.includes(m.providerId) && modelSupportsVision(m),
  )
  const gmailIntegration = extensionsReport?.integrations.find(
    (integration) => integration.id === 'gmail',
  )
  const gmailServer =
    gmailIntegration?.server ??
    extensionsReport?.mcpServers.find(
      (server) => server.integrationId === 'gmail' || server.name === 'gmail',
    )
  const gmailAuth = gmailServer?.auth
  const gmailScopes = gmailIntegration?.requiredScopes ?? gmailAuth?.scopes ?? []

  const handleReloadExtensions = async (): Promise<void> => {
    if (extensionsBusy) return
    setExtensionsBusy('reload')
    setExtensionsError(null)
    setExtensionsNotice(null)
    try {
      const result = await withTimeout(
        window.api.extensions.reload(),
        EXTENSIONS_RELOAD_TIMEOUT_MS,
        'Extensions reload',
      )
      setExtensionsReport(result.report)
      setExtensionsNotice(
        `Loaded ${result.toolCount} tool${result.toolCount === 1 ? '' : 's'} from ${
          result.report.toolPacks.length + result.report.mcpServers.length
        } extension source${result.report.toolPacks.length + result.report.mcpServers.length === 1 ? '' : 's'}.`,
      )
    } catch (err) {
      setExtensionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtensionsBusy(null)
    }
  }

  const handleInstallSkill = async (): Promise<void> => {
    if (extensionsBusy) return
    setExtensionsBusy('install')
    setExtensionsError(null)
    setExtensionsNotice(null)
    try {
      const result = await window.api.extensions.installSkill()
      if (result) {
        setExtensionsReport(result.report)
        setExtensionsNotice(
          `Installed skill. Loaded ${result.skillCount} skill${
            result.skillCount === 1 ? '' : 's'
          }.`,
        )
      }
    } catch (err) {
      setExtensionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtensionsBusy(null)
    }
  }

  const handleSaveGmailIntegration = async (): Promise<void> => {
    if (extensionsBusy) return
    const clientId = gmailClientId.trim()
    if (!clientId) {
      setExtensionsError('Gmail OAuth client ID is required to save the integration')
      return
    }

    setExtensionsBusy('integration-save')
    setExtensionsError(null)
    setExtensionsNotice(null)
    try {
      const result = await withTimeout(
        window.api.extensions.saveIntegration({
          id: 'gmail',
          oauth: {
            clientId,
            ...(gmailClientSecret.trim() && { clientSecret: gmailClientSecret.trim() }),
            ...(gmailRedirectUri.trim() && { redirectUri: gmailRedirectUri.trim() }),
          },
        }),
        EXTENSIONS_RELOAD_TIMEOUT_MS,
        'Gmail integration save',
      )
      setExtensionsReport(result.report)
      setExtensionsNotice(`Saved Gmail integration. Loaded ${result.toolCount} tools.`)
      setGmailClientSecret('')
    } catch (err) {
      setExtensionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtensionsBusy(null)
    }
  }

  const handleConnectGmail = async (): Promise<void> => {
    if (extensionsBusy) return
    if (!gmailServer) {
      setExtensionsError('Save the Gmail integration before connecting OAuth')
      return
    }

    setExtensionsBusy('mcp-oauth')
    setExtensionsError(null)
    setExtensionsNotice(null)
    try {
      const result = await withTimeout(
        window.api.extensions.startMcpOAuth(gmailServer.name),
        MCP_OAUTH_TIMEOUT_MS,
        'Gmail OAuth',
      )
      setExtensionsReport(result.report)
      setExtensionsNotice(`Connected Gmail OAuth. Loaded ${result.toolCount} tools.`)
    } catch (err) {
      setExtensionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtensionsBusy(null)
    }
  }

  const handleClearGmailOAuth = async (): Promise<void> => {
    if (extensionsBusy || !gmailServer) return
    if (!window.confirm('Remove saved Gmail OAuth tokens from this device?')) return
    setExtensionsBusy('mcp-oauth-clear')
    setExtensionsError(null)
    setExtensionsNotice(null)
    try {
      const result = await withTimeout(
        window.api.extensions.clearMcpOAuth(gmailServer.name),
        EXTENSIONS_RELOAD_TIMEOUT_MS,
        'Gmail OAuth clear',
      )
      setExtensionsReport(result.report)
      setExtensionsNotice('Cleared Gmail OAuth credentials.')
    } catch (err) {
      setExtensionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtensionsBusy(null)
    }
  }

  const handleSaveMcpServer = async (): Promise<void> => {
    if (extensionsBusy) return
    const name = mcpServerName.trim()
    if (!name) {
      setExtensionsError('MCP server name is required')
      return
    }
    let server: ExtensionMcpServerConfigInput
    try {
      server = parseMcpServerJson(mcpServerJson)
    } catch (err) {
      setExtensionsError(err instanceof Error ? err.message : String(err))
      return
    }

    setExtensionsBusy('mcp-save')
    setExtensionsError(null)
    setExtensionsNotice(null)
    try {
      const result = await withTimeout(
        window.api.extensions.saveMcpServer({ name, server }),
        EXTENSIONS_RELOAD_TIMEOUT_MS,
        'MCP server save',
      )
      setExtensionsReport(result.report)
      setExtensionsNotice(`Saved MCP server "${name}". Loaded ${result.toolCount} tools.`)
    } catch (err) {
      setExtensionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtensionsBusy(null)
    }
  }

  const handleTestMcpDraft = async (): Promise<void> => {
    if (extensionsBusy) return
    const name = mcpServerName.trim()
    if (!name) {
      setExtensionsError('MCP server name is required')
      return
    }
    let server: ExtensionMcpServerConfigInput
    try {
      server = parseMcpServerJson(mcpServerJson)
    } catch (err) {
      setExtensionsError(err instanceof Error ? err.message : String(err))
      return
    }

    setExtensionsBusy('mcp-test')
    setExtensionsError(null)
    setExtensionsNotice(null)
    try {
      const result = await withTimeout(
        window.api.extensions.testMcpServerDraft({ name, server }),
        MCP_TEST_TIMEOUT_MS,
        'MCP server test',
      )
      setExtensionsNotice(formatMcpTestResult(result))
    } catch (err) {
      setExtensionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtensionsBusy(null)
    }
  }

  const handleTestMcpServer = async (name: string): Promise<void> => {
    if (extensionsBusy) return
    setExtensionsBusy('mcp-test')
    setExtensionsError(null)
    setExtensionsNotice(null)
    try {
      const result = await withTimeout(
        window.api.extensions.testMcpServer(name),
        MCP_TEST_TIMEOUT_MS,
        'MCP server test',
      )
      setMcpTestResults((prev) => ({ ...prev, [name]: formatMcpTestResult(result) }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setMcpTestResults((prev) => ({ ...prev, [name]: message }))
      setExtensionsError(message)
    } finally {
      setExtensionsBusy(null)
    }
  }

  const handleToggleMcpServer = async (
    server: NonNullable<ExtensionReport['mcpServers']>[number],
  ): Promise<void> => {
    if (extensionsBusy) return
    const enabled = !server.enabled
    setExtensionsBusy('mcp-toggle')
    setExtensionsError(null)
    setExtensionsNotice(null)
    try {
      const result = await withTimeout(
        window.api.extensions.setMcpServerEnabled(server.name, enabled),
        EXTENSIONS_RELOAD_TIMEOUT_MS,
        'MCP server update',
      )
      setExtensionsReport(result.report)
      setExtensionsNotice(`${enabled ? 'Enabled' : 'Disabled'} MCP server "${server.name}".`)
    } catch (err) {
      setExtensionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtensionsBusy(null)
    }
  }

  const handleDeleteMcpServer = async (name: string): Promise<void> => {
    if (extensionsBusy) return
    if (!window.confirm(`Delete MCP server "${name}" from Aila user config?`)) return
    setExtensionsBusy('mcp-delete')
    setExtensionsError(null)
    setExtensionsNotice(null)
    try {
      const result = await withTimeout(
        window.api.extensions.deleteMcpServer(name),
        EXTENSIONS_RELOAD_TIMEOUT_MS,
        'MCP server delete',
      )
      setExtensionsReport(result.report)
      setExtensionsNotice(`Deleted MCP server "${name}".`)
      setMcpTestResults((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
    } catch (err) {
      setExtensionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtensionsBusy(null)
    }
  }

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
      if (
        next.defaultVisionModel &&
        !configuredInDraft.includes(next.defaultVisionModel.providerId)
      ) {
        next = { ...next, defaultVisionModel: null }
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
                      htmlFor="default-vision-model-select"
                      className="w-24 shrink-0 pt-1.5 text-[12px] text-[var(--text)]"
                    >
                      Vision
                    </label>
                    <div className="min-w-0 flex-1">
                      <select
                        id="default-vision-model-select"
                        value={
                          draft.defaultVisionModel
                            ? `${draft.defaultVisionModel.providerId}:${draft.defaultVisionModel.modelId}`
                            : ''
                        }
                        onChange={(e) => {
                          const v = e.target.value
                          if (!v) return setDefaultVisionModel(null)
                          const [providerId, ...rest] = v.split(':')
                          setDefaultVisionModel({
                            providerId: providerId as ProviderId,
                            modelId: rest.join(':'),
                          })
                        }}
                        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--border-strong)]"
                      >
                        <option value="">(none)</option>
                        {visionModels.map((m) => (
                          <option
                            key={`${m.providerId}:${m.modelId}`}
                            value={`${m.providerId}:${m.modelId}`}
                          >
                            {PROVIDER_LABELS[m.providerId]} · {m.displayName}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-[11px] text-[var(--text-dim)]">
                        Used to inspect image attachments before sending them to text-only models.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <label
                      htmlFor="vision-fallback-mode-select"
                      className="w-24 shrink-0 pt-1.5 text-[12px] text-[var(--text)]"
                    >
                      Vision mode
                    </label>
                    <div className="min-w-0 flex-1">
                      <select
                        id="vision-fallback-mode-select"
                        value={draft.visionFallbackMode ?? 'auto'}
                        onChange={(e) =>
                          setVisionFallbackMode(
                            e.target.value as NonNullable<Settings['visionFallbackMode']>,
                          )
                        }
                        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--border-strong)]"
                      >
                        <option value="auto">Auto</option>
                        <option value="ask">Ask</option>
                        <option value="disabled">Disabled</option>
                      </select>
                      <p className="mt-1 text-[11px] text-[var(--text-dim)]">
                        Controls image fallback when the active chat model cannot read images.
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

            {tab === 'search' && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="space-y-5">
                  <section>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <SectionTitle>API Providers</SectionTitle>
                      <button
                        type="button"
                        onClick={() => setRevealSearchKeys((value) => !value)}
                        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                      >
                        {revealSearchKeys ? (
                          <EyeOffIcon className="size-3.5" />
                        ) : (
                          <EyeIcon className="size-3.5" />
                        )}
                        {revealSearchKeys ? 'Hide keys' : 'Show keys'}
                      </button>
                    </div>

                    <div className="space-y-3">
                      <label className="grid grid-cols-[112px_1fr] items-center gap-3 text-[12px]">
                        <span className="text-[var(--text)]">Tavily</span>
                        <input
                          type={revealSearchKeys ? 'text' : 'password'}
                          value={searchProviders.tavily?.apiKey ?? ''}
                          onChange={(event) =>
                            updateWebSearchProvider('tavily', { apiKey: event.target.value })
                          }
                          placeholder="tvly-..."
                          className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 outline-none focus:border-[var(--border-strong)]"
                        />
                      </label>

                      <label className="grid grid-cols-[112px_1fr] items-center gap-3 text-[12px]">
                        <span className="text-[var(--text)]">SearXNG URL</span>
                        <input
                          type="text"
                          value={searchProviders.searxng?.baseUrl ?? ''}
                          onChange={(event) =>
                            updateWebSearchProvider('searxng', { baseUrl: event.target.value })
                          }
                          placeholder="https://search.example.com"
                          className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 outline-none focus:border-[var(--border-strong)]"
                        />
                      </label>

                      <label className="grid grid-cols-[112px_1fr] items-center gap-3 text-[12px]">
                        <span className="text-[var(--text)]">Brave</span>
                        <input
                          type={revealSearchKeys ? 'text' : 'password'}
                          value={searchProviders.brave?.apiKey ?? ''}
                          onChange={(event) =>
                            updateWebSearchProvider('brave', { apiKey: event.target.value })
                          }
                          placeholder="Brave Search API key"
                          className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 outline-none focus:border-[var(--border-strong)]"
                        />
                      </label>

                      <label className="grid grid-cols-[112px_1fr] items-center gap-3 text-[12px]">
                        <span className="text-[var(--text)]">Google key</span>
                        <input
                          type={revealSearchKeys ? 'text' : 'password'}
                          value={searchProviders.google?.apiKey ?? ''}
                          onChange={(event) =>
                            updateWebSearchProvider('google', { apiKey: event.target.value })
                          }
                          placeholder="Google Search API key"
                          className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 outline-none focus:border-[var(--border-strong)]"
                        />
                      </label>

                      <label className="grid grid-cols-[112px_1fr] items-center gap-3 text-[12px]">
                        <span className="text-[var(--text)]">Google CX</span>
                        <input
                          type="text"
                          value={searchProviders.google?.cx ?? ''}
                          onChange={(event) =>
                            updateWebSearchProvider('google', { cx: event.target.value })
                          }
                          placeholder="Programmable Search engine ID"
                          className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 outline-none focus:border-[var(--border-strong)]"
                        />
                      </label>
                    </div>
                  </section>

                  <section>
                    <SectionTitle>Free Fallbacks</SectionTitle>
                    <div className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                      {FREE_SEARCH_PROVIDERS.map((provider) => {
                        const enabled = searchProviders[provider.id]?.enabled !== false
                        return (
                          <label
                            key={provider.id}
                            className="flex items-center gap-3 px-3 py-2 text-[12px]"
                          >
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(event) =>
                                updateWebSearchProvider(provider.id, {
                                  enabled: event.target.checked,
                                })
                              }
                              className="size-3.5"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-[var(--text)]">{provider.label}</span>
                              <span className="block text-[11px] text-[var(--text-dim)]">
                                {provider.detail}
                              </span>
                            </span>
                          </label>
                        )
                      })}
                    </div>

                    <label className="mt-3 grid grid-cols-[112px_1fr] items-center gap-3 text-[12px]">
                      <span className="text-[var(--text)]">Stack site</span>
                      <input
                        type="text"
                        value={searchProviders.stackexchange?.site ?? 'stackoverflow'}
                        onChange={(event) =>
                          updateWebSearchProvider('stackexchange', { site: event.target.value })
                        }
                        className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 outline-none focus:border-[var(--border-strong)]"
                      />
                    </label>
                  </section>
                </div>
              </div>
            )}

            {tab === 'extensions' && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-[var(--text)]">Extensions</div>
                    <div className="mt-0.5 text-[11px] text-[var(--text-dim)]">
                      Tool packs, skills, and MCP servers loaded by the runtime.
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleInstallSkill()}
                      disabled={extensionsBusy !== null}
                      className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2.5 py-1.5 text-[12px] text-[var(--text)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                    >
                      <PackagePlusIcon className="size-3.5" />
                      {extensionsBusy === 'install' ? 'Installing...' : 'Install Skill...'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleReloadExtensions()}
                      disabled={extensionsBusy !== null}
                      className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2.5 py-1.5 text-[12px] text-[var(--text)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                    >
                      <RefreshCwIcon
                        className={`size-3.5 ${extensionsBusy === 'reload' ? 'animate-spin' : ''}`}
                      />
                      {extensionsBusy === 'reload' ? 'Reloading...' : 'Reload'}
                    </button>
                  </div>
                </div>

                {extensionsError && (
                  <p className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{extensionsError}</span>
                  </p>
                )}

                {extensionsNotice && (
                  <p className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-[12px] text-emerald-700">
                    {extensionsNotice}
                  </p>
                )}

                {extensionsBusy === 'report' && !extensionsReport && (
                  <p className="rounded-md border border-[var(--border)] px-2.5 py-2 text-[12px] text-[var(--text-dim)]">
                    Loading extensions...
                  </p>
                )}

                {extensionsReport && (
                  <div className="space-y-5">
                    <section>
                      <SectionTitle>Locations</SectionTitle>
                      <div className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                        <PathRow label="Data" value={extensionsReport.dataDir} />
                        <PathRow label="Tool packs" value={extensionsReport.toolPacksDir} />
                        <PathRow label="Skills" value={extensionsReport.skillsDir} />
                        <PathRow label="MCP user" value={extensionsReport.mcpConfigPath} />
                        <PathRow
                          label="MCP project"
                          value={extensionsReport.projectMcpConfigPath}
                        />
                      </div>
                    </section>

                    <section>
                      <div className="mb-1.5 flex items-center gap-2">
                        <SectionTitle>Tool Packs</SectionTitle>
                        <span className="rounded-full bg-[var(--surface-hover)] px-1.5 py-px text-[10px] tabular-nums text-[var(--text-dim)]">
                          {extensionsReport.toolPacks.length}
                        </span>
                      </div>
                      <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                        {extensionsReport.toolPacks.map((pack) => (
                          <li key={pack.manifestPath} className="px-2.5 py-2">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-[12px] font-medium text-[var(--text)]">
                                {pack.name}
                              </span>
                              <span className="rounded bg-[var(--surface-hover)] px-1 py-px text-[9.5px] uppercase tracking-wide text-[var(--text-dim)]">
                                pack
                              </span>
                              <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-[var(--text-dim)]">
                                {pack.tools.length} tools
                              </span>
                            </div>
                            <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--text-dim)]">
                              {pack.manifestPath}
                            </div>
                            {pack.tools.length > 0 && (
                              <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--text-soft)]">
                                {pack.tools.join(', ')}
                              </div>
                            )}
                          </li>
                        ))}
                        {extensionsReport.toolPacks.length === 0 && (
                          <li className="px-2.5 py-2 text-[12px] text-[var(--text-dim)]">
                            No tool packs installed.
                          </li>
                        )}
                      </ul>
                    </section>

                    <section>
                      <div className="mb-1.5 flex items-center gap-2">
                        <SectionTitle>Skills</SectionTitle>
                        <span className="rounded-full bg-[var(--surface-hover)] px-1.5 py-px text-[10px] tabular-nums text-[var(--text-dim)]">
                          {extensionsReport.skills.length}
                        </span>
                      </div>
                      <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                        {extensionsReport.skills.map((skill) => (
                          <li key={skill.directory} className="px-2.5 py-2">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-[12px] font-medium text-[var(--text)]">
                                {skill.name}
                              </span>
                              <span className="rounded bg-[var(--surface-hover)] px-1 py-px text-[9.5px] uppercase tracking-wide text-[var(--text-dim)]">
                                skill
                              </span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-[var(--text-soft)]">
                              {skill.description}
                            </div>
                            <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--text-dim)]">
                              {skill.skillPath}
                            </div>
                          </li>
                        ))}
                        {extensionsReport.skills.length === 0 && (
                          <li className="px-2.5 py-2 text-[12px] text-[var(--text-dim)]">
                            No skills installed.
                          </li>
                        )}
                      </ul>
                    </section>

                    <section>
                      <div className="mb-1.5 flex items-center gap-2">
                        <SectionTitle>Integrations</SectionTitle>
                        <span className="rounded-full bg-[var(--surface-hover)] px-1.5 py-px text-[10px] tabular-nums text-[var(--text-dim)]">
                          {extensionsReport.integrations.length}
                        </span>
                      </div>
                      <div className="rounded-md border border-[var(--border)] px-2.5 py-2">
                        <div className="flex items-start gap-2">
                          <MailIcon className="mt-0.5 size-4 shrink-0 text-[var(--text-dim)]" />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-[12px] font-medium text-[var(--text)]">
                                {gmailIntegration?.label ?? 'Gmail'}
                              </span>
                              <span className="rounded bg-[var(--surface-hover)] px-1 py-px text-[9.5px] uppercase tracking-wide text-[var(--text-dim)]">
                                {gmailIntegration?.provider ?? 'Google Workspace'}
                              </span>
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] ${
                                  gmailAuth?.authorized
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : gmailServer
                                      ? 'bg-amber-50 text-amber-700'
                                      : 'bg-[var(--surface-hover)] text-[var(--text-dim)]'
                                }`}
                              >
                                {gmailAuth?.authorized
                                  ? 'authorized'
                                  : gmailServer
                                    ? 'needs oauth'
                                    : 'not configured'}
                              </span>
                            </div>
                            <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--text-dim)]">
                              {gmailIntegration?.endpoint ??
                                'https://gmailmcp.googleapis.com/mcp/v1'}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              title="Save Gmail integration"
                              onClick={() => void handleSaveGmailIntegration()}
                              disabled={extensionsBusy !== null}
                              className="grid size-6 place-items-center rounded-md text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                            >
                              <SaveIcon className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              title="Connect Gmail OAuth"
                              onClick={() => void handleConnectGmail()}
                              disabled={extensionsBusy !== null || !gmailServer}
                              className="grid size-6 place-items-center rounded-md text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                            >
                              <LinkIcon className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              title="Clear Gmail OAuth"
                              onClick={() => void handleClearGmailOAuth()}
                              disabled={extensionsBusy !== null || !gmailServer}
                              className="grid size-6 place-items-center rounded-md text-[var(--text-dim)] hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                            >
                              <LogOutIcon className="size-3.5" />
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 grid gap-2 md:grid-cols-3">
                          <input
                            type="text"
                            value={gmailClientId}
                            onChange={(event) => setGmailClientId(event.target.value)}
                            placeholder={
                              gmailAuth?.clientIdSuffix
                                ? `client id ending ${gmailAuth.clientIdSuffix}`
                                : 'OAuth client ID'
                            }
                            aria-label="Gmail OAuth client ID"
                            className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--border-strong)]"
                          />
                          <input
                            type="password"
                            value={gmailClientSecret}
                            onChange={(event) => setGmailClientSecret(event.target.value)}
                            placeholder="OAuth client secret"
                            aria-label="Gmail OAuth client secret"
                            className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--border-strong)]"
                          />
                          <input
                            type="text"
                            value={gmailRedirectUri}
                            onChange={(event) => setGmailRedirectUri(event.target.value)}
                            placeholder={gmailAuth?.redirectUri ?? 'loopback redirect URI'}
                            aria-label="Gmail OAuth redirect URI"
                            className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--border-strong)]"
                          />
                        </div>
                        {gmailScopes.length > 0 && (
                          <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--text-soft)]">
                            {gmailScopes.join(', ')}
                          </div>
                        )}
                        {gmailServer && (
                          <div className="mt-1 flex items-center gap-2 text-[10.5px] text-[var(--text-soft)]">
                            <span className="truncate">{gmailServer.sourcePath}</span>
                            <span className="shrink-0 tabular-nums">
                              {gmailServer.tools.length} tools
                            </span>
                            <span className="shrink-0">{gmailServer.status}</span>
                            {gmailAuth?.hasRefreshToken && (
                              <span className="shrink-0 text-emerald-700">refresh token</span>
                            )}
                          </div>
                        )}
                        {gmailServer?.error && (
                          <div className="mt-1 break-words text-[11px] text-red-700">
                            {gmailServer.error}
                          </div>
                        )}
                      </div>
                    </section>

                    <section>
                      <div className="mb-1.5 flex items-center gap-2">
                        <SectionTitle>MCP Servers</SectionTitle>
                        <span className="rounded-full bg-[var(--surface-hover)] px-1.5 py-px text-[10px] tabular-nums text-[var(--text-dim)]">
                          {extensionsReport.mcpServers.length}
                        </span>
                      </div>
                      <div className="mb-3 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] p-2.5">
                        <div className="mb-2 flex items-center gap-2">
                          <input
                            type="text"
                            value={mcpServerName}
                            onChange={(event) => setMcpServerName(event.target.value)}
                            placeholder="server name"
                            className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--border-strong)]"
                          />
                          <button
                            type="button"
                            title="Test draft"
                            onClick={() => void handleTestMcpDraft()}
                            disabled={extensionsBusy !== null}
                            className="grid size-7 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                          >
                            <TestTubeIcon className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            title="Save MCP server"
                            onClick={() => void handleSaveMcpServer()}
                            disabled={extensionsBusy !== null}
                            className="grid size-7 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                          >
                            <SaveIcon className="size-3.5" />
                          </button>
                        </div>
                        <textarea
                          value={mcpServerJson}
                          onChange={(event) => setMcpServerJson(event.target.value)}
                          rows={7}
                          spellCheck={false}
                          className="min-h-[128px] w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-[11px] leading-4 text-[var(--text)] outline-none focus:border-[var(--border-strong)]"
                        />
                      </div>
                      <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                        {extensionsReport.mcpServers.map((server) => (
                          <li key={`${server.source}:${server.name}`} className="px-2.5 py-2">
                            <div className="flex items-start gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="truncate text-[12px] font-medium text-[var(--text)]">
                                    {server.name}
                                  </span>
                                  <span className="rounded bg-[var(--surface-hover)] px-1 py-px text-[9.5px] uppercase tracking-wide text-[var(--text-dim)]">
                                    {server.transport}
                                  </span>
                                  <span className="rounded bg-[var(--surface-hover)] px-1 py-px text-[9.5px] uppercase tracking-wide text-[var(--text-dim)]">
                                    {server.source}
                                  </span>
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  title="Test connection"
                                  onClick={() => void handleTestMcpServer(server.name)}
                                  disabled={extensionsBusy !== null}
                                  className="grid size-6 place-items-center rounded-md text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                                >
                                  <TestTubeIcon className="size-3.5" />
                                </button>
                                <button
                                  type="button"
                                  title={server.enabled ? 'Disable server' : 'Enable server'}
                                  onClick={() => void handleToggleMcpServer(server)}
                                  disabled={extensionsBusy !== null}
                                  className="grid size-6 place-items-center rounded-md text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                                >
                                  <PowerIcon className="size-3.5" />
                                </button>
                                {server.source === 'user' && (
                                  <button
                                    type="button"
                                    title="Delete server"
                                    onClick={() => void handleDeleteMcpServer(server.name)}
                                    disabled={extensionsBusy !== null}
                                    className="grid size-6 place-items-center rounded-md text-[var(--text-dim)] hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                                  >
                                    <Trash2Icon className="size-3.5" />
                                  </button>
                                )}
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                                    server.status === 'connected'
                                      ? 'bg-emerald-50 text-emerald-700'
                                      : server.status === 'failed'
                                        ? 'bg-red-50 text-red-700'
                                        : 'bg-[var(--surface-hover)] text-[var(--text-dim)]'
                                  }`}
                                >
                                  {server.status}
                                </span>
                              </div>
                            </div>
                            <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--text-dim)]">
                              {server.command
                                ? [server.command, ...(server.args ?? [])].join(' ')
                                : server.url}
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-[10.5px] text-[var(--text-soft)]">
                              <span className="truncate">{server.sourcePath}</span>
                              <span className="shrink-0 tabular-nums">
                                {server.tools.length} tools
                              </span>
                            </div>
                            {server.tools.length > 0 && (
                              <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--text-soft)]">
                                {server.tools.join(', ')}
                              </div>
                            )}
                            {server.error && (
                              <div className="mt-1 break-words text-[11px] text-red-700">
                                {server.error}
                              </div>
                            )}
                            {mcpTestResults[server.name] && (
                              <div className="mt-1 break-words text-[11px] text-[var(--text-dim)]">
                                {mcpTestResults[server.name]}
                              </div>
                            )}
                          </li>
                        ))}
                        {extensionsReport.mcpServers.length === 0 && (
                          <li className="px-2.5 py-2 text-[12px] text-[var(--text-dim)]">
                            No MCP servers configured.
                          </li>
                        )}
                      </ul>
                    </section>

                    {extensionsReport.errors.length > 0 && (
                      <section>
                        <SectionTitle>Errors</SectionTitle>
                        <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                          {extensionsReport.errors.map((error) => (
                            <li
                              key={`${error.kind}:${error.message}`}
                              className="flex items-start gap-2 px-2.5 py-2 text-[12px]"
                            >
                              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                              <span className="rounded bg-[var(--surface-hover)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
                                {error.kind}
                              </span>
                              <span className="min-w-0 break-words text-[var(--text)]">
                                {error.message}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </div>
                )}
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
