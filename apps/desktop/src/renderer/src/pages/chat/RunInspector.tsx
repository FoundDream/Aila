import {
  BracesIcon,
  ChevronRightIcon,
  CopyPlusIcon,
  FastForwardIcon,
  PlayIcon,
  RefreshCwIcon,
  RouteIcon,
  SquareIcon,
} from 'lucide-react'
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  RunArtifact,
  RuntimeRunArtifactDescriptor,
  RuntimeRunInspection,
  RuntimeRunSummary,
} from '../../types'

type DetailTab = 'overview' | 'trace' | 'events' | 'raw'
type TraceFilter = 'all' | 'model' | 'tools'
type InspectionScope =
  | { type: 'run'; runId: string }
  | { type: 'step'; runId: string; stepId: string }
type RunInspectionEvent = RuntimeRunInspection['events'][number]

const TRACE_KINDS = new Set([
  'model_request',
  'model_response',
  'model_call',
  'tool_request',
  'tool_result',
  'tool_batch',
])
const MODEL_KINDS = new Set(['model_request', 'model_response', 'model_call'])
const TOOL_KINDS = new Set(['tool_request', 'tool_result', 'tool_batch'])

export function RunInspector({ conversationId }: { conversationId: string }): ReactElement {
  const [runs, setRuns] = useState<RuntimeRunSummary[]>([])
  const [scope, setScopeState] = useState<InspectionScope | null>(null)
  const scopeRef = useRef<InspectionScope | null>(null)
  const [inspection, setInspection] = useState<RuntimeRunInspection | null>(null)
  const [artifactCache, setArtifactCache] = useState<Record<string, RunArtifact>>({})
  const [tab, setTab] = useState<DetailTab>('trace')
  const [traceFilter, setTraceFilter] = useState<TraceFilter>('all')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const setScope = useCallback((next: InspectionScope | null): void => {
    scopeRef.current = next
    setScopeState(next)
  }, [])

  const refresh = useCallback(
    async (preferredScope?: InspectionScope | null): Promise<void> => {
      const nextRuns = await window.api.runtime.listRunSummaries(conversationId)
      const requestedScope = preferredScope === undefined ? scopeRef.current : preferredScope
      const requested = requestedScope?.runId
      const runId =
        requested && nextRuns.some((run) => run.identity.runId === requested)
          ? requested
          : (nextRuns[0]?.identity.runId ?? null)
      const nextInspection = runId
        ? await window.api.runtime.inspectRun({ conversationId, runId })
        : null
      const requestedStepIsValid =
        requestedScope?.type === 'step' &&
        requestedScope.runId === runId &&
        nextInspection?.checkpoint.loop.state.steps.some(
          (step) => step.stepId === requestedScope.stepId,
        )
      const nextScope: InspectionScope | null = runId
        ? requestedStepIsValid
          ? requestedScope
          : { type: 'run', runId }
        : null
      setRuns(nextRuns)
      setScope(nextScope)
      setInspection(nextInspection)
      setLoading(false)
    },
    [conversationId, setScope],
  )

  useEffect(() => {
    setArtifactCache({})
    setScope(null)
    setTab('trace')
    setTraceFilter('all')
    setError(null)
    setLoading(true)
    void refresh(null).catch((reason) => {
      setLoading(false)
      setError(errorText(reason))
    })
  }, [refresh, setScope])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    return window.api.runtime.onRunEvent((event) => {
      if (event.conversationId !== conversationId) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void refresh().catch((reason) => setError(errorText(reason)))
      }, 90)
    })
  }, [conversationId, refresh])

  const selectedRunId = scope?.runId ?? null
  const selectedStepId = scope?.type === 'step' ? scope.stepId : null

  const scopedDescriptors = useMemo(
    () =>
      inspection?.artifacts.filter(
        (artifact) => !selectedStepId || artifact.stepId === selectedStepId,
      ) ?? [],
    [inspection, selectedStepId],
  )
  const traceDescriptors = useMemo(
    () => artifactsForTrace(scopedDescriptors, traceFilter),
    [scopedDescriptors, traceFilter],
  )
  const descriptorsToLoad =
    tab === 'events' ? [] : tab === 'trace' ? traceDescriptors : scopedDescriptors

  useEffect(() => {
    if (!selectedRunId || tab === 'events' || descriptorsToLoad.length === 0) {
      return
    }
    const missing = descriptorsToLoad.filter((artifact) => !artifactCache[artifact.artifactId])
    if (missing.length === 0) return
    let cancelled = false
    void Promise.all(
      missing.map((artifact) =>
        window.api.runtime.getRunArtifact({
          conversationId,
          runId: selectedRunId,
          artifactId: artifact.artifactId,
        }),
      ),
    )
      .then((loaded) => {
        if (cancelled) return
        setArtifactCache((current) => {
          const next = { ...current }
          for (const artifact of loaded) next[artifact.artifactId] = artifact
          return next
        })
      })
      .catch((reason) => {
        if (!cancelled) setError(errorText(reason))
      })
    return () => {
      cancelled = true
    }
  }, [artifactCache, conversationId, descriptorsToLoad, selectedRunId, tab])

  const selectRun = useCallback(
    async (runId: string): Promise<void> => {
      const sameRun = runId === scopeRef.current?.runId
      setScope({ type: 'run', runId })
      setArtifactCache({})
      setTab('trace')
      setTraceFilter('all')
      if (sameRun) return
      setLoading(true)
      setError(null)
      setInspection(null)
      try {
        setInspection(await window.api.runtime.inspectRun({ conversationId, runId }))
      } catch (reason) {
        setError(errorText(reason))
      } finally {
        setLoading(false)
      }
    },
    [conversationId, setScope],
  )

  const selectStep = useCallback(
    (stepId: string): void => {
      const runId = scopeRef.current?.runId
      if (!runId) return
      setScope({ type: 'step', runId, stepId })
      setTab('trace')
      setTraceFilter('all')
    },
    [setScope],
  )

  const control = useCallback(
    async (action: 'step' | 'continue' | 'abort' | 'fork'): Promise<void> => {
      const currentScope = scopeRef.current
      const runId = currentScope?.runId
      if (!runId || busy) return
      setBusy(true)
      setError(null)
      const target = { conversationId, runId }
      try {
        if (action === 'step') await window.api.runtime.stepRun(target)
        else if (action === 'continue') await window.api.runtime.continueRun(target)
        else if (action === 'abort') await window.api.runtime.abortRun(target)
        else {
          const forked = await window.api.runtime.forkRun({
            ...target,
            ...(currentScope.type === 'step' ? { originStepId: currentScope.stepId } : {}),
          })
          setArtifactCache({})
          setTab('trace')
          setTraceFilter('all')
          await refresh({ type: 'run', runId: forked.identity.runId })
          return
        }
        await refresh()
      } catch (reason) {
        setError(errorText(reason))
      } finally {
        setBusy(false)
      }
    },
    [busy, conversationId, refresh],
  )

  const checkpoint = inspection?.checkpoint
  const selectedStep = checkpoint?.loop.state.steps.find((step) => step.stepId === selectedStepId)
  const controls = inspection?.allowedControls
  const events =
    inspection?.events.filter((event) => !selectedStepId || event.stepId === selectedStepId) ?? []
  const selectedRunIndex = runs.findIndex((run) => run.identity.runId === selectedRunId)
  const selectedRunLabel =
    selectedRunIndex >= 0 ? `Run ${runs.length - selectedRunIndex}` : 'Run debugger'
  const traceCount = scopedDescriptors.filter((artifact) => TRACE_KINDS.has(artifact.kind)).length
  const hasResumeControls = Boolean(controls?.step || controls?.continue)

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg)]"
      aria-label="Agent run debugger"
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--bg)] px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <RouteIcon className="size-3.5 shrink-0 text-[var(--signal)]" />
          <h2 className="truncate text-[13px] font-semibold tracking-[-0.01em]">
            {selectedStep
              ? stepRailTitle(selectedStep, inspection?.artifacts ?? [])
              : selectedRunLabel}
          </h2>
          {checkpoint && <StatusBadge status={checkpoint.loop.state.status} />}
          {selectedStep && (
            <span className="truncate font-mono text-[9px] text-[var(--text-dim)]">
              {shortId(selectedStep.stepId)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {controls?.step && (
            <ControlButton
              label="Step"
              icon={<PlayIcon className="size-3.5" />}
              disabled={busy}
              onClick={() => void control('step')}
            />
          )}
          {controls?.continue && (
            <ControlButton
              label="Continue"
              icon={<FastForwardIcon className="size-3.5" />}
              disabled={busy}
              onClick={() => void control('continue')}
              primary
            />
          )}
          {controls?.fork && !hasResumeControls && (
            <ControlButton
              label={scope?.type === 'step' ? 'Replay from here' : 'Replay run'}
              icon={<CopyPlusIcon className="size-3.5" />}
              disabled={busy}
              onClick={() => void control('fork')}
            />
          )}
          {controls?.abort && (
            <ControlButton
              label="Abort"
              icon={<SquareIcon className="size-3" />}
              disabled={busy}
              onClick={() => void control('abort')}
              danger
            />
          )}
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          <IconButton label="Refresh runs" onClick={() => void refresh()}>
            <RefreshCwIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          </IconButton>
        </div>
      </header>

      {error && (
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--error-border)] bg-[var(--error-soft)] px-5 py-2 text-[12px] text-[var(--error)]">
          <span className="truncate">{error}</span>
          <button type="button" onClick={() => setError(null)} className="ml-4 font-medium">
            Dismiss
          </button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[clamp(210px,25%,270px)_minmax(0,1fr)] overflow-hidden">
        <aside className="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
          <ExecutionTree
            runs={runs}
            inspection={inspection}
            scope={scope}
            onSelectRun={selectRun}
            onSelectStep={selectStep}
          />
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--bg)]">
          <DetailTabs
            selected={tab}
            traceCount={traceCount}
            eventCount={events.length}
            onSelect={setTab}
          />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 scrollbar-thin">
            <div className="mx-auto w-full max-w-[1080px]">
              {loading && !inspection ? (
                <EmptyState title="Loading run history" detail="Reading durable execution state…" />
              ) : !checkpoint ? (
                <EmptyState
                  title="No runs yet"
                  detail="Send a message to create the first recorded run."
                />
              ) : (
                <DetailView
                  tab={tab}
                  scope={scope}
                  inspection={inspection}
                  selectedStep={selectedStep}
                  scopedDescriptors={scopedDescriptors}
                  traceDescriptors={traceDescriptors}
                  artifacts={artifactCache}
                  events={events}
                  traceFilter={traceFilter}
                  onTraceFilterChange={setTraceFilter}
                />
              )}
            </div>
          </div>
        </main>
      </div>
    </section>
  )
}

function ExecutionTree({
  runs,
  inspection,
  scope,
  onSelectRun,
  onSelectStep,
}: {
  runs: RuntimeRunSummary[]
  inspection: RuntimeRunInspection | null
  scope: InspectionScope | null
  onSelectRun: (runId: string) => Promise<void>
  onSelectStep: (stepId: string) => void
}): ReactElement {
  const steps = inspection?.checkpoint.loop.state.steps ?? []
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Trace" count={steps.length} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin">
        {runs.length === 0 ? (
          <EmptyRail label="No recorded runs" />
        ) : (
          <div className="space-y-0.5">
            {runs.map((run, index) => {
              const expanded = run.identity.runId === scope?.runId
              const selected = expanded && scope?.type === 'run'
              return (
                <div key={run.identity.runId}>
                  <button
                    type="button"
                    onClick={() => void onSelectRun(run.identity.runId)}
                    className={`group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                      selected
                        ? 'bg-[var(--surface-hover)] text-[var(--text)]'
                        : expanded
                          ? 'text-[var(--text)]'
                          : 'text-[var(--text-soft)] hover:bg-[var(--surface-hover)]'
                    }`}
                  >
                    <ChevronRightIcon
                      className={`size-3 shrink-0 text-[var(--text-dim)] transition-transform ${
                        expanded ? 'rotate-90' : ''
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[12.5px] font-medium">
                          Run {runs.length - index}
                        </span>
                        <StatusBadge status={run.status} />
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[var(--text-dim)]">
                        <span className="truncate">{actionLabel(run.nextAction)}</span>
                        <span className="shrink-0 font-mono">{formatTimestamp(run.updatedAt)}</span>
                      </div>
                    </div>
                  </button>

                  {expanded && (
                    <div className="ml-4 border-l border-[var(--border-strong)] py-1 pl-2">
                      {steps.length === 0 ? (
                        <p className="px-2.5 py-2 text-[10.5px] text-[var(--text-dim)]">
                          No steps in this run
                        </p>
                      ) : (
                        steps.map((step) => {
                          const stepSelected =
                            scope?.type === 'step' && step.stepId === scope.stepId
                          const duration =
                            step.completedAt === undefined
                              ? null
                              : Math.max(0, step.completedAt - step.startedAt)
                          return (
                            <button
                              key={step.stepId}
                              type="button"
                              onClick={() => onSelectStep(step.stepId)}
                              className={`flex w-full items-center gap-2.5 rounded-md border px-2 py-1.5 text-left transition-colors ${
                                stepSelected
                                  ? 'border-[var(--border-strong)] bg-[var(--bg)] text-[var(--text)]'
                                  : 'border-transparent text-[var(--text-soft)] hover:bg-[var(--surface-hover)]'
                              }`}
                            >
                              <StepDot status={step.status} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate text-[11.5px] font-medium">
                                    {stepRailTitle(step, inspection?.artifacts ?? [])}
                                  </span>
                                  <span className="shrink-0 font-mono text-[9.5px] text-[var(--text-dim)]">
                                    {duration === null ? 'Live' : formatDuration(duration)}
                                  </span>
                                </div>
                                <p className="mt-0.5 truncate text-[9.5px] text-[var(--text-dim)]">
                                  Step {step.index + 1} · {titleCase(step.status)}
                                </p>
                              </div>
                            </button>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

function DetailTabs({
  selected,
  traceCount,
  eventCount,
  onSelect,
}: {
  selected: DetailTab
  traceCount: number
  eventCount: number
  onSelect: (tab: DetailTab) => void
}): ReactElement {
  const tabs: Array<{ id: DetailTab; label: string; count?: number }> = [
    { id: 'overview', label: 'Metadata' },
    { id: 'trace', label: 'Input / Output', count: traceCount },
    { id: 'events', label: 'Events', count: eventCount },
    { id: 'raw', label: 'Raw' },
  ]
  return (
    <nav className="flex h-10 shrink-0 items-end gap-5 border-b border-[var(--border)] bg-[var(--bg)] px-4">
      {tabs.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          className={`relative flex h-10 items-center gap-1.5 text-[11.5px] font-medium transition-colors ${
            item.id === 'events' ? 'ml-auto' : ''
          } ${
            selected === item.id
              ? 'text-[var(--text)]'
              : 'text-[var(--text-dim)] hover:text-[var(--text-soft)]'
          }`}
        >
          {item.label}
          {item.count !== undefined && (
            <span className="font-mono text-[9px] text-[var(--text-dim)]">{item.count}</span>
          )}
          {selected === item.id && (
            <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[var(--signal)]" />
          )}
        </button>
      ))}
    </nav>
  )
}

function DetailView({
  tab,
  scope,
  inspection,
  selectedStep,
  scopedDescriptors,
  traceDescriptors,
  artifacts,
  events,
  traceFilter,
  onTraceFilterChange,
}: {
  tab: DetailTab
  scope: InspectionScope | null
  inspection: RuntimeRunInspection
  selectedStep: RuntimeRunInspection['checkpoint']['loop']['state']['steps'][number] | undefined
  scopedDescriptors: RuntimeRunArtifactDescriptor[]
  traceDescriptors: RuntimeRunArtifactDescriptor[]
  artifacts: Record<string, RunArtifact>
  events: RunInspectionEvent[]
  traceFilter: TraceFilter
  onTraceFilterChange: (filter: TraceFilter) => void
}): ReactElement {
  if (tab === 'overview') {
    return (
      <Overview
        inspection={inspection}
        selectedStep={selectedStep}
        events={events}
        descriptors={scopedDescriptors}
        artifacts={artifacts}
      />
    )
  }
  if (tab === 'events') return <EventList events={events} scope={scope} />
  if (tab === 'raw') {
    const rawArtifacts = scopedDescriptors.map(
      (descriptor) => artifacts[descriptor.artifactId] ?? descriptor,
    )
    return (
      <JsonDocument
        title={scope?.type === 'step' ? `Step data · ${shortId(scope.stepId)}` : 'Run data'}
        value={
          scope?.type === 'step'
            ? { scope, step: selectedStep, events, artifacts: rawArtifacts }
            : { scope, checkpoint: inspection.checkpoint, events, artifacts: rawArtifacts }
        }
      />
    )
  }
  const filterCounts: Record<TraceFilter, number> = {
    all: artifactsForTrace(scopedDescriptors, 'all').length,
    model: artifactsForTrace(scopedDescriptors, 'model').length,
    tools: artifactsForTrace(scopedDescriptors, 'tools').length,
  }
  return (
    <>
      <TraceFilterBar
        selected={traceFilter}
        counts={filterCounts}
        scope={scope}
        onSelect={onTraceFilterChange}
      />
      {traceDescriptors.length === 0 ? (
        <EmptyState
          title={`No ${traceFilter === 'all' ? 'trace' : traceFilter} activity`}
          detail="This scope did not produce a matching artifact."
        />
      ) : (
        <ArtifactChain descriptors={traceDescriptors} artifacts={artifacts} />
      )}
    </>
  )
}

function TraceFilterBar({
  selected,
  counts,
  scope,
  onSelect,
}: {
  selected: TraceFilter
  counts: Record<TraceFilter, number>
  scope: InspectionScope | null
  onSelect: (filter: TraceFilter) => void
}): ReactElement {
  const filters: Array<{ id: TraceFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'model', label: 'Model' },
    { id: 'tools', label: 'Tools' },
  ]
  return (
    <div className="mb-5 flex items-center justify-between gap-4">
      <p className="text-[11px] text-[var(--text-dim)]">
        {scope?.type === 'step' ? 'Selected step trace' : 'Entire run trace'}
      </p>
      <div className="flex rounded-lg bg-[var(--bg-soft)] p-0.5">
        {filters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => onSelect(filter.id)}
            className={`rounded-md px-2.5 py-1 text-[10.5px] font-medium transition-colors ${
              selected === filter.id
                ? 'bg-[var(--surface)] text-[var(--text)] shadow-[0_1px_3px_rgba(0,0,0,0.06)]'
                : 'text-[var(--text-dim)] hover:text-[var(--text-soft)]'
            }`}
          >
            {filter.label}
            <span className="ml-1.5 font-mono text-[9px] opacity-65">{counts[filter.id]}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ArtifactChain({
  descriptors,
  artifacts,
}: {
  descriptors: RuntimeRunArtifactDescriptor[]
  artifacts: Record<string, RunArtifact>
}): ReactElement {
  const ordered = [...descriptors].sort(compareArtifactDescriptors)
  return (
    <div className="relative space-y-5 pb-4">
      <div className="absolute bottom-8 left-[13px] top-8 w-px bg-[var(--border-strong)]" />
      {ordered.map((descriptor, index) => {
        const artifact = artifacts[descriptor.artifactId]
        const stage = artifactStage(descriptor.kind)
        return (
          <section
            key={descriptor.artifactId}
            className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3"
          >
            <div className="relative z-10 mt-0.5 grid size-7 place-items-center rounded-full border border-[var(--border-strong)] bg-[var(--surface)] font-mono text-[9.5px] font-medium text-[var(--text-soft)]">
              {index + 1}
            </div>
            <div className="min-w-0">
              <div className="mb-2.5 flex items-center gap-2">
                <span className="text-[12px] font-semibold text-[var(--text)]">{stage.label}</span>
                <span className="text-[10.5px] text-[var(--text-dim)]">{stage.detail}</span>
                <span className="ml-auto text-[10px] text-[var(--text-dim)]">
                  {formatTimestamp(descriptor.createdAt)}
                </span>
              </div>
              {artifact ? (
                <ArtifactDocument artifact={artifact} flat />
              ) : (
                <ArtifactSkeleton descriptor={descriptor} />
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function Overview({
  inspection,
  selectedStep,
  events,
  descriptors,
  artifacts,
}: {
  inspection: RuntimeRunInspection
  selectedStep: RuntimeRunInspection['checkpoint']['loop']['state']['steps'][number] | undefined
  events: RunInspectionEvent[]
  descriptors: RuntimeRunArtifactDescriptor[]
  artifacts: Record<string, RunArtifact>
}): ReactElement {
  const checkpoint = inspection.checkpoint
  const state = checkpoint.loop.state
  const usage = artifactTokenUsage(descriptors, artifacts)
  const duration = selectedStep
    ? Math.max(0, (selectedStep.completedAt ?? Date.now()) - selectedStep.startedAt)
    : runDuration(checkpoint)
  const metrics: Array<{ label: string; value: string | number }> = selectedStep
    ? [
        { label: 'Duration', value: formatDuration(duration) },
        { label: 'Input tokens', value: formatTokenCount(usage.inputTokens) },
        { label: 'Output tokens', value: formatTokenCount(usage.outputTokens) },
        { label: 'Outcome', value: titleCase(selectedStep.status) },
      ]
    : [
        { label: 'Duration', value: formatDuration(duration) },
        {
          label: 'Model calls',
          value: state.steps.filter((step) => step.kind === 'model').length,
        },
        {
          label: 'Tool calls',
          value: descriptors.filter((artifact) => artifact.kind === 'tool_request').length,
        },
        {
          label: 'Total tokens',
          value: formatTokenCount(checkpoint.usage?.totalTokens),
        },
      ]
  return (
    <div>
      <section>
        <p className="text-[11.5px] font-medium text-[var(--text-dim)]">
          {selectedStep ? 'Selected step' : 'Current run'}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <h3 className="text-[21px] font-semibold tracking-[-0.025em] text-[var(--text)]">
            {selectedStep
              ? stepTitle(selectedStep.kind)
              : runHeadline(state.status, state.nextAction?.type)}
          </h3>
          {selectedStep && <StepStatusBadge status={selectedStep.status} />}
        </div>
        <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-[var(--text-dim)]">
          {selectedStep
            ? `Attempt ${selectedStep.attempt} · ${shortId(selectedStep.stepId)}`
            : 'Durable execution state, model activity, and tool calls for this conversation.'}
        </p>
      </section>

      <div className="mt-5 grid grid-cols-4 border-y border-[var(--border)]">
        {metrics.map((metric) => (
          <Metric key={metric.label} label={metric.label} value={metric.value} />
        ))}
      </div>

      <section className="grid grid-cols-2 border-b border-[var(--border)] py-5">
        <div className="pr-6">
          <h4 className="mb-3 text-[12.5px] font-semibold text-[var(--text)]">
            {selectedStep ? 'Step' : 'Execution'}
          </h4>
          <DefinitionList
            rows={
              selectedStep
                ? [
                    ['Step', shortId(selectedStep.stepId)],
                    ['Kind', stepTitle(selectedStep.kind)],
                    ['Status', titleCase(selectedStep.status)],
                    ['Attempt', String(selectedStep.attempt)],
                    ['Started', formatTimestamp(selectedStep.startedAt)],
                    ['Events', String(events.length)],
                  ]
                : [
                    ['Run', shortId(checkpoint.identity.runId)],
                    ['Turn', shortId(checkpoint.identity.turnId)],
                    ['Mode', titleCase(state.mode)],
                    ['Next action', actionLabel(state.nextAction)],
                    ['Wait reason', state.wait ? waitLabel(state.wait.reason) : 'None'],
                    ['Steps', String(state.steps.length)],
                  ]
            }
          />
        </div>
        <div className="border-l border-[var(--border)] pl-6">
          <h4 className="mb-3 text-[12.5px] font-semibold text-[var(--text)]">Checkpoint</h4>
          <DefinitionList
            rows={[
              ['Revision', String(checkpoint.revision)],
              ['Schema', String(checkpoint.schemaVersion)],
              ['Updated', formatTimestamp(checkpoint.updatedAt)],
              [
                'Recovery',
                checkpoint.recovery.reason ??
                  (checkpoint.recovery.strategy === 'automatic' ? 'Automatic' : 'Manual review'),
              ],
              ['Artifacts', String(descriptors.length)],
              ['Run', shortId(checkpoint.identity.runId)],
            ]}
          />
        </div>
      </section>

      <section className="pt-5">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[13px] font-semibold text-[var(--text)]">Recorded artifacts</h4>
          <span className="text-[11px] text-[var(--text-dim)]">
            {descriptors.length} {descriptors.length === 1 ? 'item' : 'items'}
          </span>
        </div>
        {descriptors.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--border-strong)] px-4 py-8 text-center text-[12px] text-[var(--text-dim)]">
            No artifacts for this step.
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
            {descriptors.map((artifact) => (
              <div
                key={artifact.artifactId}
                className="grid grid-cols-[minmax(0,1fr)_110px_70px] items-center gap-4 px-1 py-2.5"
              >
                <span className="truncate text-[12px] font-medium text-[var(--text-soft)]">
                  {artifact.label}
                </span>
                <span className="truncate font-mono text-[10px] text-[var(--text-dim)]">
                  {shortId(artifact.artifactId)}
                </span>
                <span className="text-right font-mono text-[10px] text-[var(--text-dim)]">
                  {formatBytes(artifact.size)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function ArtifactDocument({
  artifact,
  flat = false,
}: {
  artifact: RunArtifact
  flat?: boolean
}): ReactElement {
  const data = asRecord(artifact.data)
  if (artifact.kind === 'model_request') {
    const descriptor = asRecord(data?.descriptor)
    const messages = Array.isArray(data?.messages) ? data.messages : []
    const tools = Array.isArray(data?.tools) ? data.tools : []
    return (
      <ArtifactFrame artifact={artifact} flat={flat}>
        <div className="mb-4 flex flex-wrap gap-1.5">
          <Chip label="Provider" value={stringValue(descriptor?.provider)} />
          <Chip label="Model" value={stringValue(descriptor?.modelId)} />
          <Chip label="Reason" value={stringValue(data?.reason)} />
          <Chip label="Tools" value={String(tools.length)} />
        </div>
        <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
          {withStableOccurrenceKeys(messages).map(({ key, value: message }, index) => {
            const record = asRecord(message)
            const role = stringValue(record?.role)
            return (
              <MessageBlock
                key={key}
                role={role || `Message ${index + 1}`}
                content={renderValue(record?.content)}
              />
            )
          })}
        </div>
      </ArtifactFrame>
    )
  }
  if (artifact.kind === 'model_response') {
    const usage = modelResponseTokenUsage(data)
    return (
      <ArtifactFrame artifact={artifact} flat={flat}>
        <div className="mb-4 flex flex-wrap gap-1.5">
          <Chip label="Outcome" value={stringValue(data?.outcome)} />
          <Chip label="Duration" value={formatDuration(numberValue(data?.durationMs))} />
          <Chip
            label="Tool calls"
            value={String(Array.isArray(data?.toolCalls) ? data.toolCalls.length : 0)}
          />
          {usage.inputTokens !== undefined && (
            <Chip label="Input" value={formatTokenCount(usage.inputTokens)} />
          )}
          {usage.outputTokens !== undefined && (
            <Chip label="Output" value={formatTokenCount(usage.outputTokens)} />
          )}
        </div>
        {stringValue(data?.reasoning) && (
          <TextBlock label="Reasoning" text={stringValue(data?.reasoning)} muted />
        )}
        <TextBlock label="Response" text={stringValue(data?.text) || 'No text response.'} />
        {Array.isArray(data?.toolCalls) && data.toolCalls.length > 0 && (
          <JsonDocument title="Tool calls" value={data.toolCalls} compact />
        )}
      </ArtifactFrame>
    )
  }
  if (artifact.kind === 'tool_request' || artifact.kind === 'tool_result') {
    const outcome = stringValue(data?.outcome)
    return (
      <ArtifactFrame artifact={artifact} flat={flat}>
        <div className="mb-4 flex flex-wrap gap-1.5">
          <Chip label="Tool" value={stringValue(data?.toolName)} />
          {outcome && <Chip label="Outcome" value={outcome} />}
          {numberValue(data?.durationMs) > 0 && (
            <Chip label="Duration" value={formatDuration(numberValue(data?.durationMs))} />
          )}
        </div>
        {'args' in (data ?? {}) && <JsonDocument title="Arguments" value={data?.args} compact />}
        {stringValue(data?.output) && <TextBlock label="Output" text={stringValue(data?.output)} />}
        {stringValue(data?.error) && (
          <TextBlock label="Error" text={stringValue(data?.error)} tone="error" />
        )}
      </ArtifactFrame>
    )
  }
  return (
    <ArtifactFrame artifact={artifact} flat={flat}>
      <JsonDocument title="Payload" value={artifact.data} compact />
    </ArtifactFrame>
  )
}

function MessageBlock({ role, content }: { role: string; content: string }): ReactElement {
  const label = titleCase(role)
  if (role === 'system') {
    return (
      <details className="group py-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[10.5px] font-medium text-[var(--text-dim)] marker:hidden">
          <span>{label}</span>
          <span className="font-mono text-[9px] font-normal">
            {formatCharacterCount(content.length)} · click to expand
          </span>
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-soft)] p-3 font-mono text-[11px] leading-relaxed text-[var(--text-soft)]">
          {content}
        </pre>
      </details>
    )
  }
  return (
    <section className="py-3">
      <div className="mb-2 text-[10.5px] font-medium text-[var(--text-dim)]">{label}</div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-soft)] p-3 font-mono text-[11px] leading-relaxed text-[var(--text-soft)]">
        {content}
      </pre>
    </section>
  )
}

function ArtifactFrame({
  artifact,
  children,
  flat = false,
}: {
  artifact: RunArtifact
  children: ReactNode
  flat?: boolean
}): ReactElement {
  if (flat) {
    return (
      <section className="border border-[var(--border)] bg-[var(--bg-soft)] p-4">
        {children}
      </section>
    )
  }
  return (
    <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-soft)]">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-[var(--text)]">
            {artifactTitle(artifact.kind)}
          </h3>
          <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-dim)]">
            {shortId(artifact.artifactId)}
          </p>
        </div>
        <span className="shrink-0 text-[10.5px] text-[var(--text-dim)]">
          {formatTimestamp(artifact.createdAt)}
        </span>
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

function EventList({
  events,
  scope,
}: {
  events: RunInspectionEvent[]
  scope: InspectionScope | null
}): ReactElement {
  if (events.length === 0) {
    return (
      <EmptyState title="No matching events" detail="Select another step or wait for activity." />
    )
  }
  return (
    <>
      <div className="mb-3 flex items-center justify-between text-[11px] text-[var(--text-dim)]">
        <span>{scope?.type === 'step' ? 'Selected step events' : 'Entire run events'}</span>
        <span>{events.length} recorded</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--textarea)]">
        {events.map((event) => (
          <div
            key={event.eventId ?? `${event.seq}-${event.timestamp}-${event.type}`}
            className="grid grid-cols-[52px_76px_190px_minmax(0,1fr)] gap-3 border-b border-[var(--border)] px-3.5 py-2.5 last:border-b-0"
          >
            <span className="font-mono text-[10px] text-[var(--text-dim)]">
              {event.seq === undefined ? '—' : `#${String(event.seq).padStart(4, '0')}`}
            </span>
            <span className="font-mono text-[10px] text-[var(--text-dim)]">
              {formatTimestamp(event.timestamp)}
            </span>
            <span className="truncate font-mono text-[10.5px] text-[var(--text-soft)]">
              {event.type}
            </span>
            <span
              className="truncate font-mono text-[10px] text-[var(--text-dim)]"
              title={event.data ? renderValue(event.data) : undefined}
            >
              {event.data ? renderValue(event.data) : '—'}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

function JsonDocument({
  title,
  value,
  compact = false,
}: {
  title: string
  value: unknown
  compact?: boolean
}): ReactElement {
  return (
    <section
      className={`overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] ${
        compact ? 'mt-3' : ''
      }`}
    >
      <div className="border-b border-[var(--border)] px-3 py-2 text-[11px] font-medium text-[var(--text-soft)]">
        {title}
      </div>
      <pre
        className={`overflow-auto whitespace-pre-wrap break-words p-3.5 font-mono text-[10.5px] leading-relaxed text-[var(--text-soft)] ${
          compact ? 'max-h-80' : 'max-h-[62vh]'
        }`}
      >
        {prettyJson(value)}
      </pre>
    </section>
  )
}

function TextBlock({
  label,
  text,
  muted = false,
  tone,
}: {
  label: string
  text: string
  muted?: boolean
  tone?: 'error'
}): ReactElement {
  return (
    <section className="mb-3 last:mb-0">
      <div className="mb-1.5 text-[10.5px] font-medium text-[var(--text-dim)]">{label}</div>
      <div
        className={`whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-soft)] p-3.5 text-[12.5px] leading-relaxed ${
          tone === 'error'
            ? 'text-[var(--error)]'
            : muted
              ? 'text-[var(--text-dim)]'
              : 'text-[var(--text)]'
        }`}
      >
        {text}
      </div>
    </section>
  )
}

function PanelHeader({ title, count }: { title: string; count: number }): ReactElement {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between px-4">
      <h3 className="text-[11.5px] font-semibold text-[var(--text-soft)]">{title}</h3>
      <span className="rounded-full bg-[var(--surface-hover)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-dim)]">
        {count}
      </span>
    </div>
  )
}

function StatusBadge({ status }: { status: RuntimeRunSummary['status'] }): ReactElement {
  const styles =
    status === 'completed'
      ? 'bg-[var(--success-soft)] text-[var(--success)]'
      : status === 'failed' || status === 'cancelled'
        ? 'bg-[var(--error-soft)] text-[var(--error)]'
        : status === 'paused'
          ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
          : 'bg-[var(--signal-soft)] text-[var(--blue)]'
  return (
    <span
      className={`inline-flex w-fit rounded-full px-2 py-0.5 text-[9.5px] font-medium ${styles}`}
    >
      {status === 'paused' ? 'Waiting' : titleCase(status)}
    </span>
  )
}

function StepStatusBadge({
  status,
}: {
  status: RuntimeRunInspection['checkpoint']['loop']['state']['steps'][number]['status']
}): ReactElement {
  return (
    <span className="rounded-full bg-[var(--bg-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-soft)]">
      {titleCase(status)}
    </span>
  )
}

function StepDot({
  status,
}: {
  status: RuntimeRunInspection['checkpoint']['loop']['state']['steps'][number]['status']
}): ReactElement {
  const color =
    status === 'completed'
      ? 'bg-[var(--success)]'
      : status === 'running'
        ? 'animate-pulse bg-[var(--signal)]'
        : status === 'failed'
          ? 'bg-[var(--error)]'
          : 'bg-[var(--warning)]'
  return <span className={`size-2 shrink-0 rounded-full ${color}`} />
}

function ControlButton({
  label,
  icon,
  disabled,
  onClick,
  primary = false,
  danger = false,
}: {
  label: string
  icon: ReactElement
  disabled: boolean
  onClick: () => void
  primary?: boolean
  danger?: boolean
}): ReactElement {
  const style = primary
    ? 'border-[var(--signal)] bg-[var(--signal)] text-white hover:brightness-110'
    : danger
      ? 'border-[var(--border)] bg-transparent text-[var(--text-soft)] hover:border-[var(--error-border)] hover:bg-[var(--error-soft)] hover:text-[var(--error)]'
      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-soft)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]'
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-35 ${style}`}
    >
      {icon}
      {label}
    </button>
  )
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactElement
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
    >
      {children}
    </button>
  )
}

function Metric({ label, value }: { label: string; value: string | number }): ReactElement {
  return (
    <div className="border-r border-[var(--border)] px-4 py-3 last:border-r-0">
      <div className="text-[20px] font-semibold tracking-[-0.03em] text-[var(--text)]">{value}</div>
      <div className="mt-0.5 text-[10.5px] text-[var(--text-dim)]">{label}</div>
    </div>
  )
}

function DefinitionList({ rows }: { rows: Array<[string, string]> }): ReactElement {
  return (
    <dl className="space-y-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-4 text-[11.5px]">
          <dt className="shrink-0 text-[var(--text-dim)]">{label}</dt>
          <dd className="truncate font-mono text-[10.5px] text-[var(--text-soft)]" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Chip({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--bg-soft)] px-2.5 py-1 text-[10.5px]">
      <span className="mr-1.5 text-[var(--text-dim)]">{label}</span>
      <span className="font-medium text-[var(--text-soft)]">{value || '—'}</span>
    </span>
  )
}

function ArtifactSkeleton({
  descriptor,
}: {
  descriptor: RuntimeRunArtifactDescriptor
}): ReactElement {
  return (
    <div className="animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="h-3 w-32 rounded bg-[var(--surface-hover)]" />
      <div className="mt-4 h-24 rounded-md bg-[var(--bg-soft)]" />
      <span className="sr-only">Loading {descriptor.label}</span>
    </div>
  )
}

function EmptyRail({ label }: { label: string }): ReactElement {
  return (
    <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-[var(--border-strong)] text-[11px] text-[var(--text-dim)]">
      {label}
    </div>
  )
}

function EmptyState({ title, detail }: { title: string; detail: string }): ReactElement {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface)] px-6 text-center">
      <span className="mb-3 grid size-9 place-items-center rounded-md bg-[var(--bg-soft)] text-[var(--text-dim)]">
        <BracesIcon className="size-4" />
      </span>
      <p className="text-[13px] font-semibold text-[var(--text)]">{title}</p>
      <p className="mt-1 max-w-sm text-[11.5px] text-[var(--text-dim)]">{detail}</p>
    </div>
  )
}

function artifactsForTrace(
  artifacts: RuntimeRunArtifactDescriptor[],
  filter: TraceFilter,
): RuntimeRunArtifactDescriptor[] {
  const kinds = filter === 'model' ? MODEL_KINDS : filter === 'tools' ? TOOL_KINDS : TRACE_KINDS
  return artifacts.filter((artifact) => kinds.has(artifact.kind)).sort(compareArtifactDescriptors)
}

function compareArtifactDescriptors(
  left: RuntimeRunArtifactDescriptor,
  right: RuntimeRunArtifactDescriptor,
): number {
  const timestampOrder = left.createdAt - right.createdAt
  if (timestampOrder !== 0) return timestampOrder
  return artifactKindOrder(left.kind) - artifactKindOrder(right.kind)
}

function artifactKindOrder(kind: RunArtifact['kind']): number {
  if (kind === 'model_request' || kind === 'tool_request') return 0
  if (kind === 'model_call') return 1
  if (kind === 'model_response' || kind === 'tool_result') return 2
  if (kind === 'tool_batch') return 3
  return 4
}

function artifactStage(kind: RunArtifact['kind']): { label: string; detail: string } {
  if (kind === 'model_request') return { label: 'Input', detail: 'Sent to the model' }
  if (kind === 'model_response') return { label: 'Output', detail: 'Returned by the model' }
  if (kind === 'tool_request') return { label: 'Tool input', detail: 'Arguments and target' }
  if (kind === 'tool_result') return { label: 'Tool output', detail: 'Result returned to the loop' }
  if (kind === 'tool_batch') return { label: 'Batch summary', detail: 'Tool step outcome' }
  return { label: 'Exchange', detail: 'Legacy model call' }
}

function actionLabel(
  action:
    | RuntimeRunInspection['checkpoint']['loop']['state']['nextAction']
    | RuntimeRunSummary['nextAction'],
): string {
  if (!action) return 'Finished'
  if (action.type === 'model') return `Model · ${titleCase(action.reason)}`
  if (action.type === 'tools')
    return `${action.toolCallIds.length} pending ${action.toolCallIds.length === 1 ? 'tool' : 'tools'}`
  return `Compact · ${titleCase(action.reason)}`
}

function runHeadline(
  status: RuntimeRunSummary['status'],
  action: 'model' | 'tools' | 'compact' | undefined,
): string {
  if (status === 'completed') return 'Run completed'
  if (status === 'failed') return 'Run failed'
  if (status === 'cancelled') return 'Run cancelled'
  if (status === 'paused') return 'Waiting to continue'
  return action === 'tools' ? 'Running tools' : 'Model is working'
}

function artifactTitle(kind: RunArtifact['kind']): string {
  if (kind === 'model_request') return 'Model request'
  if (kind === 'model_response') return 'Model response'
  if (kind === 'tool_request') return 'Tool request'
  if (kind === 'tool_result') return 'Tool result'
  if (kind === 'tool_batch') return 'Tool batch'
  if (kind === 'model_call') return 'Legacy model call'
  if (kind === 'compaction') return 'Context compaction'
  return 'Debug data'
}

function stepTitle(kind: string): string {
  if (kind === 'model') return 'Model call'
  if (kind === 'tool_batch') return 'Tool batch'
  if (kind === 'compact') return 'Context compaction'
  return titleCase(kind)
}

function stepRailTitle(
  step: RuntimeRunInspection['checkpoint']['loop']['state']['steps'][number],
  descriptors: RuntimeRunArtifactDescriptor[],
): string {
  if (step.kind !== 'tool_batch') return stepTitle(step.kind)
  const tools = descriptors
    .filter((artifact) => artifact.stepId === step.stepId && artifact.kind === 'tool_request')
    .map((artifact) => artifact.label.replace(/^Tool request · ?/, ''))
  if (tools.length === 0) return 'Tool batch'
  return tools.length === 1 ? tools[0] : `${tools[0]} +${tools.length - 1}`
}

function waitLabel(reason: string): string {
  if (reason === 'user_input') return 'User input'
  if (reason === 'approval') return 'Approval'
  return 'Debugger'
}

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function withStableOccurrenceKeys(values: unknown[]): Array<{ key: string; value: unknown }> {
  const occurrences = new Map<string, number>()
  return values.map((value) => {
    const serialized = JSON.stringify(value) ?? String(value)
    const occurrence = (occurrences.get(serialized) ?? 0) + 1
    occurrences.set(serialized, occurrence)
    return { key: `${serialized}:${occurrence}`, value }
  })
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function modelResponseTokenUsage(data: Record<string, unknown> | undefined): {
  inputTokens?: number
  outputTokens?: number
} {
  const totalUsage = asRecord(data?.totalUsage)
  const directInput = optionalNumberValue(totalUsage?.inputTokens)
  const directOutput = optionalNumberValue(totalUsage?.outputTokens)
  if (directInput !== undefined || directOutput !== undefined) {
    return { inputTokens: directInput, outputTokens: directOutput }
  }
  const stepUsage = Array.isArray(data?.stepUsage) ? data.stepUsage : []
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  for (const item of stepUsage) {
    const usage = asRecord(item)
    const input = optionalNumberValue(usage?.inputTokens)
    const output = optionalNumberValue(usage?.outputTokens)
    if (input !== undefined) inputTokens = (inputTokens ?? 0) + input
    if (output !== undefined) outputTokens = (outputTokens ?? 0) + output
  }
  return { inputTokens, outputTokens }
}

function artifactTokenUsage(
  descriptors: RuntimeRunArtifactDescriptor[],
  artifacts: Record<string, RunArtifact>,
): { inputTokens?: number; outputTokens?: number } {
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'model_response') continue
    const artifact = artifacts[descriptor.artifactId]
    if (!artifact) continue
    const usage = modelResponseTokenUsage(asRecord(artifact.data))
    if (usage.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + usage.inputTokens
    if (usage.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + usage.outputTokens
  }
  return { inputTokens, outputTokens }
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  return prettyJson(value)
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatDuration(duration: number): string {
  if (!Number.isFinite(duration) || duration <= 0) return '0 ms'
  if (duration < 1000) return `${Math.round(duration)} ms`
  return `${(duration / 1000).toFixed(duration < 10_000 ? 2 : 1)} s`
}

function runDuration(checkpoint: RuntimeRunInspection['checkpoint']): number {
  const state = checkpoint.loop.state
  const startedAt = state.startedAt ?? checkpoint.createdAt
  const completedAt = state.completedAt ?? checkpoint.updatedAt
  return Math.max(0, completedAt - startedAt)
}

function formatTokenCount(value: number | undefined): string {
  if (value === undefined) return '—'
  return Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? 'compact' : 'standard',
  }).format(value)
}

function formatCharacterCount(value: number): string {
  if (value < 1000) return `${value} chars`
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k chars`
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
