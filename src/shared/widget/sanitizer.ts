/**
 * Widget HTML sanitizer.
 *
 * Security model:
 *
 * 1. **Streaming updates** (pushed to the iframe via postMessage):
 *    - Dangerous embedding tags stripped (iframe, object, embed, form, etc.)
 *    - ALL on* handlers stripped (preview is purely visual)
 *    - ALL script tags stripped
 *    - javascript:/data: URLs in href/src/action stripped
 *
 * 2. **Finalized rendering** (pushed to the iframe via postMessage):
 *    - Only dangerous embedding tags stripped
 *    - Scripts execute inside the sandboxed iframe (safe)
 *    - Handlers execute inside the sandboxed iframe (safe)
 *
 * 3. **iframe sandbox** (set by WidgetRenderer) + dedicated CSP:
 *    - `sandbox="allow-scripts"` only (no allow-same-origin)
 *    - The receiver document is served from the `aila-widget://` protocol
 *      with its own permissive CSP, so inline + whitelisted CDN scripts run
 *      without weakening the main renderer CSP. `connect-src 'none'` blocks
 *      all network access from the widget.
 *
 * Ported from CodePilot `src/lib/widget-sanitizer.ts`. Pure regex, no deps.
 */

// ── CDN whitelist ──────────────────────────────────────────────────────────

export const CDN_WHITELIST = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'esm.sh']

// ── HTML sanitization ────────────────────────────────────────────────────

const DANGEROUS_TAGS = /<(iframe|object|embed|meta|link|base|form)[\s>][\s\S]*?<\/\1>/gi
const DANGEROUS_VOID = /<(iframe|object|embed|meta|link|base)\b[^>]*\/?>/gi

/**
 * Sanitize widget HTML for streaming preview (no interactivity).
 * Strips: dangerous tags, ALL on* handlers, ALL scripts, js/data URLs.
 */
export function sanitizeForStreaming(html: string): string {
  return html
    .replace(DANGEROUS_TAGS, '')
    .replace(DANGEROUS_VOID, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']*)/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(
      /\s+(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']*))/gi,
      (match, _attr: string, dq?: string, sq?: string, uq?: string) => {
        const url = (dq ?? sq ?? uq ?? '').trim()
        if (/^\s*(javascript|data)\s*:/i.test(url)) return ''
        return match
      },
    )
}

/**
 * Light sanitization for finalized content inside the iframe.
 * Only strips tags that could nest/break out of the sandbox.
 */
export function sanitizeForIframe(html: string): string {
  return html.replace(DANGEROUS_TAGS, '').replace(DANGEROUS_VOID, '')
}
