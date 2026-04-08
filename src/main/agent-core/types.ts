/**
 * agent-core types — the foundation for Aila's self-built agent runtime.
 *
 * Zero imports from @mariozechner/* on purpose. Everything the main process
 * needs from an LLM, a tool, a session, or an agent event is defined here.
 *
 * These types live on the main-process side only. The renderer keeps its own
 * UI-facing types in src/renderer/src/types/chat.ts; IPC serializes between
 * the two.
 */

import type { Static, TSchema } from '@sinclair/typebox'

// ---------------------------------------------------------------------------
// Message content parts
// ---------------------------------------------------------------------------

export interface TextContent {
  type: 'text'
  text: string
}

export interface ThinkingContent {
  type: 'thinking'
  text: string
  /** Opaque provider-specific signature (e.g. Anthropic extended thinking). */
  signature?: string
}

export interface ImageContent {
  type: 'image'
  /** Base64-encoded image bytes. */
  data: string
  /** e.g. 'image/png', 'image/jpeg', 'image/webp'. */
  mimeType: string
}

export interface ToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type UserContentPart = TextContent | ImageContent
export type AssistantContentPart = TextContent | ThinkingContent | ToolCallContent
export type ToolResultContentPart = TextContent

// ---------------------------------------------------------------------------
// Messages — canonical conversation format used by the Agent runtime and
// persisted into session files. Provider adapters translate to/from this.
// ---------------------------------------------------------------------------

export type StopReason = 'stop' | 'tool_use' | 'max_tokens' | 'aborted' | 'error'

export interface UserMessage {
  role: 'user'
  /** A bare string is a convenience shortcut for a single text part. */
  content: string | UserContentPart[]
}

export interface AssistantMessage {
  role: 'assistant'
  content: AssistantContentPart[]
  stopReason?: StopReason
}

export interface ToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  content: ToolResultContentPart[]
  isError?: boolean
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

// ---------------------------------------------------------------------------
// Providers & models
// ---------------------------------------------------------------------------

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'google-vertex'

export interface ModelInfo {
  id: string
  provider: ProviderId
  displayName: string
  contextWindow: number
  maxOutputTokens: number
  supportsImage: boolean
  supportsThinking: boolean
  supportsToolUse: boolean
}

// ---------------------------------------------------------------------------
// LLM client abstraction — a single interface all providers implement.
// The Agent runtime talks to this and never to a raw provider SDK.
// ---------------------------------------------------------------------------

export interface LLMToolSchema {
  name: string
  description: string
  /** JSON Schema object describing the tool's parameters. */
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  model: ModelInfo
  systemPrompt: string
  messages: Message[]
  tools?: LLMToolSchema[]
  maxOutputTokens?: number
  temperature?: number
  /** Budget in tokens for provider-native thinking/reasoning blocks. */
  thinkingBudget?: number
}

export interface LLMAuth {
  apiKey: string
  baseUrl: string
  /** Extra headers merged into the outgoing request (e.g. anthropic-version). */
  headers?: Record<string, string>
}

export interface LLMUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export type StreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'thinking-delta'; delta: string }
  | { type: 'tool-call-start'; id: string; name: string }
  | { type: 'tool-call-delta'; id: string; argsJsonDelta: string }
  | {
      type: 'tool-call-end'
      id: string
      name: string
      arguments: Record<string, unknown>
    }
  | { type: 'usage'; usage: LLMUsage }
  | { type: 'finish'; reason: StopReason; errorMessage?: string }

export interface CompleteResult {
  content: AssistantContentPart[]
  stopReason: StopReason
  usage?: LLMUsage
}

export interface LLMClient {
  /**
   * Stream a chat completion as a sequence of StreamEvents.
   * Caller must consume the iterator; aborting the signal terminates the
   * underlying request and ends the stream with a 'finish' event.
   */
  stream(request: ChatRequest, auth: LLMAuth, signal: AbortSignal): AsyncIterable<StreamEvent>

  /** One-shot non-streaming completion. Used for utilities like memory curation. */
  complete(request: ChatRequest, auth: LLMAuth, signal?: AbortSignal): Promise<CompleteResult>
}

/** Bundle of an LLM client plus the concrete model and auth to drive it. */
export interface ResolvedLLM {
  client: LLMClient
  modelInfo: ModelInfo
  auth: LLMAuth
}

// ---------------------------------------------------------------------------
// Tools — what the Agent runtime can invoke on behalf of the model.
// ---------------------------------------------------------------------------

export interface ToolExecContext {
  cwd: string
  signal: AbortSignal
}

export interface ToolExecResult {
  content: ToolResultContentPart[]
  isError?: boolean
  /** Rich data for UI rendering; never sent back to the LLM. */
  details?: unknown
}

export interface Tool<TParams extends TSchema = TSchema> {
  name: string
  /** Human-readable label shown in the UI. */
  label: string
  /** Tool description sent to the LLM in the function schema. */
  description: string
  /** TypeBox schema describing the tool's parameters; doubles as JSON Schema. */
  parameters: TParams
  execute(input: Static<TParams>, ctx: ToolExecContext): Promise<ToolExecResult>
  /** Short paragraph appended to the system prompt when this tool is enabled. */
  promptSnippet?: string
  /** Bullet-point guidelines appended to the system prompt when enabled. */
  promptGuidelines?: string[]
}

// ---------------------------------------------------------------------------
// Agent runtime events — emitted by the self-built Agent loop and consumed by
// SessionController in agent.ts. Deliberately mirrors pi-coding-agent's event
// vocabulary so the SessionController switch statement stays unchanged during
// the cutover.
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | {
      type: 'tool_execution_start'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
    }
  | {
      type: 'tool_execution_end'
      toolCallId: string
      toolName: string
      result: string
      isError: boolean
    }
  | { type: 'error'; message: string }
  | { type: 'turn_complete'; stopReason: StopReason }

// ---------------------------------------------------------------------------
// UI-facing message types (serialized over IPC to the renderer)
// ---------------------------------------------------------------------------

export interface UIImageAttachment {
  id: string
  data: string
  mimeType: string
  name?: string
}

export type UIBlock =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'tool'
      id: string
      name: string
      args: Record<string, unknown>
      result?: string
      isError?: boolean
      status: 'running' | 'done'
    }

export interface UIMessage {
  id: string
  role: 'user' | 'assistant'
  content?: string
  images?: UIImageAttachment[]
  blocks?: UIBlock[]
  status?: 'queued' | 'streaming' | 'done'
}

// ---------------------------------------------------------------------------
// Session storage (JSONL, append-only)
// ---------------------------------------------------------------------------

export const SESSION_FILE_VERSION = 1 as const

export interface SessionHeader {
  type: 'session'
  version: typeof SESSION_FILE_VERSION
  id: string
  cwd: string
  createdAt: string
  /** Optional user-assigned display name for the session. */
  name?: string
}

export interface SessionMessageEntry {
  type: 'message'
  id: string
  timestamp: string
  message: Message
}

export interface ModelChangeEntry {
  type: 'model_change'
  id: string
  timestamp: string
  providerId: string
  modelId: string
}

export type SessionEntry = SessionMessageEntry | ModelChangeEntry
export type SessionFileLine = SessionHeader | SessionEntry

export interface SessionInfo {
  path: string
  id: string
  cwd: string
  createdAt: string
  modified: Date
  messageCount: number
  firstMessage: string
  name?: string
}
