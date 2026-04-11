import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  ChatConfig,
  ChatSessionState,
  Message,
  PromptDraftValue,
  QueuedPromptDraft,
  SessionSummary,
} from '@/types/chat'

interface SessionUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface UseAgentChatResult {
  activeSessionId: string | null
  config: ChatConfig | null
  messages: Message[]
  isStreaming: boolean
  queuedCount: number
  queuedPrompts: QueuedPromptDraft[]
  usage: SessionUsage
  handleAbort: () => Promise<void>
  handleSubmitPrompt: (draft: PromptDraftValue) => Promise<boolean>
  handleEditQueuedPrompt: (
    promptId: string,
    currentDraft: PromptDraftValue,
  ) => Promise<PromptDraftValue | null>
  handleRemoveQueuedPrompt: (promptId: string) => Promise<void>
  handleNewSession: () => Promise<void>
  handleOpenSession: (session: SessionSummary) => Promise<void>
  handleDeleteSession: (session: SessionSummary) => Promise<void>
}

function cloneMessageState(state: ChatSessionState): ChatSessionState {
  return {
    ...state,
    messages: state.messages.map((message) => ({
      ...message,
      images: message.images ? message.images.map((image) => ({ ...image })) : undefined,
      blocks: message.blocks ? [...message.blocks] : undefined,
    })),
    queuedPrompts: state.queuedPrompts.map((prompt) => ({
      ...prompt,
      images: prompt.images.map((image) => ({ ...image })),
    })),
  }
}

export function useAgentChat(): UseAgentChatResult {
  const [config, setConfig] = useState<ChatConfig | null>(null)
  const [activeSession, setActiveSession] = useState<ChatSessionState | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)

  const pendingTextRef = useRef('')
  const pendingThinkingRef = useRef('')
  const rafRef = useRef<number | null>(null)

  const loadConfig = useCallback(async () => {
    const nextConfig = await window.api.getConfig()
    setConfig(nextConfig)
  }, [])

  const applyActiveSession = useCallback((state: ChatSessionState) => {
    activeSessionIdRef.current = state.sessionId
    setActiveSession(cloneMessageState(state))
  }, [])

  const updateActiveSession = useCallback(
    (updater: (state: ChatSessionState) => ChatSessionState) => {
      setActiveSession((previous) => {
        if (!previous) return previous
        const next = updater(previous)
        activeSessionIdRef.current = next.sessionId
        return next
      })
    },
    [],
  )

  const updateCurrentAssistantBlocks = useCallback(
    (updater: (blocks: NonNullable<Message['blocks']>) => NonNullable<Message['blocks']>) => {
      updateActiveSession((state) => {
        const assistantIndex = [...state.messages]
          .reverse()
          .findIndex((message) => message.role === 'assistant' && message.status === 'streaming')

        if (assistantIndex < 0) return state

        const targetIndex = state.messages.length - assistantIndex - 1
        const nextMessages = state.messages.map((message, index) => {
          if (index !== targetIndex || message.role !== 'assistant') return message
          return {
            ...message,
            blocks: updater([...(message.blocks ?? [])]),
          }
        })

        return {
          ...state,
          messages: nextMessages,
        }
      })
    },
    [updateActiveSession],
  )

  const flushPendingDeltas = useCallback(() => {
    rafRef.current = null
    const text = pendingTextRef.current
    const thinking = pendingThinkingRef.current
    pendingTextRef.current = ''
    pendingThinkingRef.current = ''

    if (!text && !thinking) return

    updateCurrentAssistantBlocks((blocks) => {
      let nextBlocks = blocks

      if (thinking) {
        const last = nextBlocks[nextBlocks.length - 1]
        if (last?.type === 'thinking') {
          nextBlocks = [...nextBlocks.slice(0, -1), { ...last, content: last.content + thinking }]
        } else {
          nextBlocks = [...nextBlocks, { type: 'thinking', content: thinking }]
        }
      }

      if (text) {
        const last = nextBlocks[nextBlocks.length - 1]
        if (last?.type === 'text') {
          nextBlocks = [...nextBlocks.slice(0, -1), { ...last, content: last.content + text }]
        } else {
          nextBlocks = [...nextBlocks, { type: 'text', content: text }]
        }
      }

      return nextBlocks
    })
  }, [updateCurrentAssistantBlocks])

  const scheduleFlush = useCallback(() => {
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flushPendingDeltas)
    }
  }, [flushPendingDeltas])

  const cancelPendingRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    pendingTextRef.current = ''
    pendingThinkingRef.current = ''
  }, [])

  const loadSessionIntoView = useCallback(
    async (session: ChatSessionState) => {
      cancelPendingRaf()
      applyActiveSession(session)
    },
    [applyActiveSession, cancelPendingRaf],
  )

  useEffect(() => {
    void loadConfig()

    const unsubscribe = window.api.onConfigChanged(() => {
      void loadConfig()
    })

    return unsubscribe
  }, [loadConfig])

  useEffect(() => {
    const cleanups = [
      window.api.onSessionState((state) => {
        if (state.sessionId !== activeSessionIdRef.current) return
        cancelPendingRaf()
        applyActiveSession(state)
      }),

      window.api.onTextDelta((data) => {
        if (data.sessionId !== activeSessionIdRef.current) return
        pendingTextRef.current += data.delta
        scheduleFlush()
      }),

      window.api.onThinkingDelta((data) => {
        if (data.sessionId !== activeSessionIdRef.current) return
        pendingThinkingRef.current += data.delta
        scheduleFlush()
      }),

      window.api.onToolStart((data) => {
        if (data.sessionId !== activeSessionIdRef.current) return
        flushPendingDeltas()
        updateCurrentAssistantBlocks((blocks) => [
          ...blocks,
          {
            type: 'tool',
            id: data.id,
            name: data.name,
            args: data.args,
            status: 'running',
          },
        ])
      }),

      window.api.onToolEnd((data) => {
        if (data.sessionId !== activeSessionIdRef.current) return
        updateCurrentAssistantBlocks((blocks) =>
          blocks.map((block) =>
            block.type === 'tool' && block.id === data.id
              ? {
                  ...block,
                  result: data.result,
                  isError: data.isError,
                  status: 'done',
                }
              : block,
          ),
        )
      }),
    ]

    return () => {
      for (const cleanup of cleanups) cleanup()
      cancelPendingRaf()
    }
  }, [
    applyActiveSession,
    cancelPendingRaf,
    flushPendingDeltas,
    scheduleFlush,
    updateCurrentAssistantBlocks,
  ])

  const handleSubmitPrompt = useCallback(
    async (draft: PromptDraftValue) => {
      const text = draft.text.trim()
      const images = draft.images.map((image) => ({ ...image }))
      if (!text && images.length === 0) return false

      let sessionId = activeSessionIdRef.current

      if (!sessionId) {
        const created = await window.api.newSession()
        await loadSessionIntoView(created)
        sessionId = created.sessionId
      }

      const nextState = await window.api.prompt(sessionId, { text, images })
      await loadSessionIntoView(nextState)
      return true
    },
    [loadSessionIntoView],
  )

  const handleAbort = useCallback(async () => {
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return

    const nextState = await window.api.abort(sessionId)
    await loadSessionIntoView(nextState)
  }, [loadSessionIntoView])

  const handleNewSession = useCallback(async () => {
    const created = await window.api.newSession()
    await loadSessionIntoView(created)
  }, [loadSessionIntoView])

  const handleOpenSession = useCallback(
    async (session: SessionSummary) => {
      const opened = await window.api.openSession({
        runtimeId: session.runtimeId,
        path: session.path,
      })
      await loadSessionIntoView(opened)
    },
    [loadSessionIntoView],
  )

  const handleDeleteSession = useCallback(
    async (session: SessionSummary) => {
      const result = await window.api.deleteSession({
        runtimeId: session.runtimeId,
        path: session.path,
      })

      if (result.deletedRuntimeId && result.deletedRuntimeId === activeSessionIdRef.current) {
        cancelPendingRaf()
        activeSessionIdRef.current = null
        setActiveSession(null)
      }
    },
    [cancelPendingRaf],
  )

  const handleEditQueuedPrompt = useCallback(
    async (promptId: string, currentDraft: PromptDraftValue) => {
      const sessionId = activeSessionIdRef.current
      if (!sessionId) return null

      const result = await window.api.editQueuedPrompt(sessionId, promptId, currentDraft)
      await loadSessionIntoView(result.snapshot)
      return result.nextInput
    },
    [loadSessionIntoView],
  )

  const handleRemoveQueuedPrompt = useCallback(
    async (promptId: string) => {
      const sessionId = activeSessionIdRef.current
      if (!sessionId) return

      const nextState = await window.api.removeQueuedPrompt(sessionId, promptId)
      await loadSessionIntoView(nextState)
    },
    [loadSessionIntoView],
  )

  const defaultUsage: SessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  return {
    activeSessionId: activeSession?.sessionId ?? null,
    config,
    messages: activeSession?.messages ?? [],
    isStreaming: activeSession?.isStreaming ?? false,
    queuedCount: activeSession?.queuedPrompts.length ?? 0,
    queuedPrompts: activeSession?.queuedPrompts ?? [],
    usage: activeSession?.usage ?? defaultUsage,
    handleAbort,
    handleSubmitPrompt,
    handleEditQueuedPrompt,
    handleRemoveQueuedPrompt,
    handleNewSession,
    handleOpenSession,
    handleDeleteSession,
  }
}
