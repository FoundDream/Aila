/**
 * Theme bridge between Aila's renderer tokens and the widget iframe.
 *
 * The receiver document (served from `aila-widget://`) ships with sane light
 * defaults baked in (see `styles.ts`). At runtime the renderer reads the live
 * computed values of these variables from `:root` and posts them into the
 * iframe via a `widget:theme` message, so widgets always match the app theme.
 *
 * Aila has a single light theme (`apps/desktop/src/renderer/src/assets/main.css`) and does
 * not define `--chart-*` / `--status-*` tokens — those are hardcoded in the
 * widget style bridge instead. So we only resolve the shadcn-style tokens that
 * actually exist on `:root`, plus the font tokens.
 */

/** CSS variable names resolved from the renderer's `:root` for the iframe. */
export const THEME_VAR_NAMES = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
  '--radius',
  '--blue',
  '--font-sans',
  '--font-mono',
] as const

/**
 * Read computed CSS variable values from the renderer document.
 * Renderer-only (uses `getComputedStyle`); never import from the main process.
 */
export function resolveThemeVars(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const name of THEME_VAR_NAMES) {
    const val = computed.getPropertyValue(name).trim()
    if (val) vars[name] = val
  }
  return vars
}
