/**
 * Static CSS injected into the widget receiver document.
 *
 * Three parts:
 *  1. `:root` defaults — Aila's light theme values so widgets are styled even
 *     before the renderer posts live `widget:theme` values.
 *  2. CSS variable bridge — maps the design-guideline variable names
 *     (`--color-text-primary`, …) the model is told to use onto Aila tokens.
 *     Aila has no `--chart-*` / `--status-*` tokens, so those are hardcoded.
 *  3. Utility classes + form styles (ported from CodePilot's css-bridge) so
 *     widgets can use Tailwind-like class names without loading a CDN.
 *
 * Single light theme only — no `.dark` branch.
 */

// ── :root light defaults (mirror apps/desktop/src/renderer/src/assets/main.css) ──────────
const ROOT_DEFAULTS = /* css */ `
:root {
  --background: #ffffff;
  --foreground: #0d0d0d;
  --card: #ffffff;
  --card-foreground: #0d0d0d;
  --popover: #ffffff;
  --popover-foreground: #0d0d0d;
  --primary: #0d0d0d;
  --primary-foreground: #ffffff;
  --secondary: rgba(0,0,0,0.07);
  --secondary-foreground: #0d0d0d;
  --muted: #f7f7f7;
  --muted-foreground: #5d5d5d;
  --accent: rgba(0,0,0,0.07);
  --accent-foreground: #0d0d0d;
  --destructive: #c4442a;
  --destructive-foreground: #ffffff;
  --border: #e8e8e8;
  --input: #d9d9d9;
  --ring: #d9d9d9;
  --radius: 0.75rem;
  --blue: #0285ff;
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Inter", system-ui, sans-serif;
  --font-mono: "SF Mono", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace;
}
`

// ── CSS variable bridge (guideline names → Aila tokens / hardcoded) ─────────
const WIDGET_CSS_BRIDGE = /* css */ `
/* Backgrounds */
--color-background-primary:   var(--background);
--color-background-secondary: var(--muted);
--color-background-tertiary:  color-mix(in srgb, var(--muted-foreground) 10%, var(--background));
--color-background-info:      #F0F9FF;
--color-background-danger:    #FFF1F2;
--color-background-success:   #ECFDF5;
--color-background-warning:   #FFFBEB;

/* Text */
--color-text-primary:         var(--foreground);
--color-text-secondary:       var(--muted-foreground);
--color-text-tertiary:        color-mix(in srgb, var(--muted-foreground) 60%, transparent);
--color-text-info:            #0284C7;
--color-text-danger:          #E11D48;
--color-text-success:         #059669;
--color-text-warning:         #D97706;

/* Borders */
--color-border-tertiary:      var(--border);
--color-border-secondary:     var(--border);
--color-border-primary:       color-mix(in srgb, var(--foreground) 40%, transparent);
--color-border-info:          #BAE6FD;
--color-border-danger:        #FECDD3;
--color-border-success:       #A7F3D0;
--color-border-warning:       #FDE68A;

/* Typography */
--font-serif:                 Georgia, 'Times New Roman', serif;

/* Layout */
--border-radius-md:           8px;
--border-radius-lg:           12px;
--border-radius-xl:           16px;

/* Accent + categorical data palette (harmonized with Aila ink + blue).
   HTML/SVG read these vars; Chart.js uses the hex (see guidelines). */
--w-accent:                   var(--blue, #0285FF);
--w-cat-1:                    #0285FF;
--w-cat-2:                    #16A34A;
--w-cat-3:                    #F59E0B;
--w-cat-4:                    #E11D48;
--w-cat-5:                    #7C3AED;
--w-cat-6:                    #0891B2;
--w-cat-7:                    #DB2777;
--w-cat-8:                    #64748B;
`

// ── Utility classes (ported verbatim from CodePilot, unscoped) ──────────────
const WIDGET_UTILITIES = /* css */ `
/* Display */
.hidden { display: none; }
.block { display: block; }
.inline-block { display: inline-block; }
.inline { display: inline; }
.flex { display: flex; }
.inline-flex { display: inline-flex; }
.grid { display: grid; }

/* Flex */
.flex-col { flex-direction: column; }
.flex-row { flex-direction: row; }
.flex-wrap { flex-wrap: wrap; }
.flex-1 { flex: 1 1 0%; }
.flex-auto { flex: 1 1 auto; }
.flex-none { flex: none; }
.shrink-0 { flex-shrink: 0; }
.grow { flex-grow: 1; }
.items-start { align-items: flex-start; }
.items-center { align-items: center; }
.items-end { align-items: flex-end; }
.items-stretch { align-items: stretch; }
.justify-start { justify-content: flex-start; }
.justify-center { justify-content: center; }
.justify-end { justify-content: flex-end; }
.justify-between { justify-content: space-between; }
.justify-around { justify-content: space-around; }
.self-start { align-self: flex-start; }
.self-center { align-self: center; }
.self-end { align-self: flex-end; }

/* Grid */
.grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
.grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.col-span-2 { grid-column: span 2 / span 2; }
.col-span-3 { grid-column: span 3 / span 3; }
.col-span-full { grid-column: 1 / -1; }

/* Gap */
.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
.gap-3 { gap: 12px; }
.gap-4 { gap: 16px; }
.gap-5 { gap: 20px; }
.gap-6 { gap: 24px; }
.gap-8 { gap: 32px; }

/* Margin */
.m-0 { margin: 0; }
.m-1 { margin: 4px; }
.m-2 { margin: 8px; }
.m-3 { margin: 12px; }
.m-4 { margin: 16px; }
.mx-auto { margin-left: auto; margin-right: auto; }
.ml-auto { margin-left: auto; }
.mr-auto { margin-right: auto; }
.mt-1 { margin-top: 4px; }
.mt-2 { margin-top: 8px; }
.mt-3 { margin-top: 12px; }
.mt-4 { margin-top: 16px; }
.mb-1 { margin-bottom: 4px; }
.mb-2 { margin-bottom: 8px; }
.mb-3 { margin-bottom: 12px; }
.mb-4 { margin-bottom: 16px; }
.mb-6 { margin-bottom: 24px; }
.ml-1 { margin-left: 4px; }
.ml-2 { margin-left: 8px; }
.mr-1 { margin-right: 4px; }
.mr-2 { margin-right: 8px; }
.my-1 { margin-top: 4px; margin-bottom: 4px; }
.my-2 { margin-top: 8px; margin-bottom: 8px; }

/* Padding */
.p-0 { padding: 0; }
.p-1 { padding: 4px; }
.p-2 { padding: 8px; }
.p-3 { padding: 12px; }
.p-4 { padding: 16px; }
.p-5 { padding: 20px; }
.p-6 { padding: 24px; }
.px-1 { padding-left: 4px; padding-right: 4px; }
.px-2 { padding-left: 8px; padding-right: 8px; }
.px-3 { padding-left: 12px; padding-right: 12px; }
.px-4 { padding-left: 16px; padding-right: 16px; }
.py-1 { padding-top: 4px; padding-bottom: 4px; }
.py-2 { padding-top: 8px; padding-bottom: 8px; }
.py-3 { padding-top: 12px; padding-bottom: 12px; }
.py-4 { padding-top: 16px; padding-bottom: 16px; }
.pt-1 { padding-top: 4px; }
.pt-2 { padding-top: 8px; }
.pb-1 { padding-bottom: 4px; }
.pb-2 { padding-bottom: 8px; }
.pl-2 { padding-left: 8px; }
.pl-4 { padding-left: 16px; }

/* Space between children */
.space-y-1 > * + * { margin-top: 4px; }
.space-y-2 > * + * { margin-top: 8px; }
.space-y-3 > * + * { margin-top: 12px; }
.space-y-4 > * + * { margin-top: 16px; }
.space-x-1 > * + * { margin-left: 4px; }
.space-x-2 > * + * { margin-left: 8px; }
.space-x-3 > * + * { margin-left: 12px; }
.space-x-4 > * + * { margin-left: 16px; }

/* Width / Height */
.w-full { width: 100%; }
.w-auto { width: auto; }
.w-8 { width: 32px; }
.w-10 { width: 40px; }
.w-12 { width: 48px; }
.w-16 { width: 64px; }
.w-20 { width: 80px; }
.w-24 { width: 96px; }
.w-32 { width: 128px; }
.w-40 { width: 160px; }
.w-48 { width: 192px; }
.w-1\\/2 { width: 50%; }
.w-1\\/3 { width: 33.333333%; }
.w-2\\/3 { width: 66.666667%; }
.min-w-0 { min-width: 0; }
.max-w-full { max-width: 100%; }
.max-w-xs { max-width: 320px; }
.max-w-sm { max-width: 384px; }
.max-w-md { max-width: 448px; }
.max-w-lg { max-width: 512px; }
.h-1 { height: 4px; }
.h-2 { height: 8px; }
.h-3 { height: 12px; }
.h-4 { height: 16px; }
.h-5 { height: 20px; }
.h-6 { height: 24px; }
.h-8 { height: 32px; }
.h-10 { height: 40px; }
.h-12 { height: 48px; }
.h-full { height: 100%; }
.h-auto { height: auto; }
.min-h-0 { min-height: 0; }

/* Typography */
.text-\\[10px\\] { font-size: 10px; line-height: 1.4; }
.text-xs { font-size: 12px; line-height: 1.5; }
.text-sm { font-size: 14px; line-height: 1.5; }
.text-base { font-size: 16px; line-height: 1.6; }
.text-lg { font-size: 18px; line-height: 1.6; }
.text-xl { font-size: 20px; line-height: 1.4; }
.text-2xl { font-size: 24px; line-height: 1.3; }
.text-3xl { font-size: 30px; line-height: 1.2; }
.text-4xl { font-size: 36px; line-height: 1.15; }
.font-normal { font-weight: 400; }
.font-medium { font-weight: 500; }
.font-semibold { font-weight: 600; }
.font-bold { font-weight: 700; }
.text-left { text-align: left; }
.text-center { text-align: center; }
.text-right { text-align: right; }
.uppercase { text-transform: uppercase; }
.lowercase { text-transform: lowercase; }
.capitalize { text-transform: capitalize; }
.leading-tight { line-height: 1.25; }
.leading-snug { line-height: 1.375; }
.leading-normal { line-height: 1.5; }
.leading-relaxed { line-height: 1.625; }
.tracking-tight { letter-spacing: -0.025em; }
.tracking-wide { letter-spacing: 0.025em; }
.tabular-nums { font-variant-numeric: tabular-nums; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.whitespace-nowrap { white-space: nowrap; }
.break-words { overflow-wrap: break-word; }
.font-mono { font-family: var(--font-mono); }

/* Border radius */
.rounded { border-radius: 8px; }
.rounded-md { border-radius: 8px; }
.rounded-lg { border-radius: 12px; }
.rounded-xl { border-radius: 16px; }
.rounded-2xl { border-radius: 20px; }
.rounded-full { border-radius: 9999px; }
.rounded-none { border-radius: 0; }

/* Borders */
.border { border: 1px solid var(--color-border-tertiary); }
.border-0 { border-width: 0; }
.border-2 { border-width: 2px; }
.border-t { border-top: 1px solid var(--color-border-tertiary); }
.border-b { border-bottom: 1px solid var(--color-border-tertiary); }
.border-l { border-left: 1px solid var(--color-border-tertiary); }
.border-r { border-right: 1px solid var(--color-border-tertiary); }

/* Overflow */
.overflow-hidden { overflow: hidden; }
.overflow-auto { overflow: auto; }
.overflow-x-auto { overflow-x: auto; }
.overflow-y-auto { overflow-y: auto; }
.overflow-visible { overflow: visible; }

/* Position */
.relative { position: relative; }
.absolute { position: absolute; }
.sticky { position: sticky; }
.inset-0 { top: 0; right: 0; bottom: 0; left: 0; }
.top-0 { top: 0; }
.right-0 { right: 0; }
.bottom-0 { bottom: 0; }
.left-0 { left: 0; }

/* Misc */
.opacity-50 { opacity: 0.5; }
.opacity-75 { opacity: 0.75; }
.cursor-pointer { cursor: pointer; }
.select-none { user-select: none; }
.transition { transition: all 0.15s ease; }
.transition-colors { transition: color 0.15s, background-color 0.15s, border-color 0.15s; }
.transition-opacity { transition: opacity 0.15s; }
.shadow-sm { box-shadow: 0 1px 2px rgba(0,0,0,0.05); }

/* Surface colors */
.bg-surface-primary { background-color: var(--color-background-primary); }
.bg-surface-secondary { background-color: var(--color-background-secondary); }
.bg-surface-tertiary { background-color: var(--color-background-tertiary); }
.bg-transparent { background-color: transparent; }
.bg-white { background-color: #fff; }
.bg-black { background-color: #000; }

/* Text semantic colors */
.text-content-primary { color: var(--color-text-primary); }
.text-content-secondary { color: var(--color-text-secondary); }
.text-content-tertiary { color: var(--color-text-tertiary); }
.text-info { color: var(--color-text-info); }
.text-success { color: var(--color-text-success); }
.text-warning { color: var(--color-text-warning); }
.text-danger { color: var(--color-text-danger); }
.text-white { color: #fff; }
.text-black { color: #000; }

/* Border semantic colors */
.border-content-tertiary { border-color: var(--color-text-tertiary); }
.border-info { border-color: var(--color-border-info); }
.border-success { border-color: var(--color-border-success); }
.border-warning { border-color: var(--color-border-warning); }
.border-danger { border-color: var(--color-border-danger); }

/* Color ramps (indigo) */
.bg-indigo-50 { background-color: #EEF2FF; }
.bg-indigo-100 { background-color: #E0E7FF; }
.bg-indigo-200 { background-color: #C7D2FE; }
.bg-indigo-400 { background-color: #818CF8; }
.bg-indigo-500 { background-color: #6366F1; }
.bg-indigo-600 { background-color: #4F46E5; }
.bg-indigo-800 { background-color: #3730A3; }
.text-indigo-600 { color: #4F46E5; }
.text-indigo-800 { color: #3730A3; }
.text-indigo-900 { color: #312E81; }
.border-indigo-200 { border-color: #C7D2FE; }
.border-indigo-400 { border-color: #818CF8; }

/* Color ramps (emerald) */
.bg-emerald-50 { background-color: #ECFDF5; }
.bg-emerald-100 { background-color: #D1FAE5; }
.bg-emerald-200 { background-color: #A7F3D0; }
.bg-emerald-400 { background-color: #34D399; }
.bg-emerald-500 { background-color: #10B981; }
.bg-emerald-600 { background-color: #059669; }
.text-emerald-600 { color: #059669; }
.text-emerald-800 { color: #065F46; }
.border-emerald-200 { border-color: #A7F3D0; }

/* Color ramps (amber) */
.bg-amber-50 { background-color: #FFFBEB; }
.bg-amber-100 { background-color: #FEF3C7; }
.bg-amber-200 { background-color: #FDE68A; }
.bg-amber-400 { background-color: #FBBF24; }
.bg-amber-500 { background-color: #F59E0B; }
.bg-amber-600 { background-color: #D97706; }
.text-amber-600 { color: #D97706; }
.text-amber-800 { color: #92400E; }
.border-amber-200 { border-color: #FDE68A; }

/* Color ramps (rose) */
.bg-rose-50 { background-color: #FFF1F2; }
.bg-rose-100 { background-color: #FFE4E6; }
.bg-rose-200 { background-color: #FECDD3; }
.bg-rose-400 { background-color: #FB7185; }
.bg-rose-500 { background-color: #F43F5E; }
.bg-rose-600 { background-color: #E11D48; }
.text-rose-600 { color: #E11D48; }
.text-rose-800 { color: #9F1239; }
.border-rose-200 { border-color: #FECDD3; }

/* Color ramps (sky) */
.bg-sky-50 { background-color: #F0F9FF; }
.bg-sky-100 { background-color: #E0F2FE; }
.bg-sky-200 { background-color: #BAE6FD; }
.bg-sky-400 { background-color: #38BDF8; }
.bg-sky-500 { background-color: #0EA5E9; }
.bg-sky-600 { background-color: #0284C7; }
.text-sky-600 { color: #0284C7; }
.text-sky-800 { color: #075985; }
.border-sky-200 { border-color: #BAE6FD; }

/* Color ramps (slate) */
.bg-slate-50 { background-color: #F8FAFC; }
.bg-slate-100 { background-color: #F1F5F9; }
.bg-slate-200 { background-color: #E2E8F0; }
.bg-slate-400 { background-color: #94A3B8; }
.bg-slate-600 { background-color: #64748B; }
.bg-slate-800 { background-color: #334155; }
.text-slate-400 { color: #94A3B8; }
.text-slate-500 { color: #64748B; }
.text-slate-600 { color: #475569; }
.text-slate-800 { color: #334155; }
.border-slate-200 { border-color: #E2E8F0; }
`

// ── Form element styles (ported verbatim) ───────────────────────────────────
const FORM_STYLES = /* css */ `
input[type="range"] {
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--color-border-tertiary);
  border-radius: 2px;
  outline: none;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--color-text-primary);
  cursor: pointer;
}
input[type="text"],
input[type="number"],
select,
textarea {
  height: 36px;
  padding: 0 10px;
  border: 0.5px solid var(--color-border-secondary);
  border-radius: var(--border-radius-md);
  background: var(--color-background-primary);
  color: var(--color-text-primary);
  font-size: 14px;
  font-family: var(--font-sans);
  outline: none;
}
input:focus,
select:focus,
textarea:focus {
  border-color: var(--color-border-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-border-primary) 30%, transparent);
}
button {
  background: transparent;
  border: 0.5px solid var(--color-border-secondary);
  border-radius: var(--border-radius-md);
  padding: 6px 14px;
  font-size: 14px;
  font-family: var(--font-sans);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}
button:hover { background: var(--color-background-tertiary); }
button:active { transform: scale(0.98); }
`

// ── Widget primitives (theme-driven building blocks for diagrams/cards) ─────
// Class names MUST stay in sync with packages/agent/src/widget-guidelines.ts.
const WIDGET_PRIMITIVES = /* css */ `
.w-card {
  padding: 12px 14px;
  border: 1px solid var(--color-border-tertiary);
  border-radius: var(--border-radius-lg);
  background: var(--color-background-primary);
}
.w-stat { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border: 1px solid var(--color-border-tertiary); border-radius: var(--border-radius-lg); background: var(--color-background-primary); }
.w-stat-value { font-size: 24px; font-weight: 600; line-height: 1.1; color: var(--color-text-primary); }
.w-stat-label { font-size: 12px; color: var(--color-text-secondary); }
.w-chip { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 9999px; font-size: 12px; background: var(--color-background-secondary); color: var(--color-text-secondary); }
.w-flow { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.w-flow-col { display: flex; flex-direction: column; gap: 10px; }
.w-node {
  display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; gap: 2px;
  padding: 10px 14px; min-height: 28px; max-width: 220px;
  border: 1px solid var(--color-border-tertiary); border-radius: 10px;
  background: var(--color-background-primary); color: var(--color-text-primary);
  font-weight: 500; line-height: 1.4; overflow-wrap: break-word;
}
.w-node-accent { border-color: var(--w-accent); }
.w-node-sub { font-weight: 400; font-size: 12px; color: var(--color-text-secondary); }
.w-arrow { flex: none; color: var(--color-text-tertiary); font-size: 18px; line-height: 1; user-select: none; }
.w-band {
  display: flex; align-items: center; gap: 12px; width: 100%;
  padding: 12px 14px; border: 1px solid var(--color-border-tertiary);
  border-radius: var(--border-radius-lg); background: var(--color-background-secondary);
}
`

/**
 * Full CSS content for the widget receiver document's `<style>` block.
 * Static — runtime theme values arrive separately via a `widget:theme` message.
 */
export function getWidgetStaticCss(): string {
  return `
${ROOT_DEFAULTS}
body {
${WIDGET_CSS_BRIDGE}
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.7;
  color: var(--color-text-primary);
  background: transparent;
}
* { box-sizing: border-box; }
a { color: var(--color-text-info); text-decoration: none; cursor: pointer; }
a:hover { text-decoration: underline; }
${WIDGET_UTILITIES}
${FORM_STYLES}
${WIDGET_PRIMITIVES}
@keyframes widgetFadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
`
}
