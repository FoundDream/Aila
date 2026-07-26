import { AlertTriangleIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import type { ReactElement } from 'react'
import type { ToolApprovalRequestEvent } from '../types'

interface Props {
  request: ToolApprovalRequestEvent | null
  pendingCount?: number
  onResolve: (requestId: string, approved: boolean) => void
}

function previewArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args, null, 2)
  return text.length > 1800 ? `${text.slice(0, 1800)}\n...` : text
}

function riskSummary(request: ToolApprovalRequestEvent): string {
  if (request.metadata.access.includes('shell')) return 'Runs a shell command'
  if (request.metadata.destructive) return 'Can overwrite workspace files'
  if (request.metadata.access.includes('write')) return 'Can write workspace data'
  if (request.metadata.scope.includes('external')) return 'Touches external services'
  return 'Requires explicit approval'
}

export function ToolApprovalDialog({ request, pendingCount = 0, onResolve }: Props): ReactElement {
  const open = request !== null

  const resolve = (approved: boolean): void => {
    if (!request) return
    onResolve(request.requestId, approved)
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && request) resolve(false)
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[900] bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed top-1/2 left-1/2 z-[1000] w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          {request && (
            <>
              <div className="mb-4 flex items-center gap-2">
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-amber-100 text-amber-700">
                  <AlertTriangleIcon className="size-4" />
                </span>
                <div className="min-w-0">
                  <DialogPrimitive.Title className="truncate text-[15px] font-semibold text-[var(--text)]">
                    Approve {request.name}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="mt-0.5 text-[12px] text-[var(--text-dim)]">
                    Pending approval · {request ? riskSummary(request) : 'Review requested action'}
                  </DialogPrimitive.Description>
                </div>
              </div>

              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700">
                  pending
                </span>
                {request.metadata.destructive && (
                  <span className="rounded-md bg-red-100 px-2 py-0.5 text-[11px] text-red-700">
                    destructive
                  </span>
                )}
                {request.metadata.access.map((item) => (
                  <span
                    key={item}
                    className="rounded-md bg-[var(--bg-soft)] px-2 py-0.5 text-[11px] text-[var(--text-dim)]"
                  >
                    {item}
                  </span>
                ))}
                {request.metadata.scope.map((item) => (
                  <span
                    key={item}
                    className="rounded-md bg-[var(--bg-soft)] px-2 py-0.5 text-[11px] text-[var(--text-dim)]"
                  >
                    {item}
                  </span>
                ))}
                {request.toolCallId && (
                  <span className="rounded-md bg-[var(--bg-soft)] px-2 py-0.5 text-[11px] text-[var(--text-dim)]">
                    {request.toolCallId}
                  </span>
                )}
                {pendingCount > 1 && (
                  <span className="rounded-md bg-[var(--bg-soft)] px-2 py-0.5 text-[11px] text-[var(--text-dim)]">
                    {pendingCount} pending
                  </span>
                )}
              </div>

              <pre className="max-h-[280px] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] p-3 text-[11px] leading-5 whitespace-pre-wrap text-[var(--text)]">
                {previewArgs(request.args)}
              </pre>

              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => resolve(false)}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px] hover:bg-[var(--surface-hover)]"
                >
                  Deny
                </button>
                <button
                  type="button"
                  onClick={() => resolve(true)}
                  className="rounded-md bg-[var(--brand-ink)] px-3 py-1.5 text-[12px] text-[var(--brand-ink-fg)] transition-colors hover:opacity-90"
                >
                  Approve
                </button>
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
