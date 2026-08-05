import { findModel, MODEL_CATALOG } from '@shared/models'
import { useCallback, useMemo, useRef } from 'react'
import type { ModelSelection, ProviderConnectionSnapshot, ProviderId, Settings } from '../../types'

export interface ModelSelectionApi {
  selection: ModelSelection | null
  selectionRef: React.MutableRefObject<ModelSelection | null>
  contextLength: number | null
  handleSelectionChange: (next: ModelSelection) => void
}

function pickInitialSelection(
  settings: Settings | null,
  configured: ProviderId[],
  connections: ProviderConnectionSnapshot[],
): ModelSelection | null {
  if (!settings) return null
  const def = settings.defaultModel
  if (def && configured.includes(def.providerId)) return def
  const first = configured[0]
  if (!first) return null
  const connection = connections.find((candidate) => candidate.profile.id === first)
  const connectionModel =
    connection?.profile.defaultModel ??
    connection?.profile.enabledModelIds?.[0] ??
    connection?.profile.models?.[0]?.id
  if (connectionModel) return { providerId: first, modelId: connectionModel }
  const fallback = MODEL_CATALOG.find((m) => m.providerId === first)
  return fallback ? { providerId: first, modelId: fallback.modelId } : null
}

// Shared selection logic for any view that needs a model picker. The selection
// itself isn't local state — it's derived from settings, and changes write
// straight back to settings via onUpdateSettings.
export function useModelSelection(
  settings: Settings | null,
  configuredProviders: ProviderId[],
  connections: ProviderConnectionSnapshot[],
  onUpdateSettings: (settings: Settings) => Promise<void>,
): ModelSelectionApi {
  const selection = useMemo(
    () => pickInitialSelection(settings, configuredProviders, connections),
    [settings, configuredProviders, connections],
  )
  const selectionRef = useRef<ModelSelection | null>(selection)
  selectionRef.current = selection

  const contextLength = useMemo(() => {
    if (!selection) return null
    const meta = findModel(selection.providerId, selection.modelId)
    if (meta?.contextLength) return meta.contextLength
    const connection = connections.find(
      (candidate) => candidate.profile.id === selection.providerId,
    )
    return (
      connection?.profile.models?.find((model) => model.id === selection.modelId)?.contextLength ??
      null
    )
  }, [selection, connections])

  const handleSelectionChange = useCallback(
    (next: ModelSelection) => {
      if (!settings) return
      const update: Settings = { ...settings, defaultModel: next }
      if (next.providerId === 'openrouter') {
        const prev = settings.recentOpenRouterModels ?? []
        update.recentOpenRouterModels = [
          next.modelId,
          ...prev.filter((id) => id !== next.modelId),
        ].slice(0, 5)
      }
      void onUpdateSettings(update)
    },
    [settings, onUpdateSettings],
  )

  return { selection, selectionRef, contextLength, handleSelectionChange }
}
