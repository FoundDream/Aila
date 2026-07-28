import {
  ChevronDownIcon,
  DownloadIcon,
  FastForwardIcon,
  FoldVerticalIcon,
  PlayIcon,
  SparklesIcon,
  SquareIcon,
  WrenchIcon,
} from 'lucide-react'
import type { ReactElement } from 'react'
import type { RunPayload, RuntimeRunInspection, RuntimeRunPayloadDescriptor } from '../../types'
import {
  byPayloadOrder,
  byteSize,
  clockTime,
  describeNextAction,
  describeWait,
  elapsed,
  payloadName,
  pluckNumber,
  pluckRecord,
  pluckString,
  type RunStepState,
  readableEnum,
  stepHeading,
  TONE_CHIP_CLASS,
  TONE_DOT_CLASS,
  toDisplayText,
  toJsonText,
  tokenCount,
  toneForStatus,
  truncatedId,
} from './debugFormat'
import type { PlaygroundRunControls } from './playgroundState'

type RunInspectionEvent = RuntimeRunInspection['events'][number]

interface ExecutionTimelineProps {
  inspection: RuntimeRunInspection
  runLabel?: string
  /** Embedded mode drops the outer width constraint for use inside a card. */
  embedded?: boolean
  controls: PlaygroundRunControls
  expandedStepIds: string[]
  payloads: Record<string, RunPayload>
  payloadErrors: Record<string, string>
  onToggleStep: (stepId: string) => void
  onLoadPayload: (payloadId: string) => void
  onStep: () => void
  onContinue: () => void
  onAbort: () => void
  autoLoadMaxBytes: number
}

/**
 * The debug canvas: one vertical pass over the run. Every step is a card that
 * expands in place to show its payloads and events; the run's pause point sits
 * at the bottom with the resume controls, so "where it stopped" and "what to do
 * next" are the same spot on screen.
 */
export function ExecutionTimeline({
  inspection,
  runLabel,
  embedded = false,
  controls,
  expandedStepIds,
  payloads,
  payloadErrors,
  onToggleStep,
  onLoadPayload,
  onStep,
  onContinue,
  onAbort,
  autoLoadMaxBytes,
}: ExecutionTimelineProps): ReactElement {
  const snapshot = inspection.snapshot
  const state = snapshot.loop.state
  const expanded = new Set(expandedStepIds)
  const runEvents = inspection.events.filter((event) => !event.stepId)

  return (
    <div className={embedded ? 'w-full pb-2' : 'mx-auto w-full max-w-[880px] pb-6'}>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--border)] pb-3 text-[10.5px] text-[var(--text-dim)]">
        {runLabel && (
          <span className="text-[12px] font-semibold text-[var(--text)]">{runLabel}</span>
        )}
        <MetaItem label="run" value={truncatedId(snapshot.identity.runId)} mono />
        <MetaItem label="mode" value={state.mode} />
        <MetaItem label="revision" value={String(snapshot.revision)} mono />
        <MetaItem label="tokens" value={tokenCount(snapshot.usage?.totalTokens)} mono />
        <MetaItem label="updated" value={clockTime(snapshot.updatedAt)} mono />
      </div>

      <ol>
        {state.steps.map((step, index) => (
          <StepCard
            key={step.stepId}
            step={step}
            ordinal={index + 1}
            expanded={expanded.has(step.stepId)}
            descriptors={inspection.payloads}
            events={inspection.events}
            payloads={payloads}
            payloadErrors={payloadErrors}
            onToggle={() => onToggleStep(step.stepId)}
            onLoadPayload={onLoadPayload}
            autoLoadMaxBytes={autoLoadMaxBytes}
          />
        ))}
      </ol>

      <OutcomeCard
        inspection={inspection}
        controls={controls}
        runEvents={runEvents}
        onStep={onStep}
        onContinue={onContinue}
        onAbort={onAbort}
      />
    </div>
  )
}

function MetaItem({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}): ReactElement {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <span className={`text-[var(--text-soft)] ${mono ? 'font-mono text-[10px]' : ''}`}>
        {value}
      </span>
    </span>
  )
}

const STEP_ICON: Record<RunStepState['kind'], typeof SparklesIcon> = {
  model: SparklesIcon,
  tool: WrenchIcon,
  tool_batch: WrenchIcon,
  compact: FoldVerticalIcon,
}

function StepCard({
  step,
  ordinal,
  expanded,
  descriptors,
  events,
  payloads,
  payloadErrors,
  onToggle,
  onLoadPayload,
  autoLoadMaxBytes,
}: {
  step: RunStepState
  ordinal: number
  expanded: boolean
  descriptors: readonly RuntimeRunPayloadDescriptor[]
  events: readonly RunInspectionEvent[]
  payloads: Record<string, RunPayload>
  payloadErrors: Record<string, string>
  onToggle: () => void
  onLoadPayload: (payloadId: string) => void
  autoLoadMaxBytes: number
}): ReactElement {
  const Icon = STEP_ICON[step.kind] ?? SparklesIcon
  const tone = toneForStatus(step.status)
  const stepDescriptors = descriptors
    .filter((descriptor) => descriptor.stepId === step.stepId)
    .sort(byPayloadOrder)
  const stepEvents = events.filter((event) => event.stepId === step.stepId)

  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-3">
      <div className="flex flex-col items-center">
        <span
          className={`z-10 grid size-8 shrink-0 place-items-center rounded-lg border bg-[var(--surface)] ${
            expanded
              ? 'border-[var(--border-strong)] text-[var(--text)]'
              : 'border-[var(--border)] text-[var(--text-dim)]'
          }`}
        >
          <Icon className="size-3.5" />
        </span>
        <span className="w-px flex-1 bg-[var(--border)]" />
      </div>

      <div className="min-w-0 pb-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
        >
          <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--text)]">
            <span className="mr-1.5 font-mono text-[10px] text-[var(--text-dim)]">{ordinal}</span>
            {stepHeading(step, descriptors)}
          </span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[9.5px] font-medium ${TONE_CHIP_CLASS[tone]}`}
          >
            {readableEnum(step.status)}
          </span>
          {step.attempt > 1 && (
            <span className="shrink-0 rounded-full bg-[var(--bg-soft)] px-1.5 py-0.5 text-[9px] text-[var(--text-dim)]">
              attempt {step.attempt}
            </span>
          )}
          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-[var(--text-dim)]">
            {step.completedAt === undefined ? 'live' : elapsed(step.completedAt - step.startedAt)}
          </span>
          <ChevronDownIcon
            className={`size-3.5 shrink-0 text-[var(--text-dim)] transition-transform ${
              expanded ? '' : '-rotate-90'
            }`}
          />
        </button>

        {expanded && (
          <div className="mt-1 space-y-2.5 pl-2">
            {step.error && (
              <p className="rounded-lg bg-[var(--error-soft)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--error)]">
                {step.error}
              </p>
            )}
            {stepDescriptors.length === 0 && !step.error && (
              <p className="px-1 text-[11px] text-[var(--text-dim)]">
                No payloads recorded for this step.
              </p>
            )}
            {stepDescriptors.map((descriptor) => (
              <PayloadSection
                key={descriptor.payloadId}
                descriptor={descriptor}
                payload={payloads[descriptor.payloadId]}
                error={payloadErrors[descriptor.payloadId]}
                onLoad={() => onLoadPayload(descriptor.payloadId)}
                autoLoadMaxBytes={autoLoadMaxBytes}
              />
            ))}
            {stepEvents.length > 0 && (
              <details className="rounded-lg border border-[var(--border)]">
                <summary className="cursor-pointer list-none px-3 py-2 text-[10.5px] font-medium text-[var(--text-dim)] hover:text-[var(--text-soft)]">
                  {stepEvents.length} {stepEvents.length === 1 ? 'event' : 'events'}
                </summary>
                <EventRows events={stepEvents} />
              </details>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

function PayloadSection({
  descriptor,
  payload,
  error,
  onLoad,
  autoLoadMaxBytes,
}: {
  descriptor: RuntimeRunPayloadDescriptor
  payload: RunPayload | undefined
  error: string | undefined
  onLoad: () => void
  autoLoadMaxBytes: number
}): ReactElement {
  return (
    <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-soft)]">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
        <span className="text-[10.5px] font-semibold text-[var(--text-soft)]">
          {payloadName(descriptor.kind)}
        </span>
        <span className="min-w-0 truncate text-[10px] text-[var(--text-dim)]">
          {descriptor.label}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[9.5px] text-[var(--text-dim)]">
          {byteSize(descriptor.size)}
        </span>
      </header>
      <div className="p-3">
        {payload ? (
          <PayloadContent payload={payload} />
        ) : error ? (
          <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--error)]">
            <span className="min-w-0 truncate">{error}</span>
            <button type="button" onClick={onLoad} className="shrink-0 font-medium underline">
              Retry
            </button>
          </div>
        ) : descriptor.size > autoLoadMaxBytes ? (
          <button
            type="button"
            onClick={onLoad}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-soft)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
          >
            <DownloadIcon className="size-3" />
            Load {byteSize(descriptor.size)}
          </button>
        ) : (
          <div className="h-10 animate-pulse rounded-md bg-[var(--surface)]" />
        )}
      </div>
    </section>
  )
}

function PayloadContent({ payload }: { payload: RunPayload }): ReactElement {
  const data = pluckRecord(payload.data)
  if (payload.contentType === 'text/plain' || !data) {
    return <CodeBlock text={toDisplayText(payload.data)} />
  }
  switch (payload.kind) {
    case 'model_request': {
      const descriptor = pluckRecord(data.descriptor)
      const messages = Array.isArray(data.messages) ? data.messages : []
      return (
        <div className="space-y-2">
          <FactRow
            facts={[
              ['provider', pluckString(descriptor?.provider)],
              ['model', pluckString(descriptor?.modelId)],
              ['reason', pluckString(data.reason)],
              ['messages', String(messages.length)],
              ['tools', String(Array.isArray(data.tools) ? data.tools.length : 0)],
            ]}
          />
          <MessageTranscript payloadId={payload.payloadId} messages={messages} />
        </div>
      )
    }
    case 'model_response': {
      const toolCalls = Array.isArray(data.toolCalls) ? data.toolCalls : []
      const reasoning = pluckString(data.reasoning)
      const durationMs = pluckNumber(data.durationMs)
      return (
        <div className="space-y-2">
          <FactRow
            facts={[
              ['outcome', pluckString(data.outcome)],
              ['duration', durationMs === undefined ? '' : elapsed(durationMs)],
              ['tool calls', String(toolCalls.length)],
            ]}
          />
          {reasoning && (
            <details>
              <summary className="cursor-pointer list-none text-[10.5px] font-medium text-[var(--text-dim)] hover:text-[var(--text-soft)]">
                Reasoning ({reasoning.length} chars)
              </summary>
              <Prose text={reasoning} muted />
            </details>
          )}
          <Prose text={pluckString(data.text) || 'No text response.'} />
          {toolCalls.length > 0 && <CodeBlock label="Tool calls" text={toJsonText(toolCalls)} />}
        </div>
      )
    }
    case 'tool_request':
      return (
        <div className="space-y-2">
          <FactRow facts={[['tool', pluckString(data.toolName)]]} />
          <CodeBlock text={toJsonText('args' in data ? data.args : data)} />
        </div>
      )
    case 'tool_result': {
      const output = pluckString(data.output)
      const failure = pluckString(data.error)
      return (
        <div className="space-y-2">
          <FactRow
            facts={[
              ['tool', pluckString(data.toolName)],
              ['outcome', pluckString(data.outcome)],
            ]}
          />
          {output && <Prose text={output} />}
          {failure && <Prose text={failure} tone="error" />}
          {!output && !failure && <CodeBlock text={toJsonText(payload.data)} />}
        </div>
      )
    }
    default:
      return <CodeBlock text={toJsonText(payload.data)} />
  }
}

/**
 * Collapsed by default to the tail of the conversation; the full request is one
 * click away. System prompts stay behind their own toggle even when unrolled.
 */
function MessageTranscript({
  payloadId,
  messages,
}: {
  payloadId: string
  messages: unknown[]
}): ReactElement {
  const TAIL = 3
  const tail = messages.slice(-TAIL)
  const hidden = messages.length - tail.length
  const render = (message: unknown, index: number): ReactElement => {
    const record = pluckRecord(message)
    const role = pluckString(record?.role) || 'message'
    const content = toDisplayText(record?.content)
    return (
      <div
        key={`${payloadId}-${index}`}
        className="border-t border-[var(--border)] py-2 first:border-t-0 first:pt-0 last:pb-0"
      >
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
          {role}
        </div>
        {role === 'system' ? (
          <details>
            <summary className="cursor-pointer list-none text-[10.5px] text-[var(--text-dim)] hover:text-[var(--text-soft)]">
              {content.length} chars — expand
            </summary>
            <CodeBlock text={content} />
          </details>
        ) : (
          <Prose text={content} />
        )}
      </div>
    )
  }
  return (
    <div>
      {hidden > 0 && (
        <details>
          <summary className="mb-2 cursor-pointer list-none text-[10.5px] font-medium text-[var(--text-dim)] hover:text-[var(--text-soft)]">
            Show {hidden} earlier {hidden === 1 ? 'message' : 'messages'}
          </summary>
          <div>{messages.slice(0, hidden).map(render)}</div>
        </details>
      )}
      <div>{tail.map((message, index) => render(message, hidden + index))}</div>
    </div>
  )
}

function OutcomeCard({
  inspection,
  controls,
  runEvents,
  onStep,
  onContinue,
  onAbort,
}: {
  inspection: RuntimeRunInspection
  controls: PlaygroundRunControls
  runEvents: RunInspectionEvent[]
  onStep: () => void
  onContinue: () => void
  onAbort: () => void
}): ReactElement {
  const snapshot = inspection.snapshot
  const state = snapshot.loop.state
  const tone = toneForStatus(state.status)
  const manualReview = snapshot.recovery.strategy === 'manual_review'

  const headline =
    state.status === 'paused'
      ? `Paused — next: ${describeNextAction(state.nextAction)}`
      : state.status === 'running'
        ? `Running — ${describeNextAction(state.nextAction)}`
        : `Run ${state.status}`
  const showResume = state.status === 'paused' && !manualReview && !controls.leafMismatch

  return (
    <section className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-3">
      <div className="flex justify-center">
        <span className="grid size-8 place-items-center rounded-lg border border-[var(--border-strong)] bg-[var(--surface)]">
          <span className={`size-2 rounded-full ${TONE_DOT_CLASS[tone]}`} />
        </span>
      </div>
      <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] font-semibold text-[var(--text)]">{headline}</span>
          {state.wait && (
            <span className="rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-[9.5px] font-medium text-[var(--warning)]">
              {describeWait(state.wait.reason)}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {showResume && (
              <>
                <OutcomeButton
                  icon={<PlayIcon className="size-3.5" />}
                  label="Step"
                  disabled={!controls.step}
                  onClick={onStep}
                />
                <OutcomeButton
                  icon={<FastForwardIcon className="size-3.5" />}
                  label="Continue"
                  disabled={!controls.continue}
                  onClick={onContinue}
                  primary
                />
              </>
            )}
            {controls.abort && (
              <OutcomeButton
                icon={<SquareIcon className="size-3" />}
                label="Abort"
                disabled={false}
                onClick={onAbort}
                danger
              />
            )}
          </div>
        </div>
        {state.error && (
          <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--error)]">{state.error}</p>
        )}
        {manualReview && (
          <p className="mt-2 rounded-md bg-[var(--warning-soft)] px-2.5 py-1.5 text-[11px] leading-relaxed text-[var(--warning)]">
            {snapshot.recovery.reason ??
              'The process stopped while a tool was executing; review side effects before resuming.'}
          </p>
        )}
        {controls.leafMismatch && (
          <p className="mt-2 rounded-md bg-[var(--warning-soft)] px-2.5 py-1.5 text-[11px] leading-relaxed text-[var(--warning)]">
            This run was recorded on a session branch that is no longer current — the conversation
            moved on (new turn, retry, compaction or branch navigation). It stays inspectable, but
            resuming it would write onto the wrong branch, so Step and Continue are unavailable.
          </p>
        )}
        {runEvents.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer list-none text-[10.5px] font-medium text-[var(--text-dim)] hover:text-[var(--text-soft)]">
              {runEvents.length} run-level {runEvents.length === 1 ? 'event' : 'events'}
            </summary>
            <div className="mt-1 overflow-hidden rounded-md border border-[var(--border)]">
              <EventRows events={runEvents} />
            </div>
          </details>
        )}
      </div>
    </section>
  )
}

function OutcomeButton({
  icon,
  label,
  disabled,
  onClick,
  primary = false,
  danger = false,
}: {
  icon: ReactElement
  label: string
  disabled: boolean
  onClick: () => void
  primary?: boolean
  danger?: boolean
}): ReactElement {
  const style = primary
    ? 'border-[var(--signal)] bg-[var(--signal)] text-white hover:brightness-110'
    : danger
      ? 'border-[var(--border)] text-[var(--text-soft)] hover:border-[var(--error-border)] hover:bg-[var(--error-soft)] hover:text-[var(--error)]'
      : 'border-[var(--border)] bg-[var(--bg)] text-[var(--text-soft)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-35 ${style}`}
    >
      {icon}
      {label}
    </button>
  )
}

function EventRows({ events }: { events: readonly RunInspectionEvent[] }): ReactElement {
  return (
    <div className="border-t border-[var(--border)] bg-[var(--textarea)]">
      {events.map((event) => (
        <div
          key={event.eventId ?? `${event.seq}-${event.timestamp}-${event.type}`}
          className="grid grid-cols-[44px_68px_minmax(0,1fr)] gap-2 border-b border-[var(--border)] px-3 py-1.5 last:border-b-0"
        >
          <span className="font-mono text-[9.5px] text-[var(--text-dim)]">
            {event.seq === undefined ? '—' : `#${event.seq}`}
          </span>
          <span className="font-mono text-[9.5px] text-[var(--text-dim)]">
            {clockTime(event.timestamp)}
          </span>
          <span
            className="truncate font-mono text-[10px] text-[var(--text-soft)]"
            title={event.data ? toDisplayText(event.data) : undefined}
          >
            {event.type}
            {event.data ? ` ${toDisplayText(event.data)}` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

function FactRow({ facts }: { facts: Array<[string, string]> }): ReactElement {
  const visible = facts.filter(([, value]) => value.length > 0)
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px]">
      {visible.map(([label, value]) => (
        <span key={label} className="inline-flex items-center gap-1">
          <span className="text-[var(--text-dim)]">{label}</span>
          <span className="font-medium text-[var(--text-soft)]">{value}</span>
        </span>
      ))}
    </div>
  )
}

function Prose({
  text,
  muted = false,
  tone,
}: {
  text: string
  muted?: boolean
  tone?: 'error'
}): ReactElement {
  return (
    <div
      className={`max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface)] px-2.5 py-2 text-[12px] leading-relaxed scrollbar-thin ${
        tone === 'error'
          ? 'text-[var(--error)]'
          : muted
            ? 'text-[var(--text-dim)]'
            : 'text-[var(--text)]'
      }`}
    >
      {text}
    </div>
  )
}

function CodeBlock({ label, text }: { label?: string; text: string }): ReactElement {
  return (
    <div className="overflow-hidden rounded-md bg-[var(--surface)]">
      {label && (
        <div className="border-b border-[var(--border)] px-2.5 py-1.5 text-[10px] font-medium text-[var(--text-dim)]">
          {label}
        </div>
      )}
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-[var(--text-soft)] scrollbar-thin">
        {text}
      </pre>
    </div>
  )
}
