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
    return <div className="text-xs text-[var(--term-dim)]">Loading memory…</div>
  }

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--term-border)] bg-[var(--term-surface)] p-5">
        <div className="text-sm text-[var(--term-text)]">No memory yet</div>
        <p className="mt-2 max-w-xl text-xs leading-6 text-[var(--term-text-soft)]">
          Preference memory will appear here after the assistant learns stable user preferences from
          conversation turns.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const isEditing = editingId === item.id
        const isBusy = saving === item.id

        return (
          <div
            key={item.id}
            className="rounded-2xl border border-[var(--term-border)] bg-[var(--term-surface)] p-4 shadow-[0_18px_44px_rgba(132,105,70,0.08)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--term-dim)]">
                  {formatLabel(item.key)}
                </div>
                <div className="mt-2 break-words text-sm text-[var(--term-text)]">{item.value}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--term-dim)]">
                <span className="rounded-full border border-[var(--term-border)] px-2 py-1">
                  {item.sourceType}
                </span>
                <span>{Math.round(item.confidence * 100)}%</span>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-[var(--term-dim)]">
              <span>{item.evidenceCount} signals</span>
              <span>updated {formatDate(item.updatedAt)}</span>
            </div>

            {item.reason && (
              <p className="mt-3 text-xs leading-6 text-[var(--term-text-soft)]">{item.reason}</p>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => startEdit(item)}
                className="rounded-lg border border-[var(--term-border)] bg-[var(--term-surface-soft)] px-3 py-1.5 text-xs text-[var(--term-text)] transition hover:bg-[var(--term-surface-hover)]"
              >
                edit
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleDelete(item.id)}
                className="rounded-lg border border-[#e4c7ca] bg-[#fff4f4] px-3 py-1.5 text-xs text-[var(--term-red)] transition hover:bg-[#fdeaea] disabled:opacity-50"
              >
                delete
              </button>
            </div>

            {isEditing && (
              <div className="mt-4 space-y-3 rounded-xl border border-[var(--term-border)] bg-[var(--term-surface-soft)] p-3">
                <div>
                  <label className="mb-1 block text-[11px] uppercase tracking-wider text-[var(--term-dim)]">
                    value
                  </label>
                  <input
                    value={draftValue}
                    onChange={(event) => setDraftValue(event.target.value)}
                    className="w-full rounded-lg border border-[var(--term-border)] bg-[var(--term-surface)] px-3 py-2 text-sm text-[var(--term-text)] outline-none transition focus:border-[var(--term-blue)]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] uppercase tracking-wider text-[var(--term-dim)]">
                    reason
                  </label>
                  <textarea
                    value={draftReason}
                    onChange={(event) => setDraftReason(event.target.value)}
                    rows={3}
                    className="w-full resize-none rounded-lg border border-[var(--term-border)] bg-[var(--term-surface)] px-3 py-2 text-sm text-[var(--term-text)] outline-none transition focus:border-[var(--term-blue)]"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={isBusy || draftValue.trim().length === 0}
                    onClick={() => void handleSave(item.id)}
                    className="rounded-lg bg-[var(--term-blue)] px-3 py-1.5 text-xs text-white transition hover:bg-[var(--term-blue-strong)] disabled:opacity-50"
                  >
                    save
                  </button>
                  <button
                    type="button"
                    onClick={resetEdit}
                    className="rounded-lg border border-[var(--term-border)] bg-[var(--term-surface)] px-3 py-1.5 text-xs text-[var(--term-text-soft)] transition hover:bg-[var(--term-surface-hover)]"
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
  )
}
