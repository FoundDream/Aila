import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

interface ModelEntry {
  id: string
  name: string
  toolUse: boolean
  reasoning: boolean
  contextWindow: number
}

interface ModelGroup {
  providerId: string
  providerName: string
  models: ModelEntry[]
}

function formatContext(ctx: number): string {
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M`
  if (ctx >= 1_000) return `${(ctx / 1_000).toFixed(0)}k`
  return String(ctx)
}

function useModelSelection(): {
  activeModelId: string | null
  groups: ModelGroup[]
  setActiveModelId: (value: string | null) => void
} {
  const [groups, setGroups] = useState<ModelGroup[]>([])
  const [activeModelId, setActiveModelId] = useState<string | null>(null)

  const loadModels = useCallback(async () => {
    const [modelGroups, active] = await Promise.all([
      window.api.getModels() as Promise<ModelGroup[]>,
      window.api.getActiveModel(),
    ])
    setGroups(modelGroups)
    setActiveModelId(active)
  }, [])

  useEffect(() => {
    void loadModels()
  }, [loadModels])

  useEffect(() => {
    const unsub = window.api.onConfigChanged(() => void loadModels())
    return unsub
  }, [loadModels])

  return {
    activeModelId,
    groups,
    setActiveModelId,
  }
}

export function ModelSelector({
  onSettingsClick,
  variant = 'header',
}: {
  onSettingsClick: () => void
  variant?: 'header' | 'composer'
}): ReactElement {
  const { activeModelId, groups, setActiveModelId } = useModelSelection()
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleSelect = async (providerId: string, modelId: string): Promise<void> => {
    const key = `${providerId}/${modelId}`
    if (key === activeModelId) {
      setOpen(false)
      return
    }
    setSwitching(true)
    try {
      await window.api.setActiveModel(providerId, modelId)
      setActiveModelId(key)
    } catch (err) {
      console.error('Failed to switch model:', err)
    } finally {
      setSwitching(false)
      setOpen(false)
    }
  }

  const activeKey = activeModelId?.split('/')
  const activeGroup = groups.find((g) => g.providerId === activeKey?.[0])
  const activeModel = activeGroup?.models.find((m) => m.id === activeKey?.[1])
  const displayName = activeModel?.name ?? activeKey?.[1] ?? 'no model'
  const hasModels = groups.some((g) => g.models.length > 0)
  const triggerClasses =
    variant === 'composer'
      ? 'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-[var(--term-text-soft)] transition hover:bg-[var(--term-surface-hover)] hover:text-[var(--term-text)] disabled:opacity-50'
      : 'flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-[var(--term-dim)] transition hover:bg-[var(--term-surface-soft)] hover:text-[var(--term-text)] disabled:opacity-50'
  const menuClasses =
    variant === 'composer'
      ? 'absolute bottom-full left-0 z-50 mb-2 w-[min(32rem,calc(100vw-2rem))] rounded border border-[var(--term-border)] bg-[var(--term-surface)] py-1 shadow-lg'
      : 'absolute right-0 top-full z-50 mt-1 w-64 rounded border border-[var(--term-border)] bg-[var(--term-surface)] py-1 shadow-lg'

  return (
    <div
      ref={ref}
      className={
        variant === 'composer'
          ? 'relative min-w-0 flex-1 [-webkit-app-region:no-drag]'
          : 'relative [-webkit-app-region:no-drag]'
      }
    >
      <button
        type="button"
        onClick={() => (hasModels ? setOpen(!open) : onSettingsClick())}
        disabled={switching}
        className={triggerClasses}
      >
        {switching ? (
          <span className="text-[var(--term-dim)]">switching...</span>
        ) : hasModels ? (
          <>
            {variant === 'composer' ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[var(--term-text)]">
                  {displayName}
                </span>
                {activeModel && (
                  <div className="hidden shrink-0 items-center gap-1 text-[10px] text-[var(--term-dim)] md:flex">
                    {activeModel.toolUse && <span>tools</span>}
                    {activeModel.reasoning && <span>think</span>}
                    <span>{formatContext(activeModel.contextWindow)}</span>
                  </div>
                )}
              </div>
            ) : (
              <span className="max-w-[180px] truncate">{displayName}</span>
            )}
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-[var(--term-dim)]"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </>
        ) : (
          <span className="text-[var(--term-dim)]">setup providers</span>
        )}
      </button>

      {open && hasModels && (
        <div className={menuClasses}>
          {groups.map((group) => (
            <div key={group.providerId}>
              <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-[var(--term-dim)]">
                {group.providerName}
              </div>
              {group.models.map((model) => {
                const key = `${group.providerId}/${model.id}`
                const isActive = key === activeModelId

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => void handleSelect(group.providerId, model.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition ${
                      isActive
                        ? 'bg-[var(--term-accent-soft)] text-[var(--term-text)]'
                        : 'text-[var(--term-text-soft)] hover:bg-[var(--term-surface-soft)] hover:text-[var(--term-text)]'
                    }`}
                  >
                    <span className="w-3 text-center text-[10px] text-[var(--term-blue)]">
                      {isActive ? '*' : ''}
                    </span>
                    <span className="flex-1 truncate">{model.name}</span>
                    <div className="flex gap-1 text-[10px] text-[var(--term-dim)]">
                      {model.toolUse && <span>tools</span>}
                      {model.reasoning && <span>think</span>}
                      <span>{formatContext(model.contextWindow)}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          ))}

          <div className="bg-[var(--term-surface-soft)] px-3 py-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onSettingsClick()
              }}
              className="text-[11px] text-[var(--term-dim)] transition hover:text-[var(--term-text)]"
            >
              manage providers
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
