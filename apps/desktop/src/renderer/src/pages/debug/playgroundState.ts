import type {
  ChatMessage,
  PersistedMessage,
  RunPayload,
  RuntimeRunInspection,
  RuntimeRunSummary,
  RuntimeSessionAvailability,
  SessionTree,
} from '../../types'

export type SessionTreeEntry = SessionTree['nodes'][number]['entry']
export type PlaygroundLoopMode = 'step' | 'continuous'
export type InjectedContextMode = 'default' | 'override' | 'cleared'
export type MessageRole = 'user' | 'assistant'

export interface InjectedContextState {
  mode: InjectedContextMode
  messages: ChatMessage[]
}

/**
 * Pure state for the playground debug canvas. The transcript is derived from
 * the session tree's active branch; runs and inspections attach to it lazily.
 * IPC effects live in usePlayground.
 */
export interface PlaygroundState {
  conversationId: string | null
  tree: SessionTree | null
  /** Engine-derived availability snapshot; null until first load. */
  availability: RuntimeSessionAvailability | null
  runs: RuntimeRunSummary[]
  /** Learned runId → assistantMessageId linkage, filled by inspections. */
  runMessageIds: Record<string, string>
  /** Inspections cached by runId while their traces are expanded. */
  inspections: Record<string, RuntimeRunInspection>
  /** Message ids (or 'active') whose inline trace is open. */
  expandedTraceKeys: string[]
  /** Per-run open step cards; newly appearing steps auto-expand. */
  expandedStepIds: Record<string, string[]>
  payloads: Record<string, RunPayload>
  payloadErrors: Record<string, string>
  /** At most one card in edit mode. */
  draft: { entryId: string; text: string } | null
  /** Fabricate-at-leaf editor. */
  insertDraft: { role: MessageRole; text: string } | null
  injected: InjectedContextState
  loopMode: PlaygroundLoopMode
  /** A navigate/append structural operation is in flight. */
  structuralBusy: boolean
  /** retryLast fired; cleared on the first observed run event. */
  launchingRun: boolean
  loading: boolean
  error: string | null
}

export type PlaygroundAction =
  | { type: 'reset'; conversationId: string | null }
  | { type: 'refresh_started' }
  | { type: 'refresh_loaded'; tree: SessionTree | null; runs: RuntimeRunSummary[] }
  | { type: 'refresh_failed'; error: string }
  | { type: 'availability_loaded'; availability: RuntimeSessionAvailability }
  | { type: 'inspection_loaded'; inspection: RuntimeRunInspection }
  | { type: 'inspection_failed'; error: string }
  | { type: 'toggle_trace'; key: string }
  | { type: 'toggle_step'; runId: string; stepId: string }
  | { type: 'payload_loaded'; payload: RunPayload }
  | { type: 'payload_failed'; payloadId: string; error: string }
  | { type: 'draft_started'; entryId: string; text: string }
  | { type: 'draft_changed'; text: string }
  | { type: 'draft_cancelled' }
  | { type: 'insert_draft_started'; role: MessageRole }
  | { type: 'insert_draft_changed'; role?: MessageRole; text?: string }
  | { type: 'insert_draft_cancelled' }
  | { type: 'injected_changed'; injected: InjectedContextState }
  | { type: 'loop_mode_changed'; loopMode: PlaygroundLoopMode }
  | { type: 'structural_started' }
  | { type: 'structural_finished'; error?: string }
  | { type: 'launch_started' }
  | { type: 'launch_settled' }
  | { type: 'dismiss_error' }

export function createPlaygroundState(conversationId: string | null): PlaygroundState {
  return {
    conversationId,
    tree: null,
    availability: null,
    runs: [],
    runMessageIds: {},
    inspections: {},
    expandedTraceKeys: [],
    expandedStepIds: {},
    payloads: {},
    payloadErrors: {},
    draft: null,
    insertDraft: null,
    injected: { mode: 'default', messages: [] },
    loopMode: 'step',
    structuralBusy: false,
    launchingRun: false,
    loading: conversationId !== null,
    error: null,
  }
}

/**
 * Expansion policy shared with the previous inspector: keep the user's open
 * steps (minus removed ones), auto-expand newly appeared steps, and open the
 * latest step when a run's trace is seen for the first time.
 */
function nextExpandedStepIds(
  previous: RuntimeRunInspection | undefined,
  previousExpanded: string[] | undefined,
  inspection: RuntimeRunInspection,
): string[] {
  const ids = inspection.snapshot.loop.state.steps.map((step) => step.stepId)
  if (!previous || previousExpanded === undefined) {
    const last = ids.at(-1)
    return last === undefined ? [] : [last]
  }
  const known = new Set(previous.snapshot.loop.state.steps.map((step) => step.stepId))
  const kept = previousExpanded.filter((stepId) => ids.includes(stepId))
  const appeared = ids.filter((stepId) => !known.has(stepId) && !kept.includes(stepId))
  return [...kept, ...appeared]
}

export function reducePlayground(
  state: PlaygroundState,
  action: PlaygroundAction,
): PlaygroundState {
  switch (action.type) {
    case 'reset':
      return createPlaygroundState(action.conversationId)
    case 'refresh_started':
      return { ...state, loading: true }
    case 'refresh_loaded':
      return { ...state, tree: action.tree, runs: action.runs, loading: false }
    case 'refresh_failed':
      return { ...state, loading: false, error: action.error }
    case 'availability_loaded':
      return { ...state, availability: action.availability }
    case 'inspection_loaded': {
      const runId = action.inspection.snapshot.identity.runId
      return {
        ...state,
        inspections: { ...state.inspections, [runId]: action.inspection },
        runMessageIds: {
          ...state.runMessageIds,
          [runId]: action.inspection.snapshot.assistantMessageId,
        },
        expandedStepIds: {
          ...state.expandedStepIds,
          [runId]: nextExpandedStepIds(
            state.inspections[runId],
            state.expandedStepIds[runId],
            action.inspection,
          ),
        },
      }
    }
    case 'inspection_failed':
      return { ...state, error: action.error }
    case 'toggle_trace':
      return {
        ...state,
        expandedTraceKeys: state.expandedTraceKeys.includes(action.key)
          ? state.expandedTraceKeys.filter((key) => key !== action.key)
          : [...state.expandedTraceKeys, action.key],
      }
    case 'toggle_step': {
      const expanded = state.expandedStepIds[action.runId] ?? []
      return {
        ...state,
        expandedStepIds: {
          ...state.expandedStepIds,
          [action.runId]: expanded.includes(action.stepId)
            ? expanded.filter((stepId) => stepId !== action.stepId)
            : [...expanded, action.stepId],
        },
      }
    }
    case 'payload_loaded': {
      const { [action.payload.payloadId]: _cleared, ...payloadErrors } = state.payloadErrors
      return {
        ...state,
        payloads: { ...state.payloads, [action.payload.payloadId]: action.payload },
        payloadErrors,
      }
    }
    case 'payload_failed':
      return {
        ...state,
        payloadErrors: { ...state.payloadErrors, [action.payloadId]: action.error },
      }
    case 'draft_started':
      return { ...state, draft: { entryId: action.entryId, text: action.text }, insertDraft: null }
    case 'draft_changed':
      return state.draft ? { ...state, draft: { ...state.draft, text: action.text } } : state
    case 'draft_cancelled':
      return { ...state, draft: null }
    case 'insert_draft_started':
      return { ...state, insertDraft: { role: action.role, text: '' }, draft: null }
    case 'insert_draft_changed':
      return state.insertDraft
        ? {
            ...state,
            insertDraft: {
              role: action.role ?? state.insertDraft.role,
              text: action.text ?? state.insertDraft.text,
            },
          }
        : state
    case 'insert_draft_cancelled':
      return { ...state, insertDraft: null }
    case 'injected_changed':
      return { ...state, injected: action.injected }
    case 'loop_mode_changed':
      return { ...state, loopMode: action.loopMode }
    case 'structural_started':
      return { ...state, structuralBusy: true, error: null }
    case 'structural_finished':
      return {
        ...state,
        structuralBusy: false,
        draft: action.error ? state.draft : null,
        insertDraft: action.error ? state.insertDraft : null,
        error: action.error ?? state.error,
      }
    case 'launch_started':
      return { ...state, launchingRun: true, error: null }
    case 'launch_settled':
      return { ...state, launchingRun: false }
    case 'dismiss_error':
      return { ...state, error: null }
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export interface TranscriptCard {
  entryId: string
  parentEntryId: string | null
  kind: 'message' | 'context-marker'
  provenance: 'committed' | 'fabricated' | 'none'
  timestamp: number
  message: PersistedMessage | null
  markerLabel: string | null
}

function entryMessage(entry: SessionTreeEntry): PersistedMessage | null {
  if (entry.type === 'message.committed') {
    return (entry.data as { message: PersistedMessage }).message
  }
  if (entry.type === 'extension.message') {
    return (entry.data as { message: PersistedMessage }).message
  }
  return null
}

/** Root-to-leaf semantic entries of the active branch, root excluded. */
export function selectActiveBranch(tree: SessionTree | null): SessionTreeEntry[] {
  if (!tree) return []
  const byId = new Map(tree.nodes.map((node) => [node.entry.entryId, node.entry]))
  const branch: SessionTreeEntry[] = []
  let cursor = byId.get(tree.leafId)
  while (cursor) {
    branch.push(cursor)
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
  }
  return branch.reverse().filter((entry) => entry.type !== 'session.created')
}

export function selectTranscript(tree: SessionTree | null): TranscriptCard[] {
  return selectActiveBranch(tree).map((entry) => {
    const message = entryMessage(entry)
    if (message) {
      return {
        entryId: entry.entryId,
        parentEntryId: entry.parentId,
        kind: 'message' as const,
        provenance:
          entry.type === 'extension.message' ? ('fabricated' as const) : ('committed' as const),
        timestamp: entry.timestamp,
        message,
        markerLabel: null,
      }
    }
    return {
      entryId: entry.entryId,
      parentEntryId: entry.parentId,
      kind: 'context-marker' as const,
      provenance: 'none' as const,
      timestamp: entry.timestamp,
      message: null,
      markerLabel:
        entry.type === 'context.compacted' ? 'Context compacted here' : 'Summary checkpoint',
    }
  })
}

export function messageText(message: Pick<PersistedMessage, 'blocks'>): string {
  return message.blocks
    .filter((block) => block.type === 'text' && 'content' in block)
    .map((block) => ('content' in block ? block.content : ''))
    .join('\n')
}

function runsByTurn(runs: readonly RuntimeRunSummary[]): Map<string, RuntimeRunSummary[]> {
  const groups = new Map<string, RuntimeRunSummary[]>()
  for (const run of runs) {
    const list = groups.get(run.identity.turnId) ?? []
    list.push(run)
    groups.set(run.identity.turnId, list)
  }
  return groups
}

export interface ResolvedRun {
  run: RuntimeRunSummary | null
  /** Candidate runs for the same turn when linkage is still ambiguous. */
  candidates: RuntimeRunSummary[]
}

/**
 * Resolve the run that produced an assistant card. The turn id equals the id
 * of the user message that started the turn; retried turns disambiguate via
 * the learned runId → assistantMessageId cache.
 */
export function selectRunForAssistant(
  state: PlaygroundState,
  cards: readonly TranscriptCard[],
  cardIndex: number,
): ResolvedRun {
  const card = cards[cardIndex]
  if (!card?.message || card.message.role !== 'assistant') return { run: null, candidates: [] }
  let turnId: string | null = null
  for (let index = cardIndex - 1; index >= 0; index -= 1) {
    const candidate = cards[index]
    if (candidate.message?.role === 'user') {
      turnId = candidate.message.id
      break
    }
  }
  if (!turnId) return { run: null, candidates: [] }
  const candidates = runsByTurn(state.runs).get(turnId) ?? []
  if (candidates.length === 0) return { run: null, candidates: [] }
  const learned = candidates.find(
    (candidate) => state.runMessageIds[candidate.identity.runId] === card.message?.id,
  )
  if (learned) return { run: learned, candidates }
  if (candidates.length === 1) return { run: candidates[0], candidates }
  return { run: null, candidates }
}

/**
 * The run currently executing (or paused mid-turn) for the trailing user
 * message, whose assistant message has not been committed to the branch yet.
 */
export function selectActiveRun(
  state: PlaygroundState,
  cards: readonly TranscriptCard[],
): RuntimeRunSummary | null {
  const trailingUser = [...cards].reverse().find((card) => card.message?.role === 'user')
  if (!trailingUser?.message) return null
  const committedIds = new Set(cards.flatMap((card) => (card.message ? [card.message.id] : [])))
  const candidates = (runsByTurn(state.runs).get(trailingUser.message.id) ?? []).filter(
    (run) =>
      (run.status === 'running' || run.status === 'paused') &&
      !committedIds.has(state.runMessageIds[run.identity.runId] ?? ''),
  )
  if (candidates.length === 0) return null
  return candidates.reduce((newest, run) => (run.updatedAt > newest.updatedAt ? run : newest))
}

export interface PlaygroundGuards {
  /** Structural mutations (edit/delete/insert/rewind) allowed. */
  canMutate: boolean
  /** The trailing card can be run via retry-last. */
  canRunFromLeaf: boolean
  composerEnabled: boolean
  /** Human-readable reason when canMutate is false. */
  blockedReason: string | null
}

export function selectGuards(state: PlaygroundState): PlaygroundGuards {
  const cards = selectTranscript(state.tree)
  // Paused-but-resumable runs stay a renderer concern: the engine reports the
  // session idle once a step-mode run pauses, but mutating history would
  // orphan it, so the playground keeps blocking until it settles.
  const pendingRun = selectActiveRun(state, cards)
  const availability = state.availability
  const engineAllows = availability?.allows.mutateSession ?? false
  const busyLocal = state.structuralBusy || state.launchingRun || pendingRun !== null
  const canMutate = Boolean(state.conversationId && state.tree && engineAllows && !busyLocal)
  const trailing = [...cards].reverse().find((card) => card.kind === 'message')
  const canRunFromLeaf =
    canMutate &&
    Boolean(
      trailing?.message &&
        (trailing.message.role === 'user' ||
          (trailing.message.role === 'assistant' && trailing.message.status === 'error')),
    )
  const blockedReason = canMutate
    ? null
    : !state.conversationId || !state.tree
      ? null
      : pendingRun !== null || availability?.blocked === 'turn_active'
        ? 'A run is in progress — wait for it to pause or finish.'
        : availability?.blocked === 'phase_busy'
          ? `Session is ${availability.phase} — wait for it to settle.`
          : 'Another operation is in flight.'
  return { canMutate, canRunFromLeaf, composerEnabled: canMutate, blockedReason }
}

export interface PlaygroundRunControls {
  step: boolean
  continue: boolean
  abort: boolean
  leafMismatch: boolean
}

export function deriveRunControls(state: PlaygroundState, runId: string): PlaygroundRunControls {
  const inspection = state.inspections[runId]
  if (!inspection) return { step: false, continue: false, abort: false, leafMismatch: false }
  const leafMismatch = Boolean(
    state.tree && inspection.snapshot.sessionLeafId !== state.tree.leafId,
  )
  const idle = !state.structuralBusy && !state.launchingRun
  return {
    step: idle && !leafMismatch && inspection.allowedControls.step,
    continue: idle && !leafMismatch && inspection.allowedControls.continue,
    abort: idle && inspection.allowedControls.abort,
    leafMismatch,
  }
}
