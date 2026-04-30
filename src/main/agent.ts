/**
 * Minimal agent loop backed by OpenRouter.
 *
 * No tools, no persistence — caller passes the full message history each turn,
 * we stream back text and reasoning deltas.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamHandlers {
  onTextDelta: (delta: string) => void
  onReasoningDelta: (delta: string) => void
  onDone: (full: { text: string; reasoning: string }) => void
  onError: (message: string) => void
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

interface OpenRouterDelta {
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
}

interface OpenRouterStreamChunk {
  choices?: Array<{
    delta?: OpenRouterDelta
    finish_reason?: string | null
  }>
}

export async function streamChat(
  messages: ChatMessage[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY
  const model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3.1'

  if (!apiKey) {
    handlers.onError('OPENROUTER_API_KEY is not set. Add it to .env and restart the app.')
    return
  }

  let fullText = ''
  let fullReasoning = ''

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'Aila',
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages,
      }),
    })

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      handlers.onError(`OpenRouter ${response.status}: ${text || response.statusText}`)
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by blank lines, but each `data:` line is parseable on its own.
      while (true) {
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex === -1) break
        const rawLine = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)

        if (!rawLine.startsWith('data:')) continue
        const data = rawLine.slice(5).trim()
        if (!data || data === '[DONE]') continue

        let chunk: OpenRouterStreamChunk
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }

        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue

        const reasoning = delta.reasoning ?? delta.reasoning_content
        if (reasoning) {
          fullReasoning += reasoning
          handlers.onReasoningDelta(reasoning)
        }
        if (delta.content) {
          fullText += delta.content
          handlers.onTextDelta(delta.content)
        }
      }
    }

    handlers.onDone({ text: fullText, reasoning: fullReasoning })
  } catch (error) {
    if (signal.aborted) {
      handlers.onDone({ text: fullText, reasoning: fullReasoning })
      return
    }
    handlers.onError(error instanceof Error ? error.message : String(error))
  }
}
