export async function* parseSseJson<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = splitSseEvents(buffer)
      buffer = events.remainder
      for (const event of events.items) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
          .trim()
        if (!data || data === '[DONE]') continue
        yield JSON.parse(data) as T
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function splitSseEvents(buffer: string): { items: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  return {
    items: parts.slice(0, -1),
    remainder: parts.at(-1) ?? '',
  }
}
