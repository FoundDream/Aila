import { CheckIcon, GitBranchIcon } from 'lucide-react'
import { type ReactElement, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { clockTime } from './debugFormat'
import type { BranchOption } from './playgroundState'

interface BranchSwitcherProps {
  branches: BranchOption[]
  descendantBranchCount: number
  disabled: boolean
  onSwitch: (leafEntryId: string) => void
}

/**
 * Every edit/rewind mints a branch; this is the playground's undo history.
 * Switching branches is navigation, not deletion — nothing is ever lost.
 */
export function BranchSwitcher({
  branches,
  descendantBranchCount,
  disabled,
  onSwitch,
}: BranchSwitcherProps): ReactElement | null {
  const [open, setOpen] = useState(false)
  if (branches.length <= 1 && descendantBranchCount === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-[11px] font-medium text-[var(--text-soft)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
        >
          <GitBranchIcon className="size-3.5" />
          {branches.length} {branches.length === 1 ? 'branch' : 'branches'}
          {descendantBranchCount > 0 && (
            <span className="rounded-full bg-[var(--warning-soft)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--warning)]">
              {descendantBranchCount} ahead
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-1.5">
        <p className="px-2 pb-1.5 pt-1 text-[10px] text-[var(--text-dim)]">
          Branches are this conversation's undo history — switching never deletes anything.
        </p>
        <ul className="max-h-72 space-y-0.5 overflow-y-auto scrollbar-thin">
          {branches.map((branch) => (
            <li key={branch.leafEntryId}>
              <button
                type="button"
                disabled={disabled && !branch.active}
                onClick={() => {
                  setOpen(false)
                  if (!branch.active) onSwitch(branch.leafEntryId)
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                  branch.active
                    ? 'bg-[var(--surface-hover)] text-[var(--text)]'
                    : 'text-[var(--text-soft)] hover:bg-[var(--surface-hover)]'
                }`}
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {branch.active && <CheckIcon className="size-3.5 text-[var(--signal)]" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px] font-medium">
                    {branch.lastMessageSnippet}
                  </span>
                  <span className="block text-[9.5px] text-[var(--text-dim)]">
                    {branch.messageCount} {branch.messageCount === 1 ? 'message' : 'messages'} ·{' '}
                    {clockTime(branch.timestamp)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
