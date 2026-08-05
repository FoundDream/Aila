import { findModel } from '@shared/models'
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SearchIcon,
  SettingsIcon,
} from 'lucide-react'
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type {
  ModelSelection,
  OrCatalog,
  OrFamily,
  OrModel,
  ProviderConnectionSnapshot,
  ProviderId,
} from '../types'
import { ProviderLogo } from './ProviderLogo'

interface Props {
  configuredProviders: ProviderId[]
  connections: ProviderConnectionSnapshot[]
  selection: ModelSelection | null
  onChange: (selection: ModelSelection) => void
  onOpenSettings: () => void
  recentOpenRouterModels: string[]
}

export function ModelPicker({
  configuredProviders,
  connections,
  selection,
  onChange,
  onOpenSettings,
  recentOpenRouterModels,
}: Props): ReactElement {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'main' | 'openrouter'>('main')

  const noProviders = configuredProviders.length === 0
  const selectedMeta = selection ? findModel(selection.providerId, selection.modelId) : null
  const selectedConnection = selection
    ? connections.find((connection) => connection.profile.id === selection.providerId)
    : null
  const selectedConnectionModel = selection
    ? selectedConnection?.profile.models?.find((model) => model.id === selection.modelId)
    : null

  // Reset to main view whenever the popover closes.
  useEffect(() => {
    if (!open) setView('main')
  }, [open])

  const pick = (next: ModelSelection): void => {
    onChange(next)
    setOpen(false)
  }

  if (noProviders) {
    return (
      <button
        type="button"
        onClick={onOpenSettings}
        className="flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      >
        <SettingsIcon className="size-3.5 shrink-0" />
        <span className="truncate">Configure API key</span>
      </button>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          {selection ? (
            <ProviderLogo
              id={selectedConnection?.profile.providerType ?? selection.providerId}
              size={12}
            />
          ) : null}
          <span className="truncate">
            {selectedConnectionModel?.displayName ??
              selectedMeta?.displayName ??
              selection?.modelId ??
              'Choose model'}
          </span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-1.5rem)] max-h-[460px] overflow-hidden border-0 p-0"
      >
        {view === 'main' ? (
          <MainView
            configuredProviders={configuredProviders}
            connections={connections}
            selection={selection}
            onPick={pick}
            onOpenOpenRouter={() => setView('openrouter')}
            onOpenSettings={() => {
              setOpen(false)
              onOpenSettings()
            }}
          />
        ) : (
          <OpenRouterView
            selection={selection}
            recentIds={recentOpenRouterModels}
            onBack={() => setView('main')}
            onPick={pick}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function MainView({
  configuredProviders,
  connections,
  selection,
  onPick,
  onOpenOpenRouter,
  onOpenSettings,
}: {
  configuredProviders: ProviderId[]
  connections: ProviderConnectionSnapshot[]
  selection: ModelSelection | null
  onPick: (s: ModelSelection) => void
  onOpenOpenRouter: () => void
  onOpenSettings: () => void
}): ReactElement {
  return (
    <div className="flex max-h-[460px] flex-col">
      <div className="flex-1 overflow-auto p-1">
        {connections
          .filter(
            (connection) =>
              configuredProviders.includes(connection.profile.id) &&
              connection.profile.enabled !== false &&
              connection.profile.id !== 'openrouter',
          )
          .map((connection) => {
            const providerId = connection.profile.id
            const enabled = new Set(connection.profile.enabledModelIds ?? [])
            const models = (connection.profile.models ?? []).filter(
              (model) => enabled.size === 0 || enabled.has(model.id),
            )
            return (
              <div key={providerId} className="mb-1 last:mb-0">
                <div className="flex items-center gap-1.5 px-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
                  <ProviderLogo id={connection.profile.providerType} size={12} />
                  {connection.profile.label ?? connection.definition.label}
                </div>
                {models.map((model) => {
                  const isSelected =
                    selection?.providerId === providerId && selection?.modelId === model.id
                  return (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => onPick({ providerId, modelId: model.id })}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)] ${
                        isSelected ? 'bg-[var(--surface-hover)]' : ''
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {model.displayName ?? model.id}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-dim)]">
                        {formatCtx(model.contextLength ?? 0)}
                      </span>
                      {isSelected ? <CheckIcon className="size-3 shrink-0" /> : null}
                    </button>
                  )
                })}
              </div>
            )
          })}
        {configuredProviders.includes('openrouter') && (
          <button
            type="button"
            onClick={onOpenOpenRouter}
            className="mt-1 flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)]"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <ProviderLogo id="openrouter" size={12} />
              <span className="font-medium">OpenRouter</span>
              <span className="text-[10px] text-[var(--text-dim)]">
                {selection?.providerId === 'openrouter'
                  ? (findModel('openrouter', selection.modelId)?.displayName ?? selection.modelId)
                  : 'browse all'}
              </span>
            </span>
            <ChevronRightIcon className="size-3 shrink-0 opacity-60" />
          </button>
        )}
      </div>
      <div className="border-t border-[var(--border)] p-1">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <SettingsIcon className="size-3" />
          Manage providers
        </button>
      </div>
    </div>
  )
}

function OpenRouterView({
  selection,
  recentIds,
  onBack,
  onPick,
}: {
  selection: ModelSelection | null
  recentIds: string[]
  onBack: () => void
  onPick: (s: ModelSelection) => void
}): ReactElement {
  const [catalog, setCatalog] = useState<OrCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    void window.api.openrouter
      .listModels()
      .then((cat) => {
        if (cancelled) return
        setCatalog(cat)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const recents = useMemo(() => {
    if (!catalog) return []
    const idx = new Map(catalog.families.flatMap((f) => f.models.map((m) => [m.id, m])))
    return recentIds.map((id) => idx.get(id)).filter((m): m is OrModel => Boolean(m))
  }, [catalog, recentIds])

  const filteredFamilies = useMemo(() => {
    if (!catalog) return []
    if (!query.trim()) return catalog.families
    const q = query.toLowerCase()
    return catalog.families
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
  }, [catalog, query])

  const isSearching = query.trim().length > 0

  const pickFromOr = (model: OrModel): void => {
    onPick({ providerId: 'openrouter', modelId: model.id })
  }

  const isPicked = (modelId: string): boolean =>
    selection?.providerId === 'openrouter' && selection.modelId === modelId

  return (
    <div className="flex max-h-[460px] flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 py-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid size-6 place-items-center rounded-md text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <ArrowLeftIcon className="size-3.5" />
        </button>
        <ProviderLogo id="openrouter" size={12} />
        <span className="text-[12px] font-medium">OpenRouter</span>
      </div>

      <div className="shrink-0 border-b border-[var(--border)] px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1">
          <SearchIcon className="size-3 shrink-0 text-[var(--text-dim)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter OpenRouter models..."
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--text-dim)]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-1">
        {error && (
          <div className="px-2 py-3 text-[12px] text-[var(--error)]">
            Failed to load OpenRouter models: {error}
          </div>
        )}
        {!catalog && !error && (
          <div className="px-2 py-3 text-[12px] text-[var(--text-dim)]">Loading models…</div>
        )}

        {catalog && !isSearching && (
          <>
            {catalog.topPicks.length > 0 && (
              <Section title="★ Top picks">
                {catalog.topPicks.map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    selected={isPicked(m.id)}
                    onClick={() => pickFromOr(m)}
                  />
                ))}
              </Section>
            )}
            {recents.length > 0 && (
              <Section title="Recent">
                {recents.map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    selected={isPicked(m.id)}
                    onClick={() => pickFromOr(m)}
                  />
                ))}
              </Section>
            )}
            <div className="mt-1">
              {catalog.families.map((f) => (
                <FamilyRow
                  key={f.family}
                  family={f}
                  expanded={expanded.has(f.family)}
                  onToggle={() => {
                    setExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(f.family)) next.delete(f.family)
                      else next.add(f.family)
                      return next
                    })
                  }}
                  onPick={pickFromOr}
                  isPicked={isPicked}
                />
              ))}
            </div>
          </>
        )}

        {catalog &&
          isSearching &&
          (filteredFamilies.length === 0 ? (
            <div className="px-2 py-3 text-[12px] text-[var(--text-dim)]">No matches.</div>
          ) : (
            filteredFamilies.map((f) => (
              <Section key={f.family} title={f.label}>
                {f.models.slice(0, 20).map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    selected={isPicked(m.id)}
                    onClick={() => pickFromOr(m)}
                  />
                ))}
                {f.models.length > 20 && (
                  <div className="px-2 py-1 text-[10px] text-[var(--text-dim)]">
                    +{f.models.length - 20} more, refine search
                  </div>
                )}
              </Section>
            ))
          ))}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="mb-1 last:mb-0">
      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
        {title}
      </div>
      {children}
    </div>
  )
}

function ModelRow({
  model,
  selected,
  onClick,
}: {
  model: OrModel
  selected: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)] ${
        selected ? 'bg-[var(--surface-hover)]' : ''
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{model.name}</span>
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-dim)]">
        {formatCtx(model.contextLength)}
      </span>
      {selected ? <CheckIcon className="size-3 shrink-0" /> : null}
    </button>
  )
}

const FAMILY_PREVIEW = 6

function FamilyRow({
  family,
  expanded,
  onToggle,
  onPick,
  isPicked,
}: {
  family: OrFamily
  expanded: boolean
  onToggle: () => void
  onPick: (m: OrModel) => void
  isPicked: (id: string) => boolean
}): ReactElement {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? family.models : family.models.slice(0, FAMILY_PREVIEW)
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)]"
      >
        <ChevronRightIcon
          className={`size-3 shrink-0 text-[var(--text-dim)] transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
        />
        <span className="flex-1 truncate font-medium">{family.label}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-dim)]">
          {family.models.length}
        </span>
      </button>
      {expanded && (
        <div className="ml-4">
          {visible.map((m) => (
            <ModelRow key={m.id} model={m} selected={isPicked(m.id)} onClick={() => onPick(m)} />
          ))}
          {!showAll && family.models.length > FAMILY_PREVIEW && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="px-2 py-1 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)]"
            >
              Show all {family.models.length} →
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function formatCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  if (n === 0) return ''
  return `${n}`
}
