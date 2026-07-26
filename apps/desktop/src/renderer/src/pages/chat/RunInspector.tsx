import {
  CopyPlusIcon,
  FastForwardIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react'
import { type ReactElement, useCallback, useEffect, useState } from 'react'
import type { AgentRunCheckpoint, RuntimeRunInspection } from '../../types'

export function RunInspector({
  conversationId,
  onClose,
}: {
  conversationId: string
  onClose: () => void
}): ReactElement {
  const [runs, setRuns] = useState<AgentRunCheckpoint[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [inspection, setInspection] = useState<RuntimeRunInspection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(
    async (preferredRunId?: string): Promise<void> => {
      const nextRuns = await window.api.runtime.listRuns(conversationId)
      setRuns(nextRuns)
      const runId =
        preferredRunId ??
        (selectedRunId && nextRuns.some((run) => run.identity.runId === selectedRunId)
          ? selectedRunId
          : nextRuns[0]?.identity.runId)
      setSelectedRunId(runId ?? null)
      setInspection(runId ? await window.api.runtime.inspectRun({ conversationId, runId }) : null)
    },
    [conversationId, selectedRunId],
  )

  useEffect(() => {
    setError(null)
    void refresh().catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [refresh])

  const selectRun = useCallback(
    async (runId: string): Promise<void> => {
      setSelectedRunId(runId)
      setError(null)
      try {
        setInspection(await window.api.runtime.inspectRun({ conversationId, runId }))
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [conversationId],
  )

  const control = useCallback(
    async (action: 'step' | 'continue' | 'abort' | 'fork'): Promise<void> => {
      if (!selectedRunId || busy) return
      setBusy(true)
      setError(null)
      const target = { conversationId, runId: selectedRunId }
      try {
        if (action === 'step') {
          await window.api.runtime.stepRun(target)
          await waitForRun(selectedRunId)
        } else if (action === 'continue') {
          await window.api.runtime.continueRun(target)
          await waitForRun(selectedRunId)
        } else if (action === 'abort') {
          await window.api.runtime.abortRun(target)
        } else {
          const forked = await window.api.runtime.forkRun(target)
          await refresh(forked.identity.runId)
          return
        }
        await refresh(selectedRunId)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [busy, conversationId, refresh, selectedRunId],
  )

  const checkpoint = inspection?.checkpoint
  const status = checkpoint?.loop.state.status
  const resumable = status === 'paused' && checkpoint?.recovery.strategy === 'automatic'

  return (
    <section className="shrink-0 border-y border-[#2d3439] bg-[#171b1e] text-[#d9e0e3] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="mx-auto grid max-w-[1080px] grid-cols-[230px_minmax(0,1fr)]">
        <aside className="border-r border-[#2d3439] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#819098]">
              Flight recorder
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              aria-label="Refresh runs"
              className="rounded p-1 text-[#819098] hover:bg-[#262c30] hover:text-white"
            >
              <RefreshCwIcon className="size-3.5" />
            </button>
          </div>
          <div className="flex max-h-52 flex-col gap-1 overflow-y-auto">
            {runs.length === 0 ? (
              <p className="py-6 text-center font-mono text-[11px] text-[#65727a]">
                NO RUNS RECORDED
              </p>
            ) : (
              runs.map((run) => {
                const selected = run.identity.runId === selectedRunId
                return (
                  <button
                    key={run.identity.runId}
                    type="button"
                    onClick={() => void selectRun(run.identity.runId)}
                    className={`group rounded-sm border-l-2 px-2.5 py-2 text-left transition-colors ${
                      selected
                        ? 'border-[#72d6a4] bg-[#242b2e]'
                        : 'border-transparent hover:bg-[#202529]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-[#d9e0e3]">
                        {shortId(run.identity.runId)}
                      </span>
                      <StatusDot status={run.loop.state.status} />
                    </div>
                    <div className="mt-1 font-mono text-[9px] uppercase tracking-wider text-[#718088]">
                      {run.loop.state.status} · {run.loop.state.nextAction?.type ?? 'none'} · r
                      {run.revision}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </aside>

        <div className="min-w-0 p-3">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <PauseIcon className="size-3.5 text-[#72d6a4]" />
                <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.12em]">
                  Run inspector
                </h2>
                {checkpoint && (
                  <span className="rounded-sm bg-[#252c30] px-1.5 py-0.5 font-mono text-[9px] uppercase text-[#91a0a7]">
                    next: {checkpoint.loop.state.nextAction?.type ?? 'none'}
                  </span>
                )}
              </div>
              {checkpoint && (
                <p className="mt-1 font-mono text-[9px] text-[#6f7c83]">
                  turn {shortId(checkpoint.identity.turnId)} / run {checkpoint.identity.runId}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <InspectorButton
                label="Step"
                icon={<PlayIcon className="size-3" />}
                disabled={!resumable || busy}
                onClick={() => void control('step')}
              />
              <InspectorButton
                label="Continue"
                icon={<FastForwardIcon className="size-3" />}
                disabled={!resumable || busy}
                onClick={() => void control('continue')}
              />
              <InspectorButton
                label="Fork"
                icon={<CopyPlusIcon className="size-3" />}
                disabled={!checkpoint || inspection?.active || busy}
                onClick={() => void control('fork')}
              />
              <InspectorButton
                label="Abort"
                icon={<SquareIcon className="size-3" />}
                disabled={!checkpoint || status === 'completed' || status === 'cancelled' || busy}
                onClick={() => void control('abort')}
              />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close run inspector"
                className="ml-1 rounded p-1.5 text-[#718088] hover:bg-[#262c30] hover:text-white"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-2 border-l-2 border-[#e46f67] bg-[#2b2020] px-2.5 py-1.5 font-mono text-[10px] text-[#f0a29c]">
              {error}
            </div>
          )}
          {checkpoint ? (
            <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(220px,0.75fr)] gap-3">
              <div className="min-w-0">
                <InspectorLabel>Step ledger</InspectorLabel>
                <div className="max-h-36 overflow-y-auto border border-[#2b3236] bg-[#121619]">
                  {checkpoint.loop.state.steps.map((step) => (
                    <div
                      key={step.stepId}
                      className="grid grid-cols-[28px_90px_1fr_70px] items-center border-b border-[#23292d] px-2 py-1.5 font-mono text-[10px] last:border-b-0"
                    >
                      <span className="text-[#617078]">{String(step.index).padStart(2, '0')}</span>
                      <span className="text-[#b8c4c9]">{step.kind}</span>
                      <span className="truncate text-[#68767d]">{shortId(step.stepId)}</span>
                      <span className="text-right uppercase text-[#829198]">{step.status}</span>
                    </div>
                  ))}
                  {checkpoint.loop.state.steps.length === 0 && (
                    <div className="px-3 py-5 text-center font-mono text-[10px] text-[#5f6b71]">
                      FORK POINT — NO LOCAL STEPS
                    </div>
                  )}
                </div>
              </div>
              <div>
                <InspectorLabel>Trace inventory</InspectorLabel>
                <div className="grid grid-cols-2 gap-px overflow-hidden border border-[#2b3236] bg-[#2b3236]">
                  <Metric label="events" value={inspection?.events.length ?? 0} />
                  <Metric label="artifacts" value={inspection?.artifacts.length ?? 0} />
                  <Metric label="model calls" value={checkpoint.loop.modelStepIndex} />
                  <Metric label="tool batches" value={checkpoint.loop.completedToolBatches} />
                </div>
                <div className="mt-2 flex items-center justify-between border border-[#2b3236] bg-[#121619] px-2.5 py-2 font-mono text-[9px] uppercase tracking-wider">
                  <span className="text-[#64727a]">recovery</span>
                  <span
                    className={
                      checkpoint.recovery.strategy === 'automatic'
                        ? 'text-[#72d6a4]'
                        : 'text-[#e8b567]'
                    }
                  >
                    {checkpoint.recovery.strategy.replace('_', ' ')}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-10 text-center font-mono text-[10px] uppercase tracking-widest text-[#5f6b71]">
              Select a recorded run
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

async function waitForRun(runId: string): Promise<void> {
  while ((await window.api.runtime.listActiveTurns()).some((turn) => turn.runId === runId)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value
}

function StatusDot({ status }: { status: AgentRunCheckpoint['loop']['state']['status'] }) {
  const color =
    status === 'completed'
      ? 'bg-[#72d6a4]'
      : status === 'failed' || status === 'cancelled'
        ? 'bg-[#e46f67]'
        : status === 'paused'
          ? 'bg-[#e8b567]'
          : 'bg-[#6db6e8]'
  return <span className={`size-1.5 shrink-0 rounded-full ${color}`} title={status} />
}

function InspectorLabel({ children }: { children: string }): ReactElement {
  return (
    <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-[#69777e]">
      {children}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div className="bg-[#121619] px-2.5 py-2">
      <div className="font-mono text-[16px] leading-none text-[#d9e0e3]">
        {String(value).padStart(2, '0')}
      </div>
      <div className="mt-1 font-mono text-[8px] uppercase tracking-wider text-[#64727a]">
        {label}
      </div>
    </div>
  )
}

function InspectorButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string
  icon: ReactElement
  disabled: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-[#30383d] bg-[#20262a] px-2 font-mono text-[9px] uppercase tracking-wide text-[#aebbc1] transition-colors hover:border-[#47535a] hover:bg-[#293034] hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
    >
      {icon}
      {label}
    </button>
  )
}
