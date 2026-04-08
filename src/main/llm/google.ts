/**
 * Google Gemini / Vertex AI client — thin wrapper around @google/genai.
 *
 * Pi-ai demonstrated the right pattern here: don't hand-write HTTP/SSE for
 * Google, use the official SDK. It handles URL construction, API-key vs ADC
 * auth, SSE parsing, and the Vertex-vs-Gemini endpoint split for us.
 *
 * Reference: pi-ai 0.64.0 src/providers/google-vertex.js
 *
 * Important wire-level facts we learned from pi:
 *
 * - Tool schemas must be passed via `parametersJsonSchema` (NOT `parameters`).
 *   The former accepts full JSON Schema draft-07 (anyOf / const / etc); the
 *   latter is an OpenAPI 3.03 subset that rejects `const`. TypeBox emits
 *   draft-07 so we always want the JSON Schema variant.
 *
 * - Thinking parts are marked with `part.thought === true`. The `text` field
 *   contains the thought body.
 *
 * - Vertex with API key: `new GoogleGenAI({ vertexai: true, apiKey })`.
 *   The SDK picks the right host and auth scheme automatically.
 */

import {
  type Content,
  FinishReason,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  GoogleGenAI,
  type Part,
} from '@google/genai'
import type {
  AssistantContentPart,
  ChatRequest,
  CompleteResult,
  LLMAuth,
  LLMClient,
  LLMUsage,
  Message,
  StopReason,
  StreamEvent,
  UserContentPart,
} from '../agent-core/types'

// ---------------------------------------------------------------------------
// Message conversion: canonical Message[] → Content[] for @google/genai
// ---------------------------------------------------------------------------

function convertUserPart(part: UserContentPart): Part {
  if (part.type === 'text') {
    return { text: part.text }
  }
  return {
    inlineData: {
      mimeType: part.mimeType,
      data: part.data,
    },
  }
}

export function convertMessages(messages: Message[]): Content[] {
  // Build id → tool name map so we can translate toolResult → functionResponse.
  const toolCallNames = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'toolCall') {
          toolCallNames.set(part.id, part.name)
        }
      }
    }
  }

  const contents: Content[] = []
  let userBuffer: Part[] = []

  const flushUser = () => {
    if (userBuffer.length > 0) {
      contents.push({ role: 'user', parts: userBuffer })
      userBuffer = []
    }
  }

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      flushUser()
      const parts: Part[] = []
      for (const p of msg.content) {
        if (p.type === 'text') {
          if (p.text) parts.push({ text: p.text })
        } else if (p.type === 'toolCall') {
          parts.push({
            functionCall: {
              name: p.name,
              args: p.arguments ?? {},
            },
          })
        }
        // Thinking blocks from our history are dropped when replaying to
        // Gemini — the SDK rejects unsigned thought parts and our internal
        // format doesn't persist thoughtSignature yet.
      }
      if (parts.length === 0) parts.push({ text: '' })
      contents.push({ role: 'model', parts })
      continue
    }

    if (msg.role === 'user') {
      const ps =
        typeof msg.content === 'string'
          ? [{ text: msg.content } satisfies Part]
          : msg.content.map(convertUserPart)
      userBuffer.push(...ps)
      continue
    }

    // msg.role === 'toolResult'
    const name = toolCallNames.get(msg.toolCallId) ?? 'unknown'
    const textResult = msg.content.map((c) => c.text).join('\n')
    userBuffer.push({
      functionResponse: {
        name,
        response: msg.isError ? { error: textResult } : { output: textResult },
      },
    })
  }

  flushUser()
  return contents
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function isThinkingPart(part: Part): boolean {
  return (part as { thought?: boolean }).thought === true
}

export function convertResponseParts(parts: Part[]): AssistantContentPart[] {
  const out: AssistantContentPart[] = []
  for (const part of parts) {
    if (part.text !== undefined && part.text !== null) {
      if (isThinkingPart(part)) {
        out.push({ type: 'thinking', text: part.text })
      } else {
        out.push({ type: 'text', text: part.text })
      }
    } else if (part.functionCall) {
      out.push({
        type: 'toolCall',
        id: part.functionCall.id ?? `gcall_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name ?? 'unknown',
        arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
      })
    }
  }
  return out
}

export function mapStopReason(
  reason: FinishReason | string | null | undefined,
  hasToolCall: boolean,
): StopReason {
  if (hasToolCall) return 'tool_use'
  switch (reason) {
    case FinishReason.STOP:
    case 'STOP':
      return 'stop'
    case FinishReason.MAX_TOKENS:
    case 'MAX_TOKENS':
      return 'max_tokens'
    default:
      return 'stop'
  }
}

interface MinimalUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
}

export function mapUsage(raw: MinimalUsageMetadata | undefined): LLMUsage {
  return {
    input: (raw?.promptTokenCount ?? 0) - (raw?.cachedContentTokenCount ?? 0),
    output: (raw?.candidatesTokenCount ?? 0) + (raw?.thoughtsTokenCount ?? 0),
    ...(raw?.cachedContentTokenCount !== undefined
      ? { cacheRead: raw.cachedContentTokenCount }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

export function buildRequestParams(req: ChatRequest): GenerateContentParameters {
  const contents = convertMessages(req.messages)

  const config: GenerateContentConfig = {}
  if (req.systemPrompt) {
    config.systemInstruction = req.systemPrompt
  }
  if (req.temperature !== undefined) {
    config.temperature = req.temperature
  }
  config.maxOutputTokens = req.maxOutputTokens ?? req.model.maxOutputTokens

  if (req.tools && req.tools.length > 0) {
    config.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          // parametersJsonSchema accepts full JSON Schema draft-07 (anyOf,
          // const, etc). This is the non-obvious field name — the legacy
          // `parameters` field uses a restricted OpenAPI 3.03 subset that
          // rejects TypeBox output.
          parametersJsonSchema: t.parameters,
        })),
      },
    ]
  }

  if (req.thinkingBudget !== undefined && req.thinkingBudget > 0 && req.model.supportsThinking) {
    config.thinkingConfig = {
      thinkingBudget: req.thinkingBudget,
      includeThoughts: true,
    }
  }

  return {
    model: req.model.id,
    contents,
    config,
  }
}

// ---------------------------------------------------------------------------
// Client factory — the only thing that differs between Gemini and Vertex
// ---------------------------------------------------------------------------

export type GoogleClientFactory = (auth: LLMAuth, signal: AbortSignal) => GoogleGenAI

function createGeminiClient(auth: LLMAuth): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: auth.apiKey,
  })
}

function createVertexClient(auth: LLMAuth): GoogleGenAI {
  // Vertex AI with an API key ("Vertex AI Express Mode") — the SDK picks the
  // right host and auth header automatically.
  return new GoogleGenAI({
    vertexai: true,
    apiKey: auth.apiKey,
    apiVersion: 'v1',
  })
}

// ---------------------------------------------------------------------------
// BaseGoogleClient — shared stream / complete logic
// ---------------------------------------------------------------------------

export class BaseGoogleClient implements LLMClient {
  constructor(
    private readonly factory: GoogleClientFactory,
    private readonly label: string = 'Google',
  ) {}

  async *stream(
    request: ChatRequest,
    auth: LLMAuth,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const client = this.factory(auth, signal)
    const params = buildRequestParams(request)

    let usage: LLMUsage = { input: 0, output: 0 }
    let stopReason: StopReason = 'stop'
    let hasToolCall = false

    try {
      const streamResponse = (await client.models.generateContentStream(
        params,
      )) as AsyncIterable<GenerateContentResponse>

      for await (const chunk of streamResponse) {
        if (signal.aborted) {
          yield { type: 'finish', reason: 'aborted' }
          return
        }

        if (chunk.usageMetadata) {
          usage = mapUsage(chunk.usageMetadata as MinimalUsageMetadata)
        }

        const candidate = chunk.candidates?.[0]
        if (!candidate) continue

        for (const part of candidate.content?.parts ?? []) {
          if (part.text !== undefined && part.text !== null && part.text !== '') {
            if (isThinkingPart(part)) {
              yield { type: 'thinking-delta', delta: part.text }
            } else {
              yield { type: 'text-delta', delta: part.text }
            }
          } else if (part.functionCall) {
            hasToolCall = true
            const callId =
              part.functionCall.id ??
              `gcall_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            const name = part.functionCall.name ?? 'unknown'
            yield { type: 'tool-call-start', id: callId, name }
            yield {
              type: 'tool-call-end',
              id: callId,
              name,
              arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
            }
          }
        }

        if (candidate.finishReason) {
          stopReason = mapStopReason(candidate.finishReason, hasToolCall)
        }
      }

      yield { type: 'usage', usage }
      yield { type: 'finish', reason: stopReason }
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        yield { type: 'finish', reason: 'aborted' }
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      yield {
        type: 'finish',
        reason: 'error',
        errorMessage: `${this.label} API error: ${message}`,
      }
    }
  }

  async complete(
    request: ChatRequest,
    auth: LLMAuth,
    _signal?: AbortSignal,
  ): Promise<CompleteResult> {
    const client = this.factory(auth, _signal ?? new AbortController().signal)
    const params = buildRequestParams(request)

    const response = (await client.models.generateContent(params)) as GenerateContentResponse
    const candidate = response.candidates?.[0]
    if (!candidate?.content?.parts) {
      throw new Error(`${this.label} API returned no candidates`)
    }

    const content = convertResponseParts(candidate.content.parts)
    const hasToolCall = content.some((p) => p.type === 'toolCall')

    return {
      content,
      stopReason: mapStopReason(candidate.finishReason, hasToolCall),
      usage: mapUsage(response.usageMetadata as MinimalUsageMetadata | undefined),
    }
  }
}

export class GoogleClient extends BaseGoogleClient {
  constructor() {
    super(createGeminiClient, 'Google')
  }
}

export class VertexClient extends BaseGoogleClient {
  constructor() {
    super(createVertexClient, 'Google Vertex')
  }
}
