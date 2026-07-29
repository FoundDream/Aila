import type { ModelSelection, ToolApprovalRequest, UsageInfo } from '@aila/agent'
import chalk from 'chalk'
import {
  type Component,
  type Editor,
  Key,
  Markdown,
  matchesKey,
  type OverlayHandle,
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
  | 'reasoning'
  | 'system'
  | 'tool'
  | 'user'
  | 'welcome'

export interface TranscriptEntry {
  id: string
  kind: TranscriptEntryKind
  title: string
  body: string
}

interface CachedTranscriptEntry {
  body: string
  kind: TranscriptEntryKind
  lines: string[]
  title: string
  width: number
}

export interface AilaFrameState {
  active: boolean
  approvalMode: 'safe' | 'yolo'
  conversationId: string
  dataDir: string
  inputHint?: string
  queueCount: number
  selection: ModelSelection | null
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

export class AilaFrameComponent implements Component {
  private readonly entryRenderCache = new Map<string, CachedTranscriptEntry>()
  private entries: TranscriptEntry[] = []
  private inputComponent: Component
  private state: AilaFrameState

  constructor(editor: Editor, initialState: AilaFrameState) {
    this.state = initialState
    this.inputComponent = editor
  }

  setState(patch: Partial<AilaFrameState>): void {
    this.state = { ...this.state, ...patch }
  }

  setEntries(entries: TranscriptEntry[]): void {
    this.entries = entries
  }

  setInputComponent(component: Component): void {
    this.inputComponent = component
  }

  invalidate(): void {}

  render(width: number): string[] {
    const headerLines = this.renderHeader(width)
    const inputLines = this.inputComponent.render(width).map((line) => fitLine(line, width))
    const transcript = this.renderTranscript(width)
    const footerLines = this.renderFooter(width)

    return [...headerLines, ...transcript, ...inputLines, ...footerLines].map((line) =>
      fitLine(line, width),
    )
  }

  private renderHeader(width: number): string[] {
    const state = this.state
    const left = chalk.bold.hex(AILA_TUI_COLORS.textStrong)('Aila')
    const conversation = state.conversationId
      ? chalk.hex(AILA_TUI_COLORS.dim)(`#${shortId(state.conversationId)}`)
      : ''
    const header = `${left}  ${conversation}`
    return [
      fitLine(header, width),
      chalk.hex(AILA_TUI_COLORS.border)(fitLine('─'.repeat(width), width)),
    ]
  }

  private renderFooter(width: number): string[] {
    const state = this.state
    const activity = state.active
      ? chalk.bold.hex(AILA_TUI_COLORS.accent)('● working')
      : chalk.hex(AILA_TUI_COLORS.dim)('ready')
    const queued =
      state.queueCount > 0
        ? ` · ${chalk.hex(AILA_TUI_COLORS.warning)(`${state.queueCount} queued`)}`
        : ''
    const approval =
      state.approvalMode === 'yolo'
        ? ` · ${chalk.bold.hex(AILA_TUI_COLORS.warning)('YOLO')}`
        : ''
    const model =
      width >= 72
        ? ` · ${chalk.hex(AILA_TUI_COLORS.text)(
            state.selection ? modelLabel(state.selection) : 'Model not configured',
          )}`
        : ''
    const usage = state.usage
      ? ` · tokens ${state.usage.promptTokens}/${state.usage.completionTokens}/${state.usage.totalTokens}`
      : ''
    const line = `${activity}${queued}${approval}${model} · ${state.status}${usage}`
    const hints =
      state.inputHint ??
      (width < 60
        ? 'Enter send · Ctrl+C abort · Ctrl+D exit'
        : 'Enter send · Shift+Enter newline · Ctrl+C abort · Ctrl+D exit · /help')
    return [
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
    const currentIds = new Set<string>()
    for (const entry of this.entries) {
      currentIds.add(entry.id)
      const cached = this.entryRenderCache.get(entry.id)
      if (
        cached &&
        cached.width === width &&
        cached.kind === entry.kind &&
        cached.title === entry.title &&
        cached.body === entry.body
      ) {
        lines.push(...cached.lines)
      } else {
        const rendered = this.renderEntry(entry, width)
        this.entryRenderCache.set(entry.id, {
          body: entry.body,
          kind: entry.kind,
          lines: rendered,
          title: entry.title,
          width,
        })
        lines.push(...rendered)
      }
    }
    for (const id of this.entryRenderCache.keys()) {
      if (!currentIds.has(id)) this.entryRenderCache.delete(id)
    }
    return lines
  }

  private renderEntry(entry: TranscriptEntry, width: number): string[] {
    if (entry.kind === 'welcome') return [...this.renderWelcome(entry, width), '']

    const label = this.kindLabel(entry.kind)
    const lines = [
      fitLine(`${label}${chalk.bold.hex(AILA_TUI_COLORS.textStrong)(entry.title)}`, width),
    ]
    const body = entry.body.trimEnd()
    if (body) {
      const reasoning = entry.kind === 'reasoning'
      const markdownColors = reasoning
        ? {
            ...AILA_TUI_COLORS,
            accent: AILA_TUI_COLORS.accentMuted,
            text: AILA_TUI_COLORS.dim,
            textStrong: AILA_TUI_COLORS.accentMuted,
            warning: AILA_TUI_COLORS.dim,
          }
        : AILA_TUI_COLORS
      const rendered = new Markdown(
        body,
        reasoning ? 3 : 2,
        0,
        createMarkdownTheme(markdownColors),
        {
          color: chalk.hex(reasoning ? AILA_TUI_COLORS.dim : AILA_TUI_COLORS.text),
        },
      ).render(width)
      lines.push(...rendered.map((line) => fitLine(line, width)))
    }
    lines.push('')
    return lines
  }

  private renderWelcome(entry: TranscriptEntry, width: number): string[] {
    const source = width < 60 ? compactWelcomeBody(entry.body) : entry.body.trimEnd()
    const body = new Markdown(source, 0, 0, createMarkdownTheme(), {
      color: chalk.hex(AILA_TUI_COLORS.text),
    }).render(Math.max(1, width - 6))
    return wrapPanel(
      [
        chalk.bold.hex(AILA_TUI_COLORS.accent)(entry.title),
        chalk.hex(AILA_TUI_COLORS.dim)('Local-first agent workbench'),
        '',
        ...body,
      ],
      width,
    )
  }

  private kindLabel(kind: TranscriptEntryKind): string {
    switch (kind) {
      case 'assistant':
        return chalk.bold.hex(AILA_TUI_COLORS.accent)('Aila  ')
      case 'error':
        return chalk.hex(AILA_TUI_COLORS.error)('Error  ')
      case 'image':
        return chalk.hex(AILA_TUI_COLORS.accentMuted)('Image  ')
      case 'local':
        return chalk.hex(AILA_TUI_COLORS.warning)('Local  ')
      case 'reasoning':
        return chalk.hex(AILA_TUI_COLORS.dim)('Thinking  ')
      case 'system':
        return chalk.hex(AILA_TUI_COLORS.dim)('· ')
      case 'tool':
        return chalk.hex(AILA_TUI_COLORS.accentMuted)('Tool  ')
      case 'user':
        return chalk.hex(AILA_TUI_COLORS.textStrong)('You  ')
      case 'welcome':
        return ''
    }
  }
}

function compactWelcomeBody(body: string): string {
  const lines = body.split('\n')
  const model = lines.find((line) => line.startsWith('Model:')) ?? 'Model: not connected'
  const guidance = [...lines].reverse().find((line) => line.trim().length > 0 && line !== model)
  return [model, '', guidance ?? 'Type /help for commands.'].join('\n')
}

export class PanelComponent implements Component {
  private scrollOffset = 0

  constructor(
    private readonly title: string,
    private readonly body: string,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1)
      return
    }
    if (matchesKey(data, Key.down)) {
      this.scrollOffset++
      return
    }
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
    const bodyLines = new Markdown(this.body, 0, 0, createMarkdownTheme()).render(innerWidth)
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, bodyLines.length - 1))
    const lines = [
      chalk.bold.hex(AILA_TUI_COLORS.textStrong)(this.title),
      chalk.hex(AILA_TUI_COLORS.dim)('↑↓ scroll · Esc or Enter closes'),
      '',
      ...bodyLines.slice(this.scrollOffset),
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
      this.selectedIndex === 0
        ? chalk.bold.hex(AILA_TUI_COLORS.accent)('› Approve')
        : chalk.hex(AILA_TUI_COLORS.text)('  Approve')
    const deny =
      this.selectedIndex === 1
        ? chalk.bold.hex(AILA_TUI_COLORS.error)('› Deny')
        : chalk.hex(AILA_TUI_COLORS.text)('  Deny')
    const body = [
      chalk.bold.hex(AILA_TUI_COLORS.accent)('Tool approval'),
      chalk.bold.hex(AILA_TUI_COLORS.textStrong)(this.request.name),
      chalk.hex(AILA_TUI_COLORS.dim)('Review the requested access before continuing.'),
      '',
      `${chalk.hex(AILA_TUI_COLORS.dim)('Access')}  ${metadata.access.join(' · ')}`,
      `${chalk.hex(AILA_TUI_COLORS.dim)('Scope')}   ${metadata.scope.join(' · ')}`,
      '',
      chalk.hex(AILA_TUI_COLORS.dim)('Arguments'),
      preview(JSON.stringify(this.request.args, null, 2), 1800),
      '',
      `${approve}    ${deny}`,
      chalk.hex(AILA_TUI_COLORS.dim)('←→ choose · Enter confirm · Y approve · N/Esc deny'),
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
    initialValue?: string,
  ) {
    this.list = new SelectList(items, 12, createSelectListTheme(), {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 42,
    })
    this.list.onSelect = onSelect
    this.list.onCancel = onCancel
    if (initialValue) this.list.setSelectedValue(initialValue)
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    this.list.handleInput(data)
  }

  render(width: number): string[] {
    const query = this.list.filterQuery
    const lines = [
      chalk.bold.hex(AILA_TUI_COLORS.accent)(this.title) +
        (query ? '' : chalk.hex(AILA_TUI_COLORS.dim)('  (type to search)')),
      chalk.hex(AILA_TUI_COLORS.dim)(
        query
          ? '↑↓ navigate · Enter select · Esc clear search'
          : '↑↓ navigate · Enter select · Esc cancel',
      ),
      '',
      ...(query ? [chalk.hex(AILA_TUI_COLORS.accent)('Search: ') + query, ''] : []),
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
  const top = `╭${'─'.repeat(Math.max(0, width - 2))}╮`
  const bottom = `╰${'─'.repeat(Math.max(0, width - 2))}╯`
  return [
    chalk.hex(AILA_TUI_COLORS.border)(fitLine(top, width)),
    ...lines.map((line) => {
      const fitted = fitLine(line, innerWidth)
      return (
        chalk.hex(AILA_TUI_COLORS.border)('│ ') + fitted + chalk.hex(AILA_TUI_COLORS.border)(' │')
      )
    }),
    chalk.hex(AILA_TUI_COLORS.border)(fitLine(bottom, width)),
  ]
}
