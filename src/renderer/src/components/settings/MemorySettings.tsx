import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

interface MemoryItem {
  id: string
  key: string
  value: string
  sourceType: 'explicit' | 'inferred'
  confidence: number
  reason: string | null
  evidenceCount: number
  updatedAt: string
}

function formatLabel(key: string): string {
  return key.replaceAll('_', ' ')
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
}

export function MemorySettings(): ReactElement {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftValue, setDraftValue] = useState('')
  const [draftReason, setDraftReason] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  const loadMemories = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.listMemory()
      setItems(result)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadMemories()
  }, [loadMemories])

  const activeItem = useMemo(
    () => items.find((item) => item.id === editingId) ?? null,
    [editingId, items],
  )

  useEffect(() => {
    if (!activeItem) return
    setDraftValue(activeItem.value)
    setDraftReason(activeItem.reason ?? '')
  }, [activeItem])

  const startEdit = (item: MemoryItem): void => {
    setEditingId(item.id)
    setDraftValue(item.value)
    setDraftReason(item.reason ?? '')
  }

  const resetEdit = (): void => {
    setEditingId(null)
    setDraftValue('')
    setDraftReason('')
  }

  const handleSave = async (id: string): Promise<void> => {
    setSaving(id)
    try {
      await window.api.updateMemory({
        id,
        reason: draftReason.trim() || null,
        value: draftValue.trim(),
      })
      await loadMemories()
      resetEdit()
    } finally {
      setSaving(null)
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    setSaving(id)
    try {
      await window.api.deleteMemory(id)
      await loadMemories()
      if (editingId === id) {
        resetEdit()
      }
    } finally {
      setSaving(null)
    }
  }

  if (loading) {
    return <div className="text-xs text-[#666]">Loading memory…</div>
  }

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-[#242424] bg-[#121212] p-5">
        <div className="text-sm text-[#d5d5d5]">No memory yet</div>
        <p className="mt-2 max-w-xl text-xs leading-6 text-[#6f6f6f]">
          Preference memory will appear here after the assistant learns stable user preferences from
          conversation turns.
        </p>
      </div>
    )
  }

  return (
    <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
      <div className="space-y-3">
        {items.map((item) => {
          const isEditing = editingId === item.id
          const isBusy = saving === item.id

          return (
            <div
              key={item.id}
              className="rounded-2xl border border-[#242424] bg-[#121212] p-4 shadow-[0_14px_40px_rgba(0,0,0,0.22)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[#5d5d5d]">
                    {formatLabel(item.key)}
                  </div>
                  <div className="mt-2 break-words text-sm text-[#e2e2e2]">{item.value}</div>
                </div>
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[#6a6a6a]">
                  <span className="rounded-full border border-[#2e2e2e] px-2 py-1">
                    {item.sourceType}
                  </span>
                  <span>{Math.round(item.confidence * 100)}%</span>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-[#666]">
                <span>{item.evidenceCount} signals</span>
                <span>updated {formatDate(item.updatedAt)}</span>
              </div>

              {item.reason && (
                <p className="mt-3 text-xs leading-6 text-[#7a7a7a]">{item.reason}</p>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => startEdit(item)}
                  className="rounded-lg bg-[#1c1c1c] px-3 py-1.5 text-xs text-[#cfcfcf] transition hover:bg-[#252525]"
                >
                  edit
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleDelete(item.id)}
                  className="rounded-lg border border-[#2d1e1e] bg-[#181212] px-3 py-1.5 text-xs text-[#d69090] transition hover:bg-[#221717] disabled:opacity-50"
                >
                  delete
                </button>
              </div>

              {isEditing && (
                <div className="mt-4 space-y-3 rounded-xl border border-[#272727] bg-[#161616] p-3">
                  <div>
                    <label className="mb-1 block text-[11px] uppercase tracking-wider text-[#666]">
                      value
                    </label>
                    <input
                      value={draftValue}
                      onChange={(event) => setDraftValue(event.target.value)}
                      className="w-full rounded-lg border border-[#2b2b2b] bg-[#101010] px-3 py-2 text-sm text-[#ddd] outline-none transition focus:border-[#3b82f6]"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] uppercase tracking-wider text-[#666]">
                      reason
                    </label>
                    <textarea
                      value={draftReason}
                      onChange={(event) => setDraftReason(event.target.value)}
                      rows={3}
                      className="w-full resize-none rounded-lg border border-[#2b2b2b] bg-[#101010] px-3 py-2 text-sm text-[#ddd] outline-none transition focus:border-[#3b82f6]"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={isBusy || draftValue.trim().length === 0}
                      onClick={() => void handleSave(item.id)}
                      className="rounded-lg bg-[#1d4ed8] px-3 py-1.5 text-xs text-white transition hover:bg-[#2563eb] disabled:opacity-50"
                    >
                      save
                    </button>
                    <button
                      type="button"
                      onClick={resetEdit}
                      className="rounded-lg bg-[#1c1c1c] px-3 py-1.5 text-xs text-[#a8a8a8] transition hover:bg-[#252525]"
                    >
                      cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <aside className="rounded-2xl border border-[#242424] bg-[linear-gradient(180deg,#121212_0%,#101317_100%)] p-5">
        <div className="text-[11px] uppercase tracking-[0.22em] text-[#5d6f8c]">Memory</div>
        <div className="mt-3 text-lg text-[#e5e7eb]">Preference memory manager</div>
        <p className="mt-3 text-xs leading-6 text-[#77808a]">
          This panel edits the active preference memories that get injected into the assistant
          system prompt before each turn.
        </p>

        <div className="mt-6 space-y-3 text-xs text-[#8f98a3]">
          <div className="rounded-xl border border-[#223146] bg-[#101722] p-3">
            <div className="text-[#d8e6ff]">{items.length} active memories</div>
            <div className="mt-1 text-[#70819b]">
              Stored as structured SQLite records, not markdown notes.
            </div>
          </div>
          <div className="rounded-xl border border-[#2a2a2a] bg-[#121212] p-3">
            <div className="text-[#d5d5d5]">How this works</div>
            <div className="mt-1 text-[#767676]">
              The extractor proposes candidates after a turn, then the reconciler updates the
              current preference set.
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}
