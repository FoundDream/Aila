import { BugIcon, CheckIcon, ListChecksIcon, SaveIcon, XIcon } from 'lucide-react'
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AilaExecutionMode,
  ChatAttachmentInput,
  ConversationRecord,
  ConversationSummary,
  ConversationWorkspaceRef,
  PlanArtifact,
  ProviderId,
  Settings,
} from '../../types'
import { Composer } from './Composer'
import { RunInspector } from './RunInspector'
import { Transcript } from './Transcript'
import type { ChatStreamsApi } from './useChatStreams'
import { useModelSelection } from './useModelSelection'

interface ChatPageProps {
  conversation: ConversationRecord | null
  onCreateConversation: (
    workspace?: ConversationWorkspaceRef | null,
  ) => Promise<ConversationSummary>
  streams: ChatStreamsApi
  settings: Settings | null
  configuredProviders: ProviderId[]
  onUpdateSettings: (settings: Settings) => Promise<void>
  onOpenSettings: () => void
  onRunInspectorOpen: () => void
}

export function ChatPage({
  conversation,
  onCreateConversation,
  streams,
  settings,
  configuredProviders,
  onUpdateSettings,
  onOpenSettings,
  onRunInspectorOpen,
}: ChatPageProps): ReactElement {
  const { selection, selectionRef, contextLength, handleSelectionChange } = useModelSelection(
    settings,
    configuredProviders,
    onUpdateSettings,
  )
  const [submitScrollKey, setSubmitScrollKey] = useState(0)
  const [executionMode, setExecutionMode] = useState<AilaExecutionMode>('agent')
  const [stepMode, setStepMode] = useState(false)
  const [showRunInspector, setShowRunInspector] = useState(false)

  const conversationId = conversation?.meta.id ?? null

  // Hydrate on conversation switch. Switching is purely a view change — we do
  // NOT abort the previous conversation's in-flight stream; it keeps running
  // in main and shows up the next time the user navigates back.
  useEffect(() => {
    if (!conversationId) return
    void streams.hydrate(conversationId)
  }, [conversationId, streams])

  const stream = conversationId ? streams.getStream(conversationId) : null
  const messages = stream?.messages ?? []
  const events = stream?.events ?? []
  const plans = stream?.plans ?? []
  const isStreaming = stream?.runningMessageId !== null && stream?.runningMessageId !== undefined
  const usage = stream?.usage ?? null
  const queuedRuns = stream?.queue ?? []
  const queuedCount = queuedRuns.length
  const lastMessage = messages.at(-1)
  const hasRetryableLastTurn =
    lastMessage?.role === 'user' ||
    (lastMessage?.role === 'assistant' && lastMessage.status === 'error')
  const canRetryLast =
    Boolean(conversationId) && !isStreaming && queuedCount === 0 && hasRetryableLastTurn
  const activePlan = useMemo(() => selectActivePlan(plans), [plans])

  const handleSubmit = useCallback(
    async (text: string, attachments: ChatAttachmentInput[]) => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return

      const currentSelection = selectionRef.current
      if (!currentSelection) {
        onOpenSettings()
        return
      }

      let id = conversationId
      if (!id) {
        const summary = await onCreateConversation()
        id = summary.id
        // We just created it — disk is empty. Mark hydrated synchronously so
        // the deferred hydrate effect doesn't race with our enqueueSend.
        streams.markHydrated(id)
      }

      streams.enqueueSend(id, trimmed, currentSelection, attachments, {
        mode: executionMode,
        loopMode: stepMode ? 'step' : 'continuous',
        ...(executionMode === 'plan' && activePlan ? { planId: activePlan.id } : {}),
      })
      setSubmitScrollKey((key) => key + 1)
    },
    [
      activePlan,
      conversationId,
      executionMode,
      onCreateConversation,
      streams,
      onOpenSettings,
      selectionRef,
      stepMode,
    ],
  )

  const handleAbort = useCallback(() => {
    if (!conversationId) return
    streams.abort(conversationId)
  }, [conversationId, streams])

  const handleCompact = useCallback(async (): Promise<{ compacted: boolean }> => {
    if (!conversationId) return { compacted: false }
    if (isStreaming) throw new Error('Wait for the current response before compacting.')
    const currentSelection = selectionRef.current
    if (!currentSelection) {
      onOpenSettings()
      return { compacted: false }
    }
    return streams.compact(conversationId, currentSelection)
  }, [conversationId, isStreaming, streams, onOpenSettings, selectionRef])

  const handleRetryLast = useCallback(() => {
    if (!conversationId) return
    const currentSelection = selectionRef.current
    if (!currentSelection) {
      onOpenSettings()
      return
    }
    streams.enqueueRetryLast(conversationId, currentSelection, {
      mode: executionMode,
      ...(executionMode === 'plan' && activePlan ? { planId: activePlan.id } : {}),
    })
  }, [activePlan, conversationId, executionMode, streams, onOpenSettings, selectionRef])

  const handleSavePlanMarkdown = useCallback(
    async (plan: PlanArtifact, markdown: string): Promise<void> => {
      if (!conversationId) return
      await window.api.runtime.savePlanMarkdown({
        conversationId,
        planId: plan.id,
        markdown,
        expectedRevisionId: plan.latestRevisionId,
      })
      await streams.refreshPlans(conversationId)
    },
    [conversationId, streams],
  )

  const handleApprovePlan = useCallback(
    (plan: PlanArtifact): void => {
      if (!conversationId || isStreaming || queuedCount > 0) return
      const currentSelection = selectionRef.current
      if (!currentSelection) {
        onOpenSettings()
        return
      }
      streams.enqueueApprovePlan(conversationId, plan.id, currentSelection, plan.latestRevisionId)
    },
    [conversationId, isStreaming, queuedCount, streams, onOpenSettings, selectionRef],
  )

  const handleCancelPlan = useCallback(
    async (plan: PlanArtifact): Promise<void> => {
      if (!conversationId) return
      await window.api.runtime.cancelPlan({
        conversationId,
        planId: plan.id,
        reason: 'desktop',
      })
      await streams.refreshPlans(conversationId)
    },
    [conversationId, streams],
  )

  const handleApprovalModeChange = useCallback(
    async (approvalMode: NonNullable<Settings['approvalMode']>) => {
      if (!settings) {
        onOpenSettings()
        return
      }
      await onUpdateSettings({ ...settings, approvalMode })
    },
    [settings, onUpdateSettings, onOpenSettings],
  )

  const toggleRunInspector = useCallback((): void => {
    setShowRunInspector((visible) => {
      if (!visible) onRunInspectorOpen()
      return !visible
    })
  }, [onRunInspectorOpen])

  const composer = (
    <Composer
      isStreaming={isStreaming}
      onSubmit={handleSubmit}
      onCompact={handleCompact}
      onAbort={handleAbort}
      queuedRuns={queuedRuns}
      usage={usage}
      contextLength={contextLength}
      configuredProviders={configuredProviders}
      selection={selection}
      onSelectionChange={handleSelectionChange}
      onOpenSettings={onOpenSettings}
      recentOpenRouterModels={settings?.recentOpenRouterModels ?? []}
      approvalMode={settings?.approvalMode ?? 'safe'}
      onApprovalModeChange={handleApprovalModeChange}
      executionMode={executionMode}
      onExecutionModeChange={setExecutionMode}
    />
  )

  return (
    <div className="flex h-full flex-col text-[var(--text)]">
      <header className="relative flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-5 [-webkit-app-region:drag]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--text-dim)]">
            {conversation?.meta.workspace?.label ?? 'Local'}
          </span>
          <span className="text-[var(--border-strong)]">/</span>
          <span className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.015em] text-[var(--text)]">
            {conversation?.meta.title ?? 'New thread'}
          </span>
        </div>
        {conversationId && (
          <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
            {!showRunInspector && (
              <button
                type="button"
                onClick={() => setStepMode((enabled) => !enabled)}
                className={`h-6 rounded-sm border px-2 font-mono text-[9px] uppercase tracking-wide transition-colors ${
                  stepMode
                    ? 'border-amber-400/50 bg-amber-400/10 text-amber-600'
                    : 'border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--surface-hover)]'
                }`}
                title="Execution mode for the next message"
              >
                {stepMode ? 'Step next run' : 'Continuous next run'}
              </button>
            )}
            <button
              type="button"
              onClick={toggleRunInspector}
              className={`inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 font-mono text-[9px] uppercase tracking-wide transition-colors ${
                showRunInspector
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600'
                  : 'border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--surface-hover)]'
              }`}
            >
              <BugIcon className="size-3" />
              Runs
            </button>
          </div>
        )}
      </header>
      <main className="flex min-h-0 flex-1 overflow-hidden">
        <section className="flex min-w-[340px] flex-1 flex-col overflow-hidden">
          {activePlan && (
            <PlanReviewPanel
              plan={activePlan}
              mode={executionMode}
              busy={isStreaming || queuedCount > 0}
              onSave={handleSavePlanMarkdown}
              onApprove={handleApprovePlan}
              onCancel={handleCancelPlan}
            />
          )}
          {messages.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col justify-center pb-16">
              <div className="mx-auto mb-6 flex w-full max-w-2xl items-end justify-between px-1">
                <div>
                  <div className="mb-3 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--text-dim)]">
                    <span className="size-1.5 rounded-full bg-[var(--signal)] shadow-[0_0_0_4px_var(--signal-glow)]" />
                    Runtime ready
                  </div>
                  <h1 className="font-serif text-[34px] leading-none tracking-[-0.035em] text-[var(--text)]">
                    Start a thread.
                  </h1>
                  <p className="mt-3 max-w-lg text-[13px] leading-relaxed text-[var(--text-soft)]">
                    Describe the outcome. Aila will inspect the workspace, use tools, and keep the
                    run observable.
                  </p>
                </div>
                <span className="pb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--text-dim)]">
                  Local first
                </span>
              </div>
              {composer}
            </div>
          ) : (
            <>
              <Transcript
                messages={messages}
                events={events}
                canRetryLast={canRetryLast}
                onRetryLast={handleRetryLast}
                submitScrollKey={submitScrollKey}
              />
              {composer}
            </>
          )}
        </section>
        {showRunInspector && conversationId && (
          <aside className="flex w-[clamp(560px,58vw,920px)] min-w-[560px] shrink-0 border-l border-[var(--border)] bg-[var(--bg)] shadow-[-16px_0_32px_rgba(36,31,22,0.035)]">
            <RunInspector
              conversationId={conversationId}
              onClose={() => setShowRunInspector(false)}
            />
          </aside>
        )}
      </main>
    </div>
  )
}

const ACTIVE_PLAN_STATUSES = new Set<PlanArtifact['status']>([
  'draft',
  'needs_input',
  'ready',
  'approved',
  'implementing',
])

function selectActivePlan(plans: PlanArtifact[]): PlanArtifact | null {
  return plans.find((plan) => ACTIVE_PLAN_STATUSES.has(plan.status)) ?? plans[0] ?? null
}

function PlanReviewPanel({
  plan,
  mode,
  busy,
  onSave,
  onApprove,
  onCancel,
}: {
  plan: PlanArtifact | null
  mode: AilaExecutionMode
  busy: boolean
  onSave: (plan: PlanArtifact, markdown: string) => Promise<void>
  onApprove: (plan: PlanArtifact) => void
  onCancel: (plan: PlanArtifact) => Promise<void>
}): ReactElement {
  const [draftMarkdown, setDraftMarkdown] = useState(plan?.markdown ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraftMarkdown(plan?.markdown ?? '')
    setError(null)
  }, [plan])

  const dirty = Boolean(plan && draftMarkdown !== plan.markdown)
  const canApprove = Boolean(plan && plan.status === 'ready' && !busy && !saving)
  const canCancel = Boolean(plan && !busy && !saving && plan.status !== 'cancelled')
  const canSave = Boolean(plan && dirty && !busy && !saving)

  const save = useCallback(async (): Promise<void> => {
    if (!plan || !canSave) return
    setSaving(true)
    setError(null)
    try {
      await onSave(plan, draftMarkdown)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [canSave, draftMarkdown, onSave, plan])

  const cancel = useCallback(async (): Promise<void> => {
    if (!plan || !canCancel) return
    setSaving(true)
    setError(null)
    try {
      await onCancel(plan)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [canCancel, onCancel, plan])

  return (
    <section className="shrink-0 border-y border-[var(--border)] bg-[var(--surface)]/88 px-8 py-3">
      <div className="mx-auto flex max-w-[880px] gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2">
            <ListChecksIcon className="size-4 shrink-0 text-[var(--text-soft)]" />
            <h2 className="min-w-0 truncate text-[13px] font-semibold text-[var(--text)]">
              {plan?.title ?? (mode === 'plan' ? 'Planning' : 'Plan')}
            </h2>
            <PlanStatusPill status={plan?.status ?? (mode === 'plan' ? 'draft' : 'cancelled')} />
            {plan?.latestRevisionId && (
              <span className="truncate text-[11px] text-[var(--text-dim)]">
                {plan.latestRevisionId}
              </span>
            )}
          </div>

          {plan ? (
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_260px]">
              <textarea
                value={draftMarkdown}
                onChange={(event) => setDraftMarkdown(event.target.value)}
                spellCheck={false}
                className="h-32 min-h-24 resize-y rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-[12px] leading-5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
              />
              <div className="min-w-0">
                <div className="mb-1.5 text-[11px] font-medium uppercase text-[var(--text-dim)]">
                  Tasks
                </div>
                <div className="flex max-h-32 flex-col gap-1 overflow-y-auto pr-1">
                  {plan.tasks.length === 0 ? (
                    <p className="text-[12px] text-[var(--text-dim)]">No tasks recorded.</p>
                  ) : (
                    plan.tasks.map((task) => (
                      <div key={task.id} className="flex min-w-0 items-start gap-2 text-[12px]">
                        <span className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--text-dim)]" />
                        <div className="min-w-0">
                          <div className="truncate text-[var(--text)]">{task.title}</div>
                          <div className="text-[11px] text-[var(--text-dim)]">{task.status}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-[12.5px] text-[var(--text-soft)]">
              Plan mode is active for the next prompt.
            </p>
          )}

          {error && <p className="mt-2 text-[12px] text-[var(--error)]">{error}</p>}
        </div>

        {plan && (
          <div className="flex shrink-0 flex-col gap-1.5">
            <PlanActionButton
              icon={<SaveIcon className="size-3.5" />}
              label={saving ? 'Saving' : 'Save'}
              disabled={!canSave}
              onClick={save}
            />
            <PlanActionButton
              icon={<CheckIcon className="size-3.5" />}
              label="Approve"
              disabled={!canApprove}
              onClick={() => onApprove(plan)}
            />
            <PlanActionButton
              icon={<XIcon className="size-3.5" />}
              label="Cancel"
              disabled={!canCancel}
              onClick={cancel}
            />
          </div>
        )}
      </div>
    </section>
  )
}

function PlanStatusPill({ status }: { status: PlanArtifact['status'] }): ReactElement {
  const tone =
    status === 'ready'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : status === 'implementing' || status === 'approved'
        ? 'border-blue-200 bg-blue-50 text-blue-700'
        : status === 'cancelled' || status === 'superseded'
          ? 'border-[var(--border)] bg-[var(--bg-soft)] text-[var(--text-dim)]'
          : 'border-amber-200 bg-amber-50 text-amber-700'

  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {status.replaceAll('_', ' ')}
    </span>
  )
}

function PlanActionButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: ReactElement
  label: string
  disabled: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[12px] font-medium text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-45"
    >
      {icon}
      {label}
    </button>
  )
}
