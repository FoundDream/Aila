import type { ModelSelection, ToolApprovalRequest, UsageInfo } from '@aila/agent'
import chalk from 'chalk'
import {
  type Component,
  type Editor,
  Key,
  Markdown,
  matchesKey,
  type OverlayHandle,
  type ProcessTerminal,
  type SelectItem,
  SelectList,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from './aila-tui'
import { modelLabel, preview } from './line-mode'
import { AILA_TUI_COLORS, createMarkdownTheme, createSelectListTheme } from './theme'

export type TranscriptEntryKind =
  | 'assistant'
  | 'error'
  | 'image'
  | 'local'
  | 'system'
  | 'tool'
  | 'user'

export interface TranscriptEntry {
  id: string
  kind: TranscriptEntryKind
  title: string
  body: string
}

export interface AilaFrameState {
  active: boolean
  conversationId: string
  dataDir: string
  queueCount: number
  selection: ModelSelection
  status: string
  usage?: UsageInfo
}

function fitLine(line: string, width: number): string {
  if (width <= 0) return ''
  const truncated = truncateToWidth(line, width, '')
  const missing = width - visibleWidth(truncated)
  return missing > 0 ? truncated + ' '.repeat(missing) : truncated
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function renderBadge(label: string, color: (text: string) => string): string {
  return color(`[${label}]`)
}

export class AilaFrameComponent implements Component {
  private entries: TranscriptEntry[] = []
  private state: AilaFrameState

  constructor(
    private readonly terminal: ProcessTerminal,
    private readonly editor: Editor,
    initialState: AilaFrameState,
  ) {
    this.state = initialState
  }

  setState(patch: Partial<AilaFrameState>): void {
    this.state = { ...this.state, ...patch }
  }

  setEntries(entries: TranscriptEntry[]): void {
    this.entries = entries
  }

  invalidate(): void {}

  render(width: number): string[] {
    const height = Math.max(12, this.terminal.rows)
    const headerLines = this.renderHeader(width)
    const footerLines = this.renderFooter(width)
    const editorLines = this.editor.render(width).map((line) => fitLine(line, width))
    const reserved = headerLines.length + footerLines.length + editorLines.length
    const transcriptHeight = Math.max(1, height - reserved)
    const transcript = this.renderTranscript(width).slice(-transcriptHeight)

    while (transcript.length < transcriptHeight) transcript.unshift(fitLine('', width))

    return [...headerLines, ...transcript, ...editorLines, ...footerLines].map((line) =>
      fitLine(line, width),
    )
  }

  private renderHeader(width: number): string[] {
    const state = this.state
    const status = state.active
      ? renderBadge('running', chalk.hex(AILA_TUI_COLORS.accent))
      : '[idle]'
    const queued =
      state.queueCount > 0
        ? ` ${renderBadge(`${state.queueCount} queued`, chalk.hex(AILA_TUI_COLORS.warning))}`
        : ''
    const left = chalk.bold.hex(AILA_TUI_COLORS.textStrong)('Aila')
    const model = chalk.hex(AILA_TUI_COLORS.text)(modelLabel(state.selection))
    const header = `${left} ${status}${queued} | ${model} | conv:${shortId(state.conversationId)}`
    return [
      fitLine(header, width),
      chalk.hex(AILA_TUI_COLORS.border)(fitLine('-'.repeat(width), width)),
    ]
  }

  private renderFooter(width: number): string[] {
    const state = this.state
    const usage = state.usage
      ? ` | tokens ${state.usage.promptTokens}/${state.usage.completionTokens}/${state.usage.totalTokens}`
      : ''
    const line = `${state.status}${usage}`
    const hints = 'enter: send | shift+enter: newline | ctrl+c: abort | ctrl+d: exit | /help'
    return [
      chalk.hex(AILA_TUI_COLORS.border)(fitLine('-'.repeat(width), width)),
      fitLine(chalk.hex(AILA_TUI_COLORS.dim)(line), width),
      fitLine(chalk.hex(AILA_TUI_COLORS.dim)(hints), width),
    ]
  }

  private renderTranscript(width: number): string[] {
    if (this.entries.length === 0) {
      return [
        fitLine(chalk.hex(AILA_TUI_COLORS.dim)('Start typing, or use /help for commands.'), width),
      ]
    }

    const lines: string[] = []
    for (const entry of this.entries) {
      const label = this.kindLabel(entry.kind)
      lines.push(
        fitLine(`${label} ${chalk.bold.hex(AILA_TUI_COLORS.textStrong)(entry.title)}`, width),
      )
      const body = entry.body.trimEnd()
      if (body) {
        const rendered = new Markdown(body, 2, 0, createMarkdownTheme(), {
          color: chalk.hex(AILA_TUI_COLORS.text),
        }).render(width)
        lines.push(...rendered.map((line) => fitLine(line, width)))
      }
      lines.push('')
    }
    return lines
  }

  private kindLabel(kind: TranscriptEntryKind): string {
    switch (kind) {
      case 'assistant':
        return chalk.hex(AILA_TUI_COLORS.accent)('[aila]')
      case 'error':
        return chalk.hex(AILA_TUI_COLORS.error)('[error]')
      case 'image':
        return chalk.hex(AILA_TUI_COLORS.accentMuted)('[image]')
      case 'local':
        return chalk.hex(AILA_TUI_COLORS.warning)('[local]')
      case 'system':
        return chalk.hex(AILA_TUI_COLORS.dim)('[system]')
      case 'tool':
        return chalk.hex(AILA_TUI_COLORS.accentMuted)('[tool]')
      case 'user':
        return chalk.hex(AILA_TUI_COLORS.textStrong)('[you]')
    }
  }
}

export class PanelComponent implements Component {
  constructor(
    private readonly title: string,
    private readonly body: string,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.ctrl('c'))
    ) {
      this.onClose()
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(10, width - 4)
    const lines = [
      chalk.bold.hex(AILA_TUI_COLORS.textStrong)(this.title),
      chalk.hex(AILA_TUI_COLORS.dim)('esc/enter closes'),
      '',
      ...new Markdown(this.body, 0, 0, createMarkdownTheme()).render(innerWidth),
    ]
    return wrapPanel(lines, width)
  }
}

export class ApprovalDialog implements Component {
  private selectedIndex = 0

  constructor(
    private readonly request: ToolApprovalRequest,
    private readonly onResolve: (approved: boolean) => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.selectedIndex = this.selectedIndex === 0 ? 1 : 0
      return
    }
    if (matchesKey(data, Key.enter)) {
      this.onResolve(this.selectedIndex === 0)
      return
    }
    if (matchesKey(data, 'y')) {
      this.onResolve(true)
      return
    }
    if (matchesKey(data, 'n') || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.onResolve(false)
    }
  }

  render(width: number): string[] {
    const metadata = this.request.metadata
    const approve =
      this.selectedIndex === 0 ? chalk.bold.hex(AILA_TUI_COLORS.accent)('[approve]') : '[approve]'
    const deny =
      this.selectedIndex === 1 ? chalk.bold.hex(AILA_TUI_COLORS.error)('[deny]') : '[deny]'
    const body = [
      chalk.bold.hex(AILA_TUI_COLORS.textStrong)(`Approve tool: ${this.request.name}`),
      `access: ${metadata.access.join(', ')}`,
      `scope: ${metadata.scope.join(', ')}`,
      '',
      preview(JSON.stringify(this.request.args, null, 2), 1800),
      '',
      `${approve}  ${deny}`,
      chalk.hex(AILA_TUI_COLORS.dim)('y/n, arrows, enter, esc'),
    ]
    return wrapPanel(body, width)
  }
}

export class PickerDialog implements Component {
  private readonly list: SelectList

  constructor(
    private readonly title: string,
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    onCancel: () => void,
  ) {
    this.list = new SelectList(items, 12, createSelectListTheme(), {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 42,
    })
    this.list.onSelect = onSelect
    this.list.onCancel = onCancel
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    this.list.handleInput(data)
  }

  render(width: number): string[] {
    const lines = [
      chalk.bold.hex(AILA_TUI_COLORS.textStrong)(this.title),
      chalk.hex(AILA_TUI_COLORS.dim)('up/down selects, enter confirms, esc cancels'),
      '',
      ...this.list.render(Math.max(10, width - 4)),
    ]
    return wrapPanel(lines, width)
  }
}

export function showPanelOverlay(ui: TUI, title: string, body: string): void {
  let handle: OverlayHandle | null = null
  const close = () => {
    handle?.hide()
  }
  handle = ui.showOverlay(new PanelComponent(title, body, close), {
    width: '80%',
    minWidth: 50,
    maxHeight: '80%',
    margin: 1,
  })
}

export function wrapPanel(lines: string[], width: number): string[] {
  const innerWidth = Math.max(1, width - 4)
  const top = `+${'-'.repeat(Math.max(0, width - 2))}+`
  const bottom = top
  return [
    chalk.hex(AILA_TUI_COLORS.border)(fitLine(top, width)),
    ...lines.map((line) => {
      const fitted = fitLine(line, innerWidth)
      return (
        chalk.hex(AILA_TUI_COLORS.border)('| ') + fitted + chalk.hex(AILA_TUI_COLORS.border)(' |')
      )
    }),
    chalk.hex(AILA_TUI_COLORS.border)(fitLine(bottom, width)),
  ]
}
