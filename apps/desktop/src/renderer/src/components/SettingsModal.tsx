import {
  IMAGE_MODEL_CATALOG,
  modelSupportsVision,
  PROVIDER_LABELS,
  VISION_MODEL_CATALOG,
} from '@shared/models'
import {
  BarChart3Icon,
  BoxIcon,
  DatabaseIcon,
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
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  ExtensionMcpServerConfigInput,
  ExtensionMcpTestResult,
  ExtensionReport,
  ModelSelection,
  PromptCacheMode,
  PromptCacheTtl,
  ProviderConnectionSnapshot,
  ProviderId,
  Settings,
  SettingsState,
  TokenUsageDay,
  TokenUsageStats,
} from '../types'
import { ProviderConnectionsPanel } from './ProviderConnectionsPanel'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: Settings
  connections: ProviderConnectionSnapshot[]
  onSave: (settings: Settings) => Promise<void> | void
  onProviderStateChange: (state: SettingsState) => void
}

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

type SettingsTab = 'provider' | 'models' | 'cache' | 'usage' | 'search' | 'extensions'
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
  { id: 'cache', label: 'Cache', icon: DatabaseIcon },
  { id: 'usage', label: 'Usage', icon: BarChart3Icon },
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

function formatTokenStat(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${parseFloat((tokens / 1_000_000_000).toFixed(2))}B`
  if (tokens >= 1_000_000) return `${parseFloat((tokens / 1_000_000).toFixed(2))}M`
  if (tokens >= 1000) return `${parseFloat((tokens / 1000).toFixed(tokens >= 10_000 ? 1 : 2))}K`
  return `${tokens}`
}

function formatTokenExact(tokens: number): string {
  return tokens.toLocaleString()
}

function formatUsageDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00`)
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatStreak(days: number): string {
  return `${days} day${days === 1 ? '' : 's'}`
}

function activityColor(day: TokenUsageDay | null, peakTokens: number): string {
  if (!day || day.totalTokens <= 0 || peakTokens <= 0) return 'bg-[var(--surface-hover)]'
  const ratio = day.totalTokens / peakTokens
  if (ratio >= 0.75) return 'bg-sky-500'
  if (ratio >= 0.45) return 'bg-sky-400'
  if (ratio >= 0.18) return 'bg-sky-300'
  return 'bg-sky-100'
}

function TokenActivityTooltipBody({ day }: { day: TokenUsageDay }): ReactElement {
  const rows: Array<[string, number]> = [
    ['Total', day.totalTokens],
    ['Input', day.inputTokens],
    ['Output', day.outputTokens],
    ['Cache read', day.cacheReadTokens],
    ['Cache miss', day.cacheMissTokens],
    ['Cache write', day.cacheWriteTokens],
    ['Reasoning', day.reasoningTokens],
    ['Calls', day.modelCallCount],
    ['Turns', day.turnCount],
  ]

  return (
    <div className="w-44 text-left">
      <div className="mb-2 border-b border-background/15 pb-1.5">
        <div className="text-[12px] font-medium leading-none">{formatUsageDate(day.date)}</div>
        <div className="mt-1 text-[11px] opacity-65">{day.date}</div>
      </div>
      <div className="space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3 text-[11px]">
            <span className="opacity-60">{label}</span>
            <span className="font-mono tabular-nums">{formatTokenExact(value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TokenActivityGrid({ stats }: { stats: TokenUsageStats }): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const peakTokens = Math.max(0, ...stats.days.map((day) => day.totalTokens))
  const firstDay = stats.days[0]
  const leadingCells = firstDay ? new Date(`${firstDay.date}T00:00:00`).getDay() : 0
  const cells: Array<TokenUsageDay | { emptyWeekday: number }> = [
    ...Array.from({ length: leadingCells }, (_, emptyWeekday) => ({ emptyWeekday })),
    ...stats.days,
  ]

  useLayoutEffect(() => {
    const viewport = scrollRef.current
    if (!viewport || stats.days.length === 0) return
    viewport.scrollLeft = viewport.scrollWidth
  }, [stats.days.length])

  return (
    <div ref={scrollRef} className="overflow-x-auto pb-1">
      <div
        className="grid w-max grid-flow-col gap-1"
        style={{ gridTemplateRows: 'repeat(7, minmax(0, 10px))' }}
      >
        {cells.map((cell) =>
          'date' in cell ? (
            <Tooltip key={cell.date}>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  aria-label={`${formatUsageDate(cell.date)}, ${formatTokenStat(cell.totalTokens)} tokens`}
                  className={`block size-2.5 rounded-[3px] transition-transform hover:scale-125 ${activityColor(cell, peakTokens)}`}
                />
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={8} className="z-[1100] px-3 py-2">
                <TokenActivityTooltipBody day={cell} />
              </TooltipContent>
            </Tooltip>
          ) : (
            <span
              key={`empty-weekday-${cell.emptyWeekday}`}
              className={`block size-2.5 rounded-[3px] ${activityColor(null, peakTokens)}`}
            />
          ),
        )}
      </div>
    </div>
  )
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

export function SettingsModal({
  open,
  onOpenChange,
  settings,
  connections,
  onSave,
  onProviderStateChange,
}: Props): ReactElement {
  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<SettingsTab>('provider')
  const [revealSearchKeys, setRevealSearchKeys] = useState(false)
  const [extensionsReport, setExtensionsReport] = useState<ExtensionReport | null>(null)
  const [extensionsError, setExtensionsError] = useState<string | null>(null)
  const [extensionsNotice, setExtensionsNotice] = useState<string | null>(null)
  const [extensionsBusy, setExtensionsBusy] = useState<ExtensionsBusy>(null)
  const [usageStats, setUsageStats] = useState<TokenUsageStats | null>(null)
  const [usageStatsError, setUsageStatsError] = useState<string | null>(null)
  const [usageStatsLoading, setUsageStatsLoading] = useState(false)
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
      setRevealSearchKeys(false)
      setExtensionsReport(null)
      setExtensionsError(null)
      setExtensionsNotice(null)
      setExtensionsBusy(null)
      setUsageStats(null)
      setUsageStatsError(null)
      setUsageStatsLoading(false)
      setMcpServerName('')
      setMcpServerJson(DEFAULT_MCP_SERVER_JSON)
      setMcpTestResults({})
      setGmailClientId('')
      setGmailClientSecret('')
      setGmailRedirectUri('')
    }
  }, [open, settings])

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

  const refreshUsageStats = useCallback(async () => {
    setUsageStatsLoading(true)
    setUsageStatsError(null)
    try {
      setUsageStats(await window.api.runtime.getTokenUsageStats())
    } catch (err) {
      setUsageStatsError(err instanceof Error ? err.message : String(err))
    } finally {
      setUsageStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || tab !== 'usage' || usageStats || usageStatsError || usageStatsLoading) return
    void refreshUsageStats()
  }, [open, tab, usageStats, usageStatsError, usageStatsLoading, refreshUsageStats])

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

  const updatePromptCache = (patch: Partial<NonNullable<Settings['promptCache']>>): void => {
    setDraft((prev) => ({
      ...prev,
      promptCache: {
        mode: prev.promptCache?.mode ?? 'auto',
        ttl: prev.promptCache?.ttl ?? '5m',
        openRouterStickySession: prev.promptCache?.openRouterStickySession !== false,
        showDiagnostics: prev.promptCache?.showDiagnostics === true,
        ...patch,
      },
    }))
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
  const promptCache = {
    mode: draft.promptCache?.mode ?? 'auto',
    ttl: draft.promptCache?.ttl ?? '5m',
    openRouterStickySession: draft.promptCache?.openRouterStickySession !== false,
    showDiagnostics: draft.promptCache?.showDiagnostics === true,
  }

  const configuredInDraft = connections
    .filter((connection) => connection.configured && connection.profile.enabled !== false)
    .map((connection) => connection.profile.id)
  const configuredConnections = connections.filter(
    (connection) => connection.configured && connection.profile.enabled !== false,
  )
  const chatModelOptions = configuredConnections.flatMap((connection) => {
    const enabled = new Set(connection.profile.enabledModelIds ?? [])
    return (connection.profile.models ?? [])
      .filter((model) => enabled.size === 0 || enabled.has(model.id))
      .map((model) => ({
        providerId: connection.profile.id,
        providerLabel: connection.profile.label ?? connection.definition.label,
        modelId: model.id,
        displayName: model.displayName ?? model.id,
        contextLength: model.contextLength ?? 0,
        capabilities: model.capabilities,
      }))
  })
  const visionModels = [
    ...chatModelOptions.filter((model) =>
      modelSupportsVision({
        provider: model.providerId,
        modelId: model.modelId,
        capabilities: model.capabilities,
      }),
    ),
    ...VISION_MODEL_CATALOG.filter((model) => configuredInDraft.includes(model.providerId)).map(
      (model) => ({
        ...model,
        providerLabel:
          connections.find((connection) => connection.profile.id === model.providerId)?.profile
            .label ?? PROVIDER_LABELS[model.providerId],
      }),
    ),
  ]
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
        `Reloaded ${result.report.skills.length} skill${
          result.report.skills.length === 1 ? '' : 's'
        } and ${result.report.mcpServers.length} MCP server${
          result.report.mcpServers.length === 1 ? '' : 's'
        }.`,
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
          const firstModel = chatModelOptions.find((model) => model.providerId === first)
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
        <DialogPrimitive.Overlay className="aila-dialog-overlay fixed inset-0 z-[900] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="aila-dialog fixed left-1/2 top-1/2 z-[1000] flex h-[600px] max-h-[88vh] w-[880px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[16px] border border-[var(--border-strong)] bg-[var(--surface)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          {/* Left tab rail */}
          <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-[var(--border)] bg-[var(--bg-soft)] p-3">
            <DialogPrimitive.Title className="mb-3 px-2 pt-1 text-[14px] font-semibold tracking-[-0.01em] text-[var(--text)]">
              Settings
            </DialogPrimitive.Title>
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[12px] transition-colors ${
                  tab === id
                    ? 'bg-[var(--surface)] font-medium text-[var(--text)] shadow-[var(--shadow-xs)]'
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
            <div className="flex h-[52px] items-center justify-between border-b border-[var(--border)] px-5">
              <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--text)]">
                {TABS.find((t) => t.id === tab)?.label}
              </h2>
              <DialogPrimitive.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="grid size-7 place-items-center rounded-lg text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                >
                  <XIcon className="size-4" />
                </button>
              </DialogPrimitive.Close>
            </div>

            {tab === 'provider' && (
              <ProviderConnectionsPanel
                connections={connections}
                onStateChange={onProviderStateChange}
              />
            )}

            {tab === 'models' && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {configuredInDraft.length === 0 && (
                  <p className="mb-3 text-[12px] text-[var(--warning)]">
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
                        {chatModelOptions.map((model) => (
                          <option
                            key={`${model.providerId}:${model.modelId}`}
                            value={`${model.providerId}:${model.modelId}`}
                          >
                            {model.providerLabel}, {model.displayName}
                          </option>
                        ))}
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
                            {m.providerLabel}, {m.displayName}
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
                        <option value="">(none, disable image generation)</option>
                        {IMAGE_MODEL_CATALOG.filter((m) =>
                          configuredInDraft.includes(m.providerId),
                        ).map((m) => (
                          <option
                            key={`${m.providerId}:${m.modelId}`}
                            value={`${m.providerId}:${m.modelId}`}
                          >
                            {PROVIDER_LABELS[m.providerId]}, {m.displayName}
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

            {tab === 'cache' && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="space-y-5">
                  <section>
                    <SectionTitle>Prompt Cache</SectionTitle>
                    <div className="space-y-3">
                      <label className="grid grid-cols-[132px_1fr] items-center gap-3 text-[12px]">
                        <span className="text-[var(--text)]">Mode</span>
                        <select
                          value={promptCache.mode}
                          onChange={(event) =>
                            updatePromptCache({ mode: event.target.value as PromptCacheMode })
                          }
                          className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 outline-none focus:border-[var(--border-strong)]"
                        >
                          <option value="auto">Auto</option>
                          <option value="explicit">Explicit breakpoint</option>
                          <option value="off">Off</option>
                        </select>
                      </label>

                      <label className="grid grid-cols-[132px_1fr] items-center gap-3 text-[12px]">
                        <span className="text-[var(--text)]">Claude TTL</span>
                        <select
                          value={promptCache.ttl}
                          disabled={promptCache.mode === 'off'}
                          onChange={(event) =>
                            updatePromptCache({ ttl: event.target.value as PromptCacheTtl })
                          }
                          className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 outline-none focus:border-[var(--border-strong)] disabled:opacity-50"
                        >
                          <option value="5m">5 minutes</option>
                          <option value="1h">1 hour</option>
                        </select>
                      </label>
                    </div>
                  </section>

                  <section>
                    <SectionTitle>Provider Behavior</SectionTitle>
                    <div className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                      <label className="flex items-center gap-3 px-3 py-2 text-[12px]">
                        <input
                          type="checkbox"
                          checked={promptCache.openRouterStickySession}
                          disabled={promptCache.mode === 'off'}
                          onChange={(event) =>
                            updatePromptCache({ openRouterStickySession: event.target.checked })
                          }
                          className="size-3.5"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[var(--text)]">
                            OpenRouter session stickiness
                          </span>
                          <span className="block text-[11px] text-[var(--text-dim)]">
                            Send the conversation id as the cache session id.
                          </span>
                        </span>
                      </label>

                      <label className="flex items-center gap-3 px-3 py-2 text-[12px]">
                        <input
                          type="checkbox"
                          checked={promptCache.showDiagnostics}
                          onChange={(event) =>
                            updatePromptCache({ showDiagnostics: event.target.checked })
                          }
                          className="size-3.5"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[var(--text)]">Show cache diagnostics</span>
                          <span className="block text-[11px] text-[var(--text-dim)]">
                            Include cache read, write, miss, and reasoning tokens in usage.
                          </span>
                        </span>
                      </label>
                    </div>
                  </section>
                </div>
              </div>
            )}

            {tab === 'usage' && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="space-y-5">
                  <section>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <SectionTitle>Token Usage</SectionTitle>
                      <button
                        type="button"
                        onClick={() => void refreshUsageStats()}
                        disabled={usageStatsLoading}
                        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                      >
                        <RefreshCwIcon
                          className={`size-3.5 ${usageStatsLoading ? 'animate-spin' : ''}`}
                        />
                        Refresh
                      </button>
                    </div>

                    {usageStatsError && (
                      <div className="rounded-md border border-[var(--error-border)] bg-[var(--error-soft)] px-3 py-2 text-[12px] text-[var(--error)]">
                        {usageStatsError}
                      </div>
                    )}

                    {!usageStats && !usageStatsError && (
                      <div className="rounded-md border border-[var(--border)] px-3 py-2 text-[12px] text-[var(--text-dim)]">
                        {usageStatsLoading ? 'Loading usage…' : 'No usage data loaded.'}
                      </div>
                    )}

                    {usageStats && (
                      <div className="grid grid-cols-2 overflow-hidden rounded-md border border-[var(--border)] md:grid-cols-5">
                        {[
                          ['Today', formatTokenStat(usageStats.today.totalTokens)],
                          ['Lifetime', formatTokenStat(usageStats.lifetime.totalTokens)],
                          [
                            'Peak day',
                            usageStats.peakDay
                              ? formatTokenStat(usageStats.peakDay.totalTokens)
                              : '0',
                          ],
                          ['Current streak', formatStreak(usageStats.currentStreakDays)],
                          ['Longest streak', formatStreak(usageStats.longestStreakDays)],
                        ].map(([label, value]) => (
                          <div
                            key={label}
                            className="border-b border-r border-[var(--border)] px-3 py-3 last:border-r-0 md:border-b-0"
                          >
                            <div className="text-[18px] font-semibold leading-none tabular-nums text-[var(--text)]">
                              {value}
                            </div>
                            <div className="mt-1 text-[11px] text-[var(--text-dim)]">{label}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {usageStats && (
                    <>
                      <section>
                        <SectionTitle>Today</SectionTitle>
                        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                          {[
                            ['Input', usageStats.today.inputTokens],
                            ['Output', usageStats.today.outputTokens],
                            ['Cache read', usageStats.today.cacheReadTokens],
                            ['Turns', usageStats.today.turnCount],
                          ].map(([label, value]) => (
                            <div
                              key={label}
                              className="rounded-md border border-[var(--border)] px-3 py-2"
                            >
                              <div className="text-[14px] font-medium tabular-nums text-[var(--text)]">
                                {typeof value === 'number' ? formatTokenStat(value) : value}
                              </div>
                              <div className="mt-0.5 text-[11px] text-[var(--text-dim)]">
                                {label}
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>

                      <section>
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <SectionTitle>Token Activity</SectionTitle>
                          <span className="text-[11px] text-[var(--text-dim)]">Last 365 days</span>
                        </div>
                        <TokenActivityGrid stats={usageStats} />
                      </section>
                    </>
                  )}
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
                      Skills and MCP servers loaded by the runtime.
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
                  <p className="mb-3 flex items-start gap-2 rounded-md border border-[var(--error-border)] bg-[var(--error-soft)] px-2.5 py-2 text-[12px] text-[var(--error)]">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{extensionsError}</span>
                  </p>
                )}

                {extensionsNotice && (
                  <p className="mb-3 rounded-md border border-[var(--success-border)] bg-[var(--success-soft)] px-2.5 py-2 text-[12px] text-[var(--success)]">
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
                                    ? 'bg-[var(--success-soft)] text-[var(--success)]'
                                    : gmailServer
                                      ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
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
                              className="grid size-6 place-items-center rounded-md text-[var(--text-dim)] hover:bg-[var(--error-soft)] hover:text-[var(--error)] disabled:opacity-50"
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
                              <span className="shrink-0 text-[var(--success)]">refresh token</span>
                            )}
                          </div>
                        )}
                        {gmailServer?.error && (
                          <div className="mt-1 break-words text-[11px] text-[var(--error)]">
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
                                    className="grid size-6 place-items-center rounded-md text-[var(--text-dim)] hover:bg-[var(--error-soft)] hover:text-[var(--error)] disabled:opacity-50"
                                  >
                                    <Trash2Icon className="size-3.5" />
                                  </button>
                                )}
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                                    server.status === 'connected'
                                      ? 'bg-[var(--success-soft)] text-[var(--success)]'
                                      : server.status === 'failed'
                                        ? 'bg-[var(--error-soft)] text-[var(--error)]'
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
                              <div className="mt-1 break-words text-[11px] text-[var(--error)]">
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
                              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
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

            <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-3">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="h-8 rounded-lg border border-[var(--border)] px-3 text-[12px] text-[var(--text-soft)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="h-8 rounded-lg bg-[var(--brand-ink)] px-3.5 text-[12px] font-medium text-[var(--brand-ink-fg)] transition-colors hover:opacity-90 disabled:opacity-50"
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
