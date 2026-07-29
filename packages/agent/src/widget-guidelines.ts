/**
 * Generative-UI ("widget") prompt + on-demand design guidelines.
 *
 * Aila's own design system — NOT CodePilot's. Key differences:
 *  - Colors are theme-driven: structure uses Aila theme vars, data viz uses a
 *    curated palette harmonized with the ink + blue brand. No hardcoded brand hue.
 *  - Diagrams are built with HTML/CSS auto-layout (flex/grid + arrow glyphs),
 *    not hand-computed SVG — robust, and correct for CJK text widths.
 *  - CJK-first typography + an accessibility/state baseline.
 *
 * This file is the single source for the wire-format spec text; the renderer
 * side of the same contract (fence tag + parser) is
 * `apps/desktop/src/shared/widget/wire-format.ts`, which keeps no copy of the
 * text. The diagram/utility class names referenced below MUST stay in sync
 * with `apps/desktop/src/shared/widget/styles.ts`.
 *
 * Self-contained on purpose: also consumed by the CLI/TUI, so no `@shared`.
 */

const CANONICAL_SHOW_WIDGET_JSON =
  '{"title":"Hello","widget_code":"<div style=\'padding:8px;font:14px var(--font-sans)\'>Hello world</div>"}'

const WIDGET_WIRE_FORMAT_SPEC = `## FINAL OUTPUT FORMAT — non-negotiable

The ONLY way to render a widget is a code fence labelled \`show-widget\` whose body is a JSON object with a \`widget_code\` string:

\`\`\`show-widget
{"title":"<human-readable title>","widget_code":"<escaped HTML/SVG string>"}
\`\`\`

- \`widget_code\` is a **JSON-encoded string**, not raw HTML. Prefer **single-quote** HTML attributes (\`<div style='...'>\`) so the JSON body never needs to escape double quotes — copy/paste-safe.
- If you absolutely need double-quote HTML attributes inside \`widget_code\`, use **one** backslash (\`\\"\`) — never two.
- Escape newlines as \`\\n\` and backslashes as \`\\\\\` inside the JSON string.
- A raw HTML fence (\`\`\`html …\`\`\`) is NEVER rendered as a widget.
- A \`show-widget\` fence whose body is HTML (not JSON) is NEVER rendered — the UI surfaces a "malformed widget" error block.

Minimal correct example — copy/paste-safe JSON:

\`\`\`show-widget
${CANONICAL_SHOW_WIDGET_JSON}
\`\`\``

const WIDGET_CAPABILITY = `<widget-capability>
You can render interactive visualizations with the \`show-widget\` code fence. The wire format is documented in the FINAL OUTPUT FORMAT block above; do not re-paraphrase it.

## Design specs
Call \`load_widget_guidelines\` BEFORE your first widget to load detailed specs.
Modules: interactive (HTML controls), chart (Chart.js), mockup (UI), art (SVG illustration), diagram (flowcharts/hierarchies/timelines).

## Required rules (always apply)
1. widget_code is a JSON string — escape quotes & newlines. No DOCTYPE/html/head/body.
2. Transparent outer background — the host card supplies the surface. Outermost element uses \`min-height\`, never \`height\`.
3. Build with HTML + CSS first (flex/grid). Built-in utility + widget classes are available — do NOT load any CSS-framework CDN.
4. Diagrams (flow / hierarchy / layers / comparison / matrix / timeline) = HTML boxes + arrow glyphs (→ ↓ ↻), NOT hand-coded SVG. Use SVG only for genuinely free-form / crossing connectors.
5. Data charts = Chart.js (allowlisted CDN). Disable the legend unless essential; call \`chart.update()\` after any data change.
6. Color: NEVER hardcode a brand hue. Structure uses theme vars (\`--color-*\`); chart/category series use the data palette (\`--w-cat-1..8\`, hex listed in the color module); accent = \`var(--w-accent)\`.
7. CJK-first: text auto-sizes — never put fixed px widths on text containers, always allow wrapping. Min font 12px. Min tap target 28px.
8. Accessibility: text-on-surface contrast ≥ 4.5:1; aria-label on icon-only controls; wrap motion in \`@media (prefers-reduced-motion: no-preference)\`.
9. Streaming order: HTML → short \`<style>\` → content → \`<script>\` last; SVG → \`<defs>\` first.
10. CDN scripts: \`onload="initFn()"\` plus an \`if(window.Lib) initFn();\` fallback.
11. Explanatory text goes OUTSIDE the fence. Multiple widgets → one fence each.
12. Title is human-readable in the user's language (e.g. "用户参与度", not "user_engagement").
13. Each widget ≤ 3500 chars. Always close the JSON object and the fence.
</widget-capability>`

/**
 * System-prompt fragment injected when a conversation needs widgets.
 * Wire-format spec first (so "documented above" holds), then the rules.
 */
export const WIDGET_SYSTEM_PROMPT = `${WIDGET_WIRE_FORMAT_SPEC}\n\n${WIDGET_CAPABILITY}`

// ── Full module guidelines (returned on demand by the tool) ─────────────────

const CORE_DESIGN_SYSTEM = `## Core design system

### Principles
- **Native, not embedded** — a widget should read as part of Aila's chat, not a foreign card. Inherit the theme; don't invent a brand color.
- **Calm & legible** — generous whitespace, one accent, restrained type. Content first, chrome last.
- **Right form for the content** — pick the type that fits (flow, hierarchy, comparison, timeline, chart, metric, mockup). Don't default to one.
- **Explain outside, show inside** — prose lives outside the fence; the widget is the visual.

### Layout
- Compose with flex/grid and the built-in utility classes. Outermost element: \`min-height\`, transparent background, no fixed pixel width.
- Spacing rhythm: 4 / 8 / 12 / 16 / 24px. Radius: \`--border-radius-md\` (8) / \`-lg\` (12). Borders: 1px \`var(--color-border-tertiary)\`.

### Typography (CJK-first)
- Font: \`var(--font-sans)\` (already applied). Weights 400 / 500 / 600 only.
- Body 14px, labels 12–13px, titles 16–20px. Never below 12px.
- NEVER set a fixed px width on a text container — CJK glyphs are ~1.7× Latin width and will clip. Let boxes size to content; cap with \`max-width\` + \`overflow-wrap:break-word\`, never a hard \`width\`.

### Color
- Structure (surfaces, text, borders) → theme vars only (see the Color module).
- Categorical / series data → the data palette \`--w-cat-1..8\`. Accent / emphasis → \`var(--w-accent)\`.
- Don't put dark or saturated fills on the outermost container.

### States & a11y
- Show empty ("暂无数据") and error states instead of rendering blank.
- Contrast ≥ 4.5:1 for text. Icon-only buttons get \`aria-label\`. Gate animation behind \`@media (prefers-reduced-motion: no-preference)\`.

### Streaming
- HTML: short \`<style>\` → content → \`<script>\` last. SVG: \`<defs>\` first.
- Solid fills (gradients/shadows flash during DOM diffs).`

const UI_COMPONENTS = `## UI components & utilities

Built-in widget classes (theme-driven — prefer these over ad-hoc styles):
- \`.w-card\` — padded bordered surface. \`.w-stat\` / \`.w-stat-value\` / \`.w-stat-label\` — metric tile.
- \`.w-chip\` — pill tag. \`.w-flow\` (wrapping row, centered) / \`.w-flow-col\` (column) — diagram tracks.
- \`.w-node\` (+ \`.w-node-accent\`, \`.w-node-sub\`) — diagram node. \`.w-arrow\` — connector glyph holder. \`.w-band\` — full-width layer.
- Generic utilities exist too: flex/grid, gap-*, p-*, text-*, rounded-*, border, font-medium, etc.

### Patterns
1. **Metric dashboard** — \`grid grid-cols-2/3\` of \`.w-stat\` tiles, optional chart below.
2. **Chart + controls** — sliders/buttons above a Chart.js canvas; controls call \`chart.update()\`.
3. **Comparison** — two-column \`grid\` of \`.w-card\`, matching rows.
4. **Calculator** — range inputs with a live \`.w-stat-value\` result.
Form elements (input/select/button/range) are pre-styled — write bare tags. Round every displayed number.`

const COLOR_PALETTE = `## Color

### Structure (use the CSS variable, never a hardcoded hue)
- Surfaces: \`--color-background-primary\` (card), \`-secondary\` (muted), \`-tertiary\`.
- Text: \`--color-text-primary\` / \`-secondary\` / \`-tertiary\`.
- Borders: \`--color-border-tertiary\` (default) / \`-secondary\` / \`-primary\` (emphasis).
- Accent / emphasis: \`var(--w-accent)\` (Aila blue). Status: \`--color-text-success|warning|danger|info\`.

### Data palette (categorical) — for chart series & category fills
HTML/SVG: use \`var(--w-cat-N)\`. Chart.js (canvas can't read CSS vars): use the hex below.

| Var | Hex | | Var | Hex |
|-----|-----|-|-----|-----|
| --w-cat-1 | #0285FF | | --w-cat-5 | #7C3AED |
| --w-cat-2 | #16A34A | | --w-cat-6 | #0891B2 |
| --w-cat-3 | #F59E0B | | --w-cat-7 | #DB2777 |
| --w-cat-4 | #E11D48 | | --w-cat-8 | #64748B |

- 1–3 categories per view is ideal; cat-1 (blue) is the default primary.
- Sequential/intensity: tint the accent with alpha — \`rgba(2,133,255,0.12 → 1)\`.
- Text on a colored fill: use white or \`--color-text-primary\`, whichever clears 4.5:1 — never a mid-tone.`

const DIAGRAM_HTML = `## Diagrams in HTML/CSS (no coordinate math, CJK-safe)

Boxes are \`.w-node\`; connect them with arrow glyphs in \`.w-arrow\` (→ horizontal, ↓ vertical, ↻ loop). Nodes auto-size to their text (incl. CJK). Color = category via \`style='border-color:var(--w-cat-N)'\` or \`.w-node-accent\`.

### Flow (process) — horizontal, wraps on narrow widths
\`<div class='w-flow'><div class='w-node'>感知<div class='w-node-sub'>Perceive</div></div><span class='w-arrow'>→</span><div class='w-node'>思考</div><span class='w-arrow'>→</span><div class='w-node'>行动</div></div>\`

### Cycle / feedback loop — row of nodes + a trailing ↻ back to start
\`<div class='w-flow'>…nodes with → between…<span class='w-arrow'>↻</span></div>\` with a caption naming the loop. (Use SVG only if you need a true drawn ring.)

### Hierarchy / tree — nested \`.w-flow-col\`, ↓ between levels
Root \`.w-node\`, then a \`w-flow\` row of children below a \`↓\`.

### Layered stack (architecture) — full-width \`.w-band\` rows
\`<div class='w-flow-col'><div class='w-band'>UI 层 …</div><div class='w-band'>服务层 …</div><div class='w-band'>基础设施 …</div></div>\` — top = user-facing, bottom = infra; tint each band's border with a different \`--w-cat-N\`.

### Comparison — \`grid grid-cols-2 gap-3\` of \`.w-card\`, matching rows.
### Matrix / quadrant — \`grid grid-cols-2\` of four tinted \`.w-card\` with axis labels around.
### Timeline — \`.w-flow\` of nodes; put the date in \`.w-node-sub\`.

### Rules
- ≤ 4 nodes per row (they wrap automatically — never force a width).
- ≤ 5 words per node title; detail goes in \`.w-node-sub\`.
- 1–3 categories; use neutral border for structural nodes, \`--w-cat-N\` for meaningful ones.`

const SVG_ILLUSTRATION = `## SVG (illustration / free-form connectors only)

Use SVG ONLY when HTML boxes can't express it (organic shapes, curved/crossing edges, true rings).
- \`<svg width="100%" viewBox="0 0 W H" preserveAspectRatio="xMidYMid meet">\` — choose W:H for the content's aspect ratio; never assume a fixed pixel width.
- Colors: \`var(--w-cat-N)\` / theme vars (SVG can read CSS vars). Fill light, stroke darker, 1–1.5px.
- Avoid baking long text into SVG (no wrapping, breaks for CJK) — prefer an HTML overlay/caption for labels.
- Arrow marker: \`<defs><marker id='a' viewBox='0 0 10 10' refX='8' refY='5' markerWidth='6' markerHeight='6' orient='auto-start-reverse'><path d='M2 1L8 5L2 9' fill='none' stroke='context-stroke' stroke-width='1.5'/></marker></defs>\`.`

const CHARTS_CHART_JS = `## Charts (Chart.js)

\`\`\`html
<div style='position:relative;width:100%;height:300px'><canvas id='c'></canvas></div>
<script src='https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js' onload='init()'></script>
<script>
var chart;
function init(){
  chart=new Chart(document.getElementById('c'),{
    type:'bar',
    data:{labels:['一月','二月','三月','四月','五月'],datasets:[{data:[30,45,28,50,42],backgroundColor:'#0285FF',borderRadius:6}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{grid:{color:'rgba(0,0,0,0.06)'}},x:{grid:{display:false}}}}
  });
}
if(window.Chart)init();
</script>
\`\`\`

### Rules
- Canvas can't read CSS vars — use the data-palette HEX (#0285FF, #16A34A, …). Single series → cat-1 blue.
- Wrapper div owns the height; \`responsive:true, maintainAspectRatio:false\`. Legend off by default.
- Bars \`borderRadius:6\`; lines \`tension:0.3\` + \`backgroundColor:'rgba(2,133,255,0.1)'\` for fill.
- Interactive controls modify \`chart.data\` then call \`chart.update()\`. Unique canvas id per chart.`

// ── Module registry ─────────────────────────────────────────────────────────

const MODULE_SECTIONS: Record<string, string[]> = {
  interactive: [CORE_DESIGN_SYSTEM, UI_COMPONENTS, COLOR_PALETTE],
  chart: [CORE_DESIGN_SYSTEM, UI_COMPONENTS, COLOR_PALETTE, CHARTS_CHART_JS],
  mockup: [CORE_DESIGN_SYSTEM, UI_COMPONENTS, COLOR_PALETTE],
  art: [CORE_DESIGN_SYSTEM, COLOR_PALETTE, SVG_ILLUSTRATION],
  diagram: [CORE_DESIGN_SYSTEM, COLOR_PALETTE, DIAGRAM_HTML, SVG_ILLUSTRATION],
}

export const WIDGET_MODULES = Object.keys(MODULE_SECTIONS)

/**
 * Re-states the wire format at the top of every guidelines response, so the
 * model doesn't lose it between reading the examples and emitting the final
 * fence (the "read example → emit raw html fence" failure mode).
 */
const GUIDELINES_WRAPPER_REMINDER = `${WIDGET_WIRE_FORMAT_SPEC}

> **Reading this document:** every HTML / CSS / Chart.js snippet below is an INTERNAL EXAMPLE — it shows what to put INSIDE the \`widget_code\` JSON string. None of the snippets below are themselves the wire format. The only wire format is the \`show-widget\` JSON fence above.`

/**
 * Assemble full guidelines from requested module names, de-duplicating shared
 * sections. Output always opens with the wire-format reminder.
 */
export function getGuidelines(moduleNames: string[]): string {
  const seen = new Set<string>()
  const parts: string[] = [GUIDELINES_WRAPPER_REMINDER]
  for (const mod of moduleNames) {
    const sections = MODULE_SECTIONS[mod.toLowerCase().trim()]
    if (!sections) continue
    for (const section of sections) {
      if (!seen.has(section)) {
        seen.add(section)
        parts.push(section)
      }
    }
  }
  return parts.join('\n\n\n')
}

// ── Keyword gate ─────────────────────────────────────────────────────────────

/**
 * Widget support is only injected when the prompt hints at generative UI, or
 * the conversation already contains a widget — saving prompt tokens otherwise.
 */
export const WIDGET_KEYWORDS =
  /可视化|图表|流程图|时间线|架构图|对比|看板|示意图|图示|visualiz|diagram|chart|flowchart|timeline|infographic|interactive|widget|show-widget|hierarchy|dashboard/i

export function promptNeedsWidget(prompt: string, conversationHasWidget = false): boolean {
  if (prompt && WIDGET_KEYWORDS.test(prompt)) return true
  return conversationHasWidget
}
