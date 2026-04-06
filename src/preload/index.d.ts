interface SessionSummary {
  id: string
  runtimeId: string | null
  path: string | null
  name?: string
  modified: string
  messageCount: number
  firstMessage: string
  status: 'idle' | 'running' | 'error'
  queuedCount: number
}

interface SessionImageAttachment {
  id: string
  data: string
  mimeType: string
  name?: string
}

interface SessionBlockText {
  type: 'text'
  content: string
}

interface SessionBlockThinking {
  type: 'thinking'
  content: string
}

interface SessionBlockTool {
  id: string
  type: 'tool'
  name: string
  args: Record<string, unknown>
  result?: string
  isError?: boolean
  status: 'running' | 'done'
}

type SessionBlock = SessionBlockText | SessionBlockThinking | SessionBlockTool

interface SessionMessage {
  id: string
  role: 'user' | 'assistant'
  content?: string
  images?: SessionImageAttachment[]
  blocks?: SessionBlock[]
  status?: 'queued' | 'streaming' | 'done'
}

interface SessionState {
  sessionId: string
  sessionPath: string | null
  messages: SessionMessage[]
  isStreaming: boolean
  queuedPrompts: Array<{ id: string; text: string; images: SessionImageAttachment[] }>
  status: 'idle' | 'running' | 'error'
}

interface PreferenceMemorySummary {
  id: string
  key: string
  value: string
  sourceType: 'explicit' | 'inferred'
  confidence: number
  reason: string | null
  evidenceCount: number
  updatedAt: string
}

interface AgentAPI {
  // Agent session
  prompt: (
    sessionId: string,
    prompt: { text: string; images?: SessionImageAttachment[] },
  ) => Promise<SessionState>
  abort: (sessionId: string) => Promise<SessionState>
  newSession: () => Promise<SessionState>
  getConfig: () => Promise<{ hasApiKey: boolean; activeModelSupportsImages: boolean }>

  // Session persistence
  listSessions: () => Promise<SessionSummary[]>
  openSession: (target: {
    runtimeId?: string | null
    path?: string | null
  }) => Promise<SessionState>
  getSessionState: (sessionId: string) => Promise<SessionState>
  editQueuedPrompt: (
    sessionId: string,
    promptId: string,
    currentDraft: { text: string; images: SessionImageAttachment[] },
  ) => Promise<{
    nextInput: { text: string; images: SessionImageAttachment[] } | null
    snapshot: SessionState
  }>
  removeQueuedPrompt: (sessionId: string, promptId: string) => Promise<SessionState>
  openExternal: (url: string) => Promise<void>
  deleteSession: (target: {
    runtimeId?: string | null
    path?: string | null
  }) => Promise<{ deletedRuntimeId: string | null }>

  // Agent push events
  onTextDelta: (cb: (data: { sessionId: string; delta: string }) => void) => () => void
  onThinkingDelta: (cb: (data: { sessionId: string; delta: string }) => void) => () => void
  onToolStart: (
    cb: (data: {
      sessionId: string
      id: string
      name: string
      args: Record<string, unknown>
    }) => void,
  ) => () => void
  onToolEnd: (
    cb: (data: {
      sessionId: string
      id: string
      name: string
      result: string
      isError: boolean
    }) => void,
  ) => () => void
  onComplete: (cb: (data: { sessionId: string }) => void) => () => void
  onError: (cb: (data: { sessionId: string; message: string }) => void) => () => void
  onSessionState: (cb: (data: SessionState) => void) => () => void
  onSessionsChanged: (cb: () => void) => () => void

  // Provider management
  getProviders: () => Promise<unknown[]>
  saveProvider: (provider: unknown) => Promise<void>
  deleteProvider: (providerId: string) => Promise<void>
  testConnection: (providerId: string) => Promise<{ success: boolean; error?: string }>
  getWebSearchConfig: () => Promise<{ hasTavilyApiKey: boolean }>
  saveWebSearchConfig: (webSearch: { tavilyApiKey?: string }) => Promise<void>

  // Model management
  getModels: () => Promise<unknown[]>
  getActiveModel: () => Promise<string | null>
  setActiveModel: (providerId: string, modelId: string) => Promise<void>

  // Memory management
  listMemory: () => Promise<PreferenceMemorySummary[]>
  updateMemory: (memory: { id: string; value: string; reason?: string | null }) => Promise<void>
  deleteMemory: (id: string) => Promise<void>

  // Config change events
  onConfigChanged: (cb: () => void) => () => void
}

declare global {
  interface Window {
    api: AgentAPI
  }
}

export {}
