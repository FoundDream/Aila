/**
 * The `show-widget` wire format: the single contract shared by the system
 * prompt, the on-demand guidelines, and the renderer parser.
 *
 * A widget is a fenced code block labelled `show-widget` whose body is a JSON
 * object with a `widget_code` string. Keeping one source of truth here avoids
 * the "model emits raw HTML fence instead of JSON" failure mode.
 */

export const CANONICAL_SHOW_WIDGET_JSON =
  '{"title":"Hello","widget_code":"<div style=\'padding:8px;font:14px var(--font-sans)\'>Hello world</div>"}'

export const WIDGET_WIRE_FORMAT_SPEC = `## FINAL OUTPUT FORMAT — non-negotiable

The ONLY way to render a widget is a code fence labelled \`show-widget\` whose body is a JSON object with a \`widget_code\` string:

\`\`\`show-widget
{"title":"<human-readable title>","widget_code":"<escaped HTML/SVG string>"}
\`\`\`

- \`widget_code\` is a **JSON-encoded string**, not raw HTML. Prefer **single-quote** HTML attributes (\`<div style='...'>\`) so the JSON body never needs to escape double quotes — copy/paste-safe.
- If you absolutely need double-quote HTML attributes inside \`widget_code\`, use **one** backslash (\`\\"\`) — never two.
- Escape newlines as \`\\n\` and backslashes as \`\\\\\` inside the JSON string.
- A raw HTML fence (\`\`\`html …\`\`\`) is NEVER rendered as a widget.
- A \`show-widget\` fence whose body is HTML (not JSON) is NEVER rendered as a widget — the UI surfaces a "malformed widget" error block.
- Any HTML example shown later in the design guidelines goes **inside** \`widget_code\`. It is not the wire format.

Minimal correct example — copy/paste-safe JSON:

\`\`\`show-widget
${CANONICAL_SHOW_WIDGET_JSON}
\`\`\``

/** The fenced-code language tag streamdown emits as `language-show-widget`. */
export const WIDGET_FENCE_LANG = 'show-widget'

export interface ParsedWidget {
  /** The HTML/SVG/JS to render inside the iframe. */
  widgetCode: string
  /** Optional human-readable title. */
  title?: string
}

export type ParseWidgetResult =
  | { ok: true; widget: ParsedWidget }
  | { ok: false; partial: true } // streaming, not enough yet — render nothing/loading
  | { ok: false; partial: false; error: string; body: string } // malformed — surface it

/**
 * Extract `widget_code` (and optional `title`) from a `show-widget` fence body.
 *
 * Tolerant of streaming: while tokens are still arriving the JSON is often
 * half-finished, so a strict `JSON.parse` would throw every tick. We first try
 * a strict parse; if that fails we string-scan for a `"widget_code"` value and
 * decode whatever is present so far, reporting `partial: true` when the value
 * looks unterminated.
 *
 * @param body  The raw text inside the fence (the JSON object, possibly partial).
 * @param isStreaming  When true, an unterminated value is treated as `partial`
 *   rather than `malformed`.
 */
export function parseShowWidget(body: string, isStreaming = false): ParseWidgetResult {
  const trimmed = body.trim()
  if (!trimmed) {
    return isStreaming
      ? { ok: false, partial: true }
      : { ok: false, partial: false, error: 'Empty show-widget body.', body }
  }

  // Fast path: complete, valid JSON.
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>
    if (typeof obj.widget_code === 'string') {
      return {
        ok: true,
        widget: {
          widgetCode: obj.widget_code,
          title: typeof obj.title === 'string' ? obj.title : undefined,
        },
      }
    }
    return {
      ok: false,
      partial: false,
      error: 'JSON parsed but did not include a `widget_code` string field.',
      body,
    }
  } catch {
    // Fall through to streaming/partial extraction.
  }

  const extracted = extractStringField(trimmed, 'widget_code')
  if (extracted) {
    const title = extractStringField(trimmed, 'title')
    return {
      ok: true,
      widget: { widgetCode: extracted.value, title: title?.value },
    }
  }

  // No usable widget_code yet.
  if (isStreaming) return { ok: false, partial: true }

  // Distinguish "looks like JSON but broke" from "raw HTML in the fence".
  const looksLikeJson = trimmed.startsWith('{')
  return {
    ok: false,
    partial: false,
    error: looksLikeJson
      ? 'The `show-widget` JSON failed to parse.'
      : 'No JSON wrapper found inside `show-widget` fence (body must be a JSON object with a `widget_code` field).',
    body,
  }
}

/**
 * Scan for `"<field>": "<value>"` and JSON-decode the value, tolerating a
 * still-streaming (unterminated) value by decoding up to the last safe point.
 */
function extractStringField(
  text: string,
  field: string,
): { value: string; terminated: boolean } | null {
  const keyRe = new RegExp(`"${field}"\\s*:\\s*"`)
  const m = keyRe.exec(text)
  if (!m) return null
  const start = m.index + m[0].length

  let out = ''
  let terminated = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === undefined) break // escape split across stream boundary
      switch (next) {
        case 'n':
          out += '\n'
          break
        case 't':
          out += '\t'
          break
        case 'r':
          out += '\r'
          break
        case '"':
          out += '"'
          break
        case '\\':
          out += '\\'
          break
        case '/':
          out += '/'
          break
        case 'u': {
          const hex = text.slice(i + 2, i + 6)
          if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16))
            i += 4
          } else {
            out += next
          }
          break
        }
        default:
          out += next
      }
      i++
      continue
    }
    if (ch === '"') {
      terminated = true
      break
    }
    out += ch
  }

  return { value: out, terminated }
}
