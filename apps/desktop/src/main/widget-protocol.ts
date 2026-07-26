import { buildReceiverHtml, WIDGET_CSP, WIDGET_PROTOCOL } from '@shared/widget/receiver'
import { protocol } from 'electron'

export { WIDGET_FRAME_URL, WIDGET_PROTOCOL } from '@shared/widget/receiver'

/**
 * The `aila-widget://` protocol serves the static widget receiver document
 * (see `@shared/widget/receiver`). Because it is a real custom scheme — not
 * `about:srcdoc` — the document uses the CSP delivered in this response instead
 * of inheriting the strict renderer CSP, so widget inline + CDN scripts run
 * while the main app stays locked down. The iframe is still `sandbox`ed.
 *
 * Mirrors the `aila-image://` protocol in `./images`.
 */

export function registerWidgetProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WIDGET_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ])
}

export function handleWidgetProtocol(): void {
  protocol.handle(WIDGET_PROTOCOL, async () => {
    return new Response(buildReceiverHtml(), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': WIDGET_CSP,
        'Cache-Control': 'no-cache',
      },
    })
  })
}
