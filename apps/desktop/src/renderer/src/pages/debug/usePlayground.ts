import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { ModelSelection, PersistedMessage } from '../../types'
import { messageFromError } from './debugFormat'
import {
  createPlaygroundState,
  type InjectedContextState,
  type MessageRole,
  type PlaygroundGuards,
  type PlaygroundLoopMode,
  type PlaygroundState,
  reducePlayground,
  selectActiveRun,
  selectGuards,
  selectRunForAssistant,
  selectTranscript,
  type TranscriptCard,
} from './playgroundState'

/** Payloads above this size wait for an explicit "Load payload" click. */
export const PAYLOAD_AUTO_LOAD_MAX_BYTES = 262_144

const EVENT_REFRESH_DEBOUNCE_MS = 90

export interface PlaygroundApi {
  state: PlaygroundState
  cards: TranscriptCard[]
  guards: PlaygroundGuards
  activeRunId: string | null
  resolveRun: (cardIndex: number) => ReturnType<typeof selectRunForAssistant>
  refresh: () => void
  dismissError: () => void
  // transcript editing
  startDraft: (entryId: string, text: string) => void
  changeDraft: (text: string) => void
  cancelDraft: () => void
  saveDraft: (card: TranscriptCard) => void
  rewindTo: (parentEntryId: string) => void
  startInsert: (role: MessageRole) => void
  changeInsert: (patch: { role?: MessageRole; text?: string }) => void
  cancelInsert: () => void
  saveInsert: () => void
  // run configuration
  setInjected: (injected: InjectedContextState) => void
  setLoopMode: (loopMode: PlaygroundLoopMode) => void
  // running
  runFromLeaf: (selection: ModelSelection) => void
  fabricateAndRun: (text: string, selection: ModelSelection) => void
  stepRun: (runId: string) => void
  continueRun: (runId: string) => void
  abortRun: (runId: string) => void
  // trace inspection
  toggleTrace: (key: string, runIds: string[]) => void
  toggleStep: (runId: string, stepId: string) => void
  loadPayload: (runId: string, payloadId: string) => void
}

function fabricatedMessage(
  role: MessageRole,
  text: string,
  base?: PersistedMessage,
): PersistedMessage {
  const preservedBlocks = (base?.blocks ?? []).filter((block) => block.type !== 'text')
  return {
    schemaVersion: 1,
    id: globalThis.crypto.randomUUID(),
    role,
    blocks: [{ type: 'text', content: text }, ...preservedBlocks],
    status: 'done',
    ...(base?.model ? { model: base.model } : {}),
  }
}

export function usePlayground(conversationId: string | null): PlaygroundApi {
  const [state, dispatch] = useReducer(reducePlayground, conversationId, createPlaygroundState)
  const stateRef = useRef(state)
  stateRef.current = state
  // Guards late responses after the conversation switched underneath a fetch.
  const epochRef = useRef(0)

  const refresh = useCallback(
    async (foreground = false): Promise<void> => {
      if (!conversationId) return
      const epoch = epochRef.current
      if (foreground) dispatch({ type: 'refresh_started' })
      try {
        const [tree, runs, availability] = await Promise.all([
          window.api.runtime.getSessionTree(conversationId),
          window.api.runtime.listRunSummaries(conversationId),
          window.api.runtime.getAvailability(conversationId),
        ])
        if (epochRef.current !== epoch) return
        dispatch({ type: 'refresh_loaded', tree, runs })
        dispatch({ type: 'availability_loaded', availability })
      } catch (reason) {
        if (epochRef.current !== epoch) return
        dispatch({ type: 'refresh_failed', error: messageFromError(reason) })
      }
    },
    [conversationId],
  )

  useEffect(() => {
    epochRef.current += 1
    dispatch({ type: 'reset', conversationId })
    if (!conversationId) return
    void refresh(true)
  }, [conversationId, refresh])

  // Run events and conversation updates (message commits, navigation) share
  // one debounced refresh; the first run event also settles a pending launch.
  useEffect(() => {
    if (!conversationId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void refresh()
      }, EVENT_REFRESH_DEBOUNCE_MS)
    }
    const cleanups = [
      window.api.runtime.onRunEvent((event) => {
        if (event.conversationId !== conversationId) return
        if (stateRef.current.launchingRun) dispatch({ type: 'launch_settled' })
        schedule()
      }),
      window.api.runtime.conversations.onUpdated((summary) => {
        if (summary.id !== conversationId) return
        schedule()
      }),
      window.api.runtime.onAvailability((availability) => {
        if (availability.conversationId !== conversationId) return
        dispatch({ type: 'availability_loaded', availability })
      }),
    ]
    return () => {
      if (timer) clearTimeout(timer)
      for (const cleanup of cleanups) cleanup()
    }
  }, [conversationId, refresh])

  const cards = useMemo(() => selectTranscript(state.tree), [state.tree])
  const activeRun = useMemo(() => selectActiveRun(state, cards), [state, cards])
  const activeRunId = activeRun?.identity.runId ?? null
  const guards = useMemo(() => selectGuards(state), [state])

  const fetchInspection = useCallback(
    (runId: string): void => {
      if (!conversationId) return
      const epoch = epochRef.current
      window.api.runtime
        .inspectRun({ conversationId, runId })
        .then((inspection) => {
          if (epochRef.current === epoch) dispatch({ type: 'inspection_loaded', inspection })
        })
        .catch((reason) => {
          if (epochRef.current === epoch) {
            dispatch({ type: 'inspection_failed', error: messageFromError(reason) })
          }
        })
    },
    [conversationId],
  )

  // The active run always keeps a live inspection: it powers the tail card's
  // trace and its Step/Continue controls.
  const { inspections, expandedStepIds, payloads, payloadErrors, expandedTraceKeys, runs } = state
  useEffect(() => {
    if (!activeRunId) return
    const current = inspections[activeRunId]
    if (
      !current ||
      current.snapshot.updatedAt <
        (runs.find((run) => run.identity.runId === activeRunId)?.updatedAt ?? 0)
    ) {
      fetchInspection(activeRunId)
    }
  }, [activeRunId, inspections, runs, fetchInspection])

  // Expanded traces on committed cards refresh their inspections when the run
  // summary advances past the cached snapshot.
  useEffect(() => {
    if (expandedTraceKeys.length === 0) return
    for (const run of runs) {
      const runId = run.identity.runId
      const messageId = state.runMessageIds[runId]
      const key = messageId ?? null
      if (!key || !expandedTraceKeys.includes(key)) continue
      const cached = inspections[runId]
      if (!cached || cached.snapshot.updatedAt < run.updatedAt) fetchInspection(runId)
    }
  }, [expandedTraceKeys, runs, inspections, state.runMessageIds, fetchInspection])

  // Expansion-driven payload hydration across all cached inspections.
  useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    for (const [runId, inspection] of Object.entries(inspections)) {
      const expanded = new Set(expandedStepIds[runId] ?? [])
      if (expanded.size === 0) continue
      const missing = inspection.payloads.filter(
        (descriptor) =>
          expanded.has(descriptor.stepId) &&
          descriptor.size <= PAYLOAD_AUTO_LOAD_MAX_BYTES &&
          !payloads[descriptor.payloadId] &&
          !payloadErrors[descriptor.payloadId],
      )
      for (const descriptor of missing) {
        window.api.runtime
          .getRunPayload({ conversationId, runId, payloadId: descriptor.payloadId })
          .then((payload) => {
            if (!cancelled) dispatch({ type: 'payload_loaded', payload })
          })
          .catch((reason) => {
            if (!cancelled) {
              dispatch({
                type: 'payload_failed',
                payloadId: descriptor.payloadId,
                error: messageFromError(reason),
              })
            }
          })
      }
    }
    return () => {
      cancelled = true
    }
  }, [conversationId, inspections, expandedStepIds, payloads, payloadErrors])

  const structural = useCallback(
    async (operation: () => Promise<void>): Promise<void> => {
      if (!conversationId) return
      dispatch({ type: 'structural_started' })
      try {
        await operation()
        dispatch({ type: 'structural_finished' })
      } catch (reason) {
        dispatch({ type: 'structural_finished', error: messageFromError(reason) })
      }
      void refresh()
    },
    [conversationId, refresh],
  )

  const saveDraft = useCallback(
    (card: TranscriptCard): void => {
      const draft = stateRef.current.draft
      if (!conversationId || !draft || draft.entryId !== card.entryId) return
      if (!card.message || !card.parentEntryId) return
      const message = fabricatedMessage(card.message.role, draft.text, card.message)
      void structural(async () => {
        await window.api.runtime.navigateSession({
          conversationId,
          entryId: card.parentEntryId as string,
        })
        await window.api.runtime.appendPlaygroundMessage({ conversationId, message })
      })
    },
    [conversationId, structural],
  )

  const rewindTo = useCallback(
    (parentEntryId: string): void => {
      if (!conversationId) return
      void structural(async () => {
        await window.api.runtime.navigateSession({ conversationId, entryId: parentEntryId })
      })
    },
    [conversationId, structural],
  )

  const saveInsert = useCallback((): void => {
    const insertDraft = stateRef.current.insertDraft
    if (!conversationId || !insertDraft || insertDraft.text.trim().length === 0) return
    const message = fabricatedMessage(insertDraft.role, insertDraft.text)
    void structural(async () => {
      await window.api.runtime.appendPlaygroundMessage({ conversationId, message })
    })
  }, [conversationId, structural])

  const launchRetry = useCallback(
    async (selection: ModelSelection): Promise<void> => {
      if (!conversationId) return
      const { injected, loopMode } = stateRef.current
      dispatch({ type: 'launch_started' })
      try {
        await window.api.runtime.retryLast({
          conversationId,
          selection,
          loopMode,
          ...(injected.mode === 'cleared'
            ? { transientContext: [] }
            : injected.mode === 'override'
              ? { transientContext: injected.messages }
              : {}),
        })
      } catch (reason) {
        dispatch({ type: 'launch_settled' })
        dispatch({ type: 'structural_finished', error: messageFromError(reason) })
      }
      void refresh()
    },
    [conversationId, refresh],
  )

  const runFromLeaf = useCallback(
    (selection: ModelSelection): void => {
      void launchRetry(selection)
    },
    [launchRetry],
  )

  const fabricateAndRun = useCallback(
    (text: string, selection: ModelSelection): void => {
      if (!conversationId || text.trim().length === 0) return
      const message = fabricatedMessage('user', text)
      void (async () => {
        dispatch({ type: 'structural_started' })
        try {
          await window.api.runtime.appendPlaygroundMessage({ conversationId, message })
          dispatch({ type: 'structural_finished' })
        } catch (reason) {
          dispatch({ type: 'structural_finished', error: messageFromError(reason) })
          return
        }
        await launchRetry(selection)
      })()
    },
    [conversationId, launchRetry],
  )

  const runControl = useCallback(
    (kind: 'step' | 'continue' | 'abort', runId: string): void => {
      if (!conversationId) return
      void (async () => {
        dispatch({ type: 'structural_started' })
        const target = { conversationId, runId }
        try {
          // resumeRun would drop loopMode across IPC; step/continue carry it.
          if (kind === 'step') await window.api.runtime.stepRun(target)
          else if (kind === 'continue') await window.api.runtime.continueRun(target)
          else await window.api.runtime.abortRun(target)
          dispatch({ type: 'structural_finished' })
        } catch (reason) {
          dispatch({ type: 'structural_finished', error: messageFromError(reason) })
        }
        void refresh()
      })()
    },
    [conversationId, refresh],
  )

  const toggleTrace = useCallback(
    (key: string, runIds: string[]): void => {
      dispatch({ type: 'toggle_trace', key })
      const opening = !stateRef.current.expandedTraceKeys.includes(key)
      if (!opening) return
      for (const runId of runIds) {
        if (!stateRef.current.inspections[runId]) fetchInspection(runId)
      }
    },
    [fetchInspection],
  )

  const resolveRun = useCallback(
    (cardIndex: number) => selectRunForAssistant(stateRef.current, cards, cardIndex),
    [cards],
  )

  return {
    state,
    cards,
    guards,
    activeRunId,
    resolveRun,
    refresh: useCallback(() => void refresh(true), [refresh]),
    dismissError: useCallback(() => dispatch({ type: 'dismiss_error' }), []),
    startDraft: useCallback(
      (entryId: string, text: string) => dispatch({ type: 'draft_started', entryId, text }),
      [],
    ),
    changeDraft: useCallback((text: string) => dispatch({ type: 'draft_changed', text }), []),
    cancelDraft: useCallback(() => dispatch({ type: 'draft_cancelled' }), []),
    saveDraft,
    rewindTo,
    startInsert: useCallback(
      (role: MessageRole) => dispatch({ type: 'insert_draft_started', role }),
      [],
    ),
    changeInsert: useCallback(
      (patch: { role?: MessageRole; text?: string }) =>
        dispatch({ type: 'insert_draft_changed', ...patch }),
      [],
    ),
    cancelInsert: useCallback(() => dispatch({ type: 'insert_draft_cancelled' }), []),
    saveInsert,
    setInjected: useCallback(
      (injected: InjectedContextState) => dispatch({ type: 'injected_changed', injected }),
      [],
    ),
    setLoopMode: useCallback(
      (loopMode: PlaygroundLoopMode) => dispatch({ type: 'loop_mode_changed', loopMode }),
      [],
    ),
    runFromLeaf,
    fabricateAndRun,
    stepRun: useCallback((runId: string) => runControl('step', runId), [runControl]),
    continueRun: useCallback((runId: string) => runControl('continue', runId), [runControl]),
    abortRun: useCallback((runId: string) => runControl('abort', runId), [runControl]),
    toggleTrace,
    toggleStep: useCallback(
      (runId: string, stepId: string) => dispatch({ type: 'toggle_step', runId, stepId }),
      [],
    ),
    loadPayload: useCallback(
      (runId: string, payloadId: string): void => {
        if (!conversationId) return
        window.api.runtime
          .getRunPayload({ conversationId, runId, payloadId })
          .then((payload) => dispatch({ type: 'payload_loaded', payload }))
          .catch((reason) =>
            dispatch({ type: 'payload_failed', payloadId, error: messageFromError(reason) }),
          )
      },
      [conversationId],
    ),
  }
}
