import { stdin, stdout } from 'node:process'

const ESC_PATTERN = '\\x1b'
const BEL_PATTERN = '\\x07'
const ANSI_RE = new RegExp(
  `${ESC_PATTERN}\\[[0-9;?]*[ -/]*[@-~]|${ESC_PATTERN}\\][^${BEL_PATTERN}]*(?:${BEL_PATTERN}|${ESC_PATTERN}\\\\)`,
  'g',
)

export interface Component {
  render(width: number): string[]
  handleInput?(data: string): void
  invalidate(): void
}

export interface Focusable {
  focused: boolean
}

export type SizeValue = number | `${number}%`
export type OverlayAnchor = 'center'

export interface OverlayOptions {
  width?: SizeValue
  minWidth?: number
  maxHeight?: SizeValue
  anchor?: OverlayAnchor
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number }
}

export interface OverlayHandle {
  hide(): void
  setHidden(hidden: boolean): void
  isHidden(): boolean
  focus(): void
  unfocus(): void
  isFocused(): boolean
}

export interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void
  stop(): void
  drainInput(maxMs?: number, idleMs?: number): Promise<void>
  write(data: string): void
  readonly columns: number
  readonly rows: number
  moveBy(lines: number): void
  hideCursor(): void
  showCursor(): void
  clearLine(): void
  clearFromCursor(): void
  clearScreen(): void
  setTitle(title: string): void
  setProgress(active: boolean): void
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined
type InputListener = (data: string) => InputListenerResult

interface OverlayEntry {
  component: Component
  hidden: boolean
  focused: boolean
  options: OverlayOptions
}

export class ProcessTerminal implements Terminal {
  private inputHandler?: (data: string) => void
  private resizeHandler?: () => void
  private progressTimer?: ReturnType<typeof setInterval>
  private wasRaw = false

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = (data) => {
      for (const token of splitTerminalInput(data)) onInput(token)
    }
    this.resizeHandler = onResize
    this.wasRaw = Boolean(stdin.isTTY && stdin.isRaw)
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    stdin.on('data', this.inputHandler)
    process.on('SIGWINCH', onResize)
    this.hideCursor()
    this.write('\x1b[?2004h')
  }

  stop(): void {
    if (this.inputHandler) stdin.off('data', this.inputHandler)
    if (this.resizeHandler) process.off('SIGWINCH', this.resizeHandler)
    this.inputHandler = undefined
    this.resizeHandler = undefined
    this.setProgress(false)
    this.write('\x1b[?2004l')
    this.showCursor()
    if (stdin.isTTY) stdin.setRawMode(this.wasRaw)
    stdin.pause()
  }

  async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(maxMs, idleMs))
      timer.unref?.()
    })
  }

  write(data: string): void {
    stdout.write(data)
  }

  get columns(): number {
    return stdout.columns ?? 80
  }

  get rows(): number {
    return stdout.rows ?? 24
  }

  moveBy(lines: number): void {
    if (lines > 0) this.write(`\x1b[${lines}B`)
    if (lines < 0) this.write(`\x1b[${Math.abs(lines)}A`)
  }

  hideCursor(): void {
    this.write('\x1b[?25l')
  }

  showCursor(): void {
    this.write('\x1b[?25h')
  }

  clearLine(): void {
    this.write('\x1b[2K')
  }

  clearFromCursor(): void {
    this.write('\x1b[J')
  }

  clearScreen(): void {
    this.write('\x1b[2J\x1b[H')
  }

  setTitle(title: string): void {
    this.write(`\x1b]0;${title}\x07`)
  }

  setProgress(active: boolean): void {
    if (!active) {
      if (this.progressTimer) clearInterval(this.progressTimer)
      this.progressTimer = undefined
      this.write('\x1b]9;4;0;\x07')
      return
    }
    if (this.progressTimer) return
    let value = 5
    this.progressTimer = setInterval(() => {
      value = value >= 90 ? 5 : value + 5
      this.write(`\x1b]9;4;1;${value}\x07`)
    }, 500)
    this.progressTimer.unref?.()
  }
}

export class Container implements Component {
  children: Component[] = []

  addChild(component: Component): void {
    this.children.push(component)
  }

  removeChild(component: Component): void {
    this.children = this.children.filter((child) => child !== component)
  }

  clear(): void {
    this.children = []
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate()
  }

  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width))
  }
}

export class TUI extends Container {
  private focusedComponent: Component | null = null
  private inputListeners = new Set<InputListener>()
  private overlayStack: OverlayEntry[] = []
  private previousLines: string[] = []
  private previousWidth = 0
  private previousHeight = 0
  private renderRequested = false
  private stopped = false

  constructor(
    public readonly terminal: Terminal,
    private showHardwareCursor = false,
  ) {
    super()
  }

  start(): void {
    this.stopped = false
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.requestRender(true),
    )
    this.requestRender(true)
  }

  stop(): void {
    this.stopped = true
    this.terminal.stop()
  }

  setFocus(component: Component | null): void {
    if (this.focusedComponent && 'focused' in this.focusedComponent) {
      ;(this.focusedComponent as Component & Focusable).focused = false
    }
    this.focusedComponent = component
    if (component && 'focused' in component) {
      ;(component as Component & Focusable).focused = true
    }
    this.requestRender()
  }

  setShowHardwareCursor(enabled: boolean): void {
    this.showHardwareCursor = enabled
  }

  addInputListener(listener: InputListener): () => void {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }

  removeInputListener(listener: InputListener): void {
    this.inputListeners.delete(listener)
  }

  showOverlay(component: Component, options: OverlayOptions = {}): OverlayHandle {
    const entry: OverlayEntry = {
      component,
      focused: true,
      hidden: false,
      options,
    }
    for (const overlay of this.overlayStack) overlay.focused = false
    this.overlayStack.push(entry)
    this.requestRender(true)

    return {
      hide: () => {
        this.overlayStack = this.overlayStack.filter((overlay) => overlay !== entry)
        this.requestRender(true)
      },
      setHidden: (hidden) => {
        entry.hidden = hidden
        this.requestRender(true)
      },
      isHidden: () => entry.hidden,
      focus: () => {
        for (const overlay of this.overlayStack) overlay.focused = false
        entry.focused = true
        this.requestRender()
      },
      unfocus: () => {
        entry.focused = false
        this.requestRender()
      },
      isFocused: () => entry.focused,
    }
  }

  hideOverlay(): void {
    this.overlayStack.pop()
    const last = this.overlayStack.at(-1)
    if (last) last.focused = true
    this.requestRender(true)
  }

  hasOverlay(): boolean {
    return this.overlayStack.some((overlay) => !overlay.hidden)
  }

  requestRender(force = false): void {
    if (this.stopped) return
    if (force) this.previousLines = []
    if (this.renderRequested) return
    this.renderRequested = true
    queueMicrotask(() => {
      this.renderRequested = false
      this.doRender()
    })
  }

  private handleInput(data: string): void {
    let nextData = data
    for (const listener of this.inputListeners) {
      const result = listener(nextData)
      if (result?.data !== undefined) nextData = result.data
      if (result?.consume) {
        this.requestRender()
        return
      }
    }

    const overlay = [...this.overlayStack].reverse().find((entry) => !entry.hidden && entry.focused)
    if (overlay) {
      overlay.component.handleInput?.(nextData)
      this.requestRender()
      return
    }

    this.focusedComponent?.handleInput?.(nextData)
    this.requestRender()
  }

  private doRender(): void {
    const width = Math.max(20, this.terminal.columns)
    const height = Math.max(8, this.terminal.rows)
    let lines = this.render(width).map((line) => fitToWidth(line, width))
    lines = this.compositeOverlays(lines, width, height)
    lines = lines.slice(-height)
    while (lines.length < height) lines.push(' '.repeat(width))

    const sizeChanged = width !== this.previousWidth || height !== this.previousHeight
    if (sizeChanged || this.previousLines.length === 0) {
      this.terminal.write('\x1b[?2026h')
      this.terminal.clearScreen()
      this.terminal.write(lines.join('\r\n'))
      this.terminal.write('\x1b[?2026l')
    } else {
      this.terminal.write('\x1b[?2026h')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === this.previousLines[i]) continue
        this.terminal.write(`\x1b[${i + 1};1H\x1b[2K${lines[i]}`)
      }
      this.terminal.write('\x1b[?2026l')
    }

    if (this.showHardwareCursor) {
      this.terminal.showCursor()
    } else {
      this.terminal.hideCursor()
    }
    this.previousLines = lines
    this.previousWidth = width
    this.previousHeight = height
  }

  private compositeOverlays(base: string[], termWidth: number, termHeight: number): string[] {
    const visibleOverlays = this.overlayStack.filter((entry) => !entry.hidden)
    if (visibleOverlays.length === 0) return base

    const output = Array.from({ length: termHeight }, () => ' '.repeat(termWidth))
    for (const overlay of visibleOverlays) {
      const width = resolveSize(overlay.options.width ?? '80%', termWidth, termWidth)
      const minWidth = overlay.options.minWidth ?? 0
      const overlayWidth = Math.min(termWidth, Math.max(minWidth, width))
      const rendered = overlay.component
        .render(overlayWidth)
        .map((line) => fitToWidth(line, overlayWidth))
      const maxHeight = resolveSize(overlay.options.maxHeight ?? termHeight, termHeight, termHeight)
      const visible = rendered.slice(0, Math.max(1, maxHeight))
      const row = Math.max(0, Math.floor((termHeight - visible.length) / 2))
      const col = Math.max(0, Math.floor((termWidth - overlayWidth) / 2))

      for (let i = 0; i < visible.length; i++) {
        const targetRow = row + i
        if (targetRow < 0 || targetRow >= termHeight) continue
        const current = output[targetRow] ?? ' '.repeat(termWidth)
        output[targetRow] = current.slice(0, col) + visible[i] + current.slice(col + overlayWidth)
      }
    }
    return output
  }
}

export const Key = {
  escape: 'escape',
  enter: 'enter',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  ctrl: (key: string) => `ctrl+${key}`,
} as const

export function matchesKey(data: string, keyId: string): boolean {
  switch (keyId) {
    case Key.escape:
      return data === '\x1b'
    case Key.enter:
      return data === '\r' || data === '\n'
    case Key.tab:
      return data === '\t'
    case Key.backspace:
      return data === '\x7f' || data === '\b'
    case Key.delete:
      return data === '\x1b[3~'
    case Key.up:
      return data === '\x1b[A'
    case Key.down:
      return data === '\x1b[B'
    case Key.right:
      return data === '\x1b[C'
    case Key.left:
      return data === '\x1b[D'
    case 'ctrl+c':
      return data === '\x03'
    case 'ctrl+d':
      return data === '\x04'
    case 'ctrl+l':
      return data === '\x0c'
    default:
      return data === keyId
  }
}

export interface SelectItem {
  value: string
  label: string
  description?: string
}

export interface SelectListTheme {
  selectedPrefix: (text: string) => string
  selectedText: (text: string) => string
  description: (text: string) => string
  scrollInfo: (text: string) => string
  noMatch: (text: string) => string
}

export class SelectList implements Component {
  private selectedIndex = 0

  onSelect?: (item: SelectItem) => void
  onCancel?: () => void

  constructor(
    private readonly items: SelectItem[],
    private readonly maxVisible: number,
    private readonly theme: SelectListTheme,
    _layout: unknown = undefined,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (this.items.length === 0) return [this.theme.noMatch('No items')]
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - 1),
    )
    const visible = this.items.slice(start, start + this.maxVisible)
    const lines = visible.map((item, offset) => {
      const index = start + offset
      const selected = index === this.selectedIndex
      const label = truncateToWidth(item.label, Math.max(1, Math.floor(width * 0.45)), '')
      const desc = item.description
        ? this.theme.description(
            truncateToWidth(
              item.description.replace(/\s+/g, ' '),
              Math.max(1, width - 4 - visibleWidth(label)),
              '',
            ),
          )
        : ''
      const line = `${selected ? '> ' : '  '}${label}${desc ? `  ${desc}` : ''}`
      return selected ? this.theme.selectedText(fitToWidth(line, width)) : fitToWidth(line, width)
    })
    if (this.items.length > this.maxVisible) {
      lines.push(this.theme.scrollInfo(`  ${this.selectedIndex + 1}/${this.items.length}`))
    }
    return lines
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = this.selectedIndex <= 0 ? this.items.length - 1 : this.selectedIndex - 1
      return
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = this.selectedIndex >= this.items.length - 1 ? 0 : this.selectedIndex + 1
      return
    }
    if (matchesKey(data, Key.enter)) {
      const item = this.items[this.selectedIndex]
      if (item) this.onSelect?.(item)
      return
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.onCancel?.()
    }
  }
}

export interface EditorTheme {
  borderColor: (text: string) => string
  selectList: SelectListTheme
}

export interface EditorOptions {
  paddingX?: number
  autocompleteMaxVisible?: number
}

export interface AutocompleteItem {
  value: string
  label: string
  description?: string
}

export interface SlashCommand {
  name: string
  description?: string
  argumentHint?: string
}

export class CombinedAutocompleteProvider {
  constructor(
    private readonly commands: SlashCommand[] = [],
    private readonly basePath = process.cwd(),
  ) {}

  completeSlash(text: string): string | null {
    if (!text.startsWith('/') || text.includes(' ')) return null
    const prefix = text.slice(1)
    const match = this.commands.find((command) => command.name.startsWith(prefix))
    return match ? `/${match.name} ` : null
  }

  get commandItems(): AutocompleteItem[] {
    return this.commands.map((command) => ({
      description: command.argumentHint
        ? `${command.argumentHint}${command.description ? ` - ${command.description}` : ''}`
        : command.description,
      label: command.name,
      value: command.name,
    }))
  }

  get baseDirectory(): string {
    return this.basePath
  }
}

export class Editor implements Component, Focusable {
  focused = false
  disableSubmit = false
  onSubmit?: (text: string) => void
  onChange?: (text: string) => void
  private text = ''
  private history: string[] = []
  private historyIndex = -1
  private autocompleteProvider?: CombinedAutocompleteProvider

  constructor(
    private readonly tui: TUI,
    private readonly theme: EditorTheme,
    private readonly options: EditorOptions = {},
  ) {}

  invalidate(): void {}

  setAutocompleteProvider(provider: CombinedAutocompleteProvider): void {
    this.autocompleteProvider = provider
  }

  addToHistory(text: string): void {
    if (text.trim()) this.history.push(text)
    this.historyIndex = -1
  }

  getText(): string {
    return this.text
  }

  setText(text: string): void {
    this.text = text
    this.onChange?.(text)
    this.tui.requestRender()
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      if (this.disableSubmit) return
      const submitted = this.text.trim()
      this.text = ''
      this.historyIndex = -1
      this.onChange?.('')
      this.onSubmit?.(submitted)
      return
    }
    if (data === '\x1b\r' || data === '\x1b\n') {
      this.insert('\n')
      return
    }
    if (matchesKey(data, Key.tab)) {
      const completed = this.autocompleteProvider?.completeSlash(this.text.trim())
      if (completed) this.setText(completed)
      return
    }
    if (matchesKey(data, Key.backspace)) {
      this.text = this.text.slice(0, -1)
      this.onChange?.(this.text)
      return
    }
    if (matchesKey(data, Key.up) && this.text.length === 0 && this.history.length > 0) {
      this.historyIndex =
        this.historyIndex < 0 ? this.history.length - 1 : Math.max(0, this.historyIndex - 1)
      this.setText(this.history[this.historyIndex] ?? '')
      return
    }
    if (matchesKey(data, Key.down) && this.historyIndex >= 0) {
      this.historyIndex++
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = -1
        this.setText('')
      } else {
        this.setText(this.history[this.historyIndex] ?? '')
      }
      return
    }
    if (isPrintable(data)) {
      this.insert(data)
    }
  }

  render(width: number): string[] {
    const padding = this.options.paddingX ?? 2
    const innerWidth = Math.max(4, width - 2)
    const textWidth = Math.max(1, innerWidth - padding * 2)
    const content = this.text.length > 0 ? this.text : ''
    const wrapped = wrapPlainText(content, textWidth)
    const lines = wrapped.length === 0 ? [''] : wrapped
    const top = this.theme.borderColor('─'.repeat(width))
    const rendered = lines.map((line, index) => {
      const prompt = index === 0 ? '> ' : '  '
      return fitToWidth(`${' '.repeat(padding)}${prompt}${line}`, width)
    })
    return [top, ...rendered, top]
  }

  private insert(value: string): void {
    this.text += value
    this.historyIndex = -1
    this.onChange?.(this.text)
  }
}

export interface DefaultTextStyle {
  color?: (text: string) => string
}

export interface MarkdownTheme {
  heading: (text: string) => string
  link: (text: string) => string
  linkUrl: (text: string) => string
  code: (text: string) => string
  codeBlock: (text: string) => string
  codeBlockBorder: (text: string) => string
  quote: (text: string) => string
  quoteBorder: (text: string) => string
  hr: (text: string) => string
  listBullet: (text: string) => string
  bold: (text: string) => string
  italic: (text: string) => string
  strikethrough: (text: string) => string
  underline: (text: string) => string
  highlightCode?: (code: string, lang?: string) => string[]
  codeBlockIndent?: string
}

export class Markdown implements Component {
  constructor(
    private text: string,
    private readonly paddingX: number,
    private readonly paddingY: number,
    private readonly theme: MarkdownTheme,
    private readonly defaultTextStyle?: DefaultTextStyle,
  ) {}

  setText(text: string): void {
    this.text = text
  }

  invalidate(): void {}

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - this.paddingX * 2)
    const lines: string[] = []
    for (let i = 0; i < this.paddingY; i++) lines.push('')
    for (const rawLine of this.text.split('\n')) {
      const styled = this.styleLine(rawLine)
      const wrapped = wrapAnsiText(styled, innerWidth)
      for (const line of wrapped.length > 0 ? wrapped : ['']) {
        const padded = `${' '.repeat(this.paddingX)}${line}`
        lines.push(this.defaultTextStyle?.color ? this.defaultTextStyle.color(padded) : padded)
      }
    }
    for (let i = 0; i < this.paddingY; i++) lines.push('')
    return lines
  }

  private styleLine(line: string): string {
    if (line.startsWith('#')) return this.theme.heading(line)
    if (line.startsWith('>'))
      return `${this.theme.quoteBorder('>')} ${this.theme.quote(line.slice(1).trimStart())}`
    if (/^\s*[-*]\s/.test(line)) {
      return line.replace(
        /^(\s*)([-*])\s/,
        (_match, indent: string) => `${indent}${this.theme.listBullet('-')} `,
      )
    }
    return line.replace(/`([^`]+)`/g, (_match, code: string) => this.theme.code(code))
  }
}

export function visibleWidth(value: string): number {
  return [...stripAnsi(value)].reduce((sum, char) => sum + charWidth(char), 0)
}

export function truncateToWidth(value: string, maxWidth: number, suffix = '…'): string {
  if (maxWidth <= 0) return ''
  if (visibleWidth(value) <= maxWidth) return value
  const suffixWidth = visibleWidth(suffix)
  let output = ''
  let width = 0
  for (let i = 0; i < value.length; ) {
    const ansi = value.slice(i).match(ANSI_RE)
    if (ansi?.index === 0) {
      output += ansi[0]
      i += ansi[0].length
      continue
    }
    const char = [...value.slice(i)][0]
    if (!char) break
    const nextWidth = charWidth(char)
    if (width + nextWidth + suffixWidth > maxWidth) break
    output += char
    width += nextWidth
    i += char.length
  }
  return output + suffix
}

export function fitToWidth(line: string, width: number): string {
  const truncated = truncateToWidth(line, width, '')
  const missing = width - visibleWidth(truncated)
  return missing > 0 ? truncated + ' '.repeat(missing) : truncated
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '')
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code === 0) return 0
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2
  }
  return 1
}

function wrapPlainText(text: string, width: number): string[] {
  return text.split('\n').flatMap((line) => wrapAnsiText(line, width))
}

function wrapAnsiText(text: string, width: number): string[] {
  if (width <= 0) return ['']
  const lines: string[] = []
  let current = ''
  let currentWidth = 0
  for (const word of text.split(/(\s+)/)) {
    const wordWidth = visibleWidth(word)
    if (word.includes('\n')) {
      const parts = word.split('\n')
      for (const [index, part] of parts.entries()) {
        if (index > 0) {
          lines.push(current)
          current = ''
          currentWidth = 0
        }
        current += part
        currentWidth += visibleWidth(part)
      }
      continue
    }
    if (currentWidth > 0 && currentWidth + wordWidth > width) {
      lines.push(current.trimEnd())
      current = word.trimStart()
      currentWidth = visibleWidth(current)
      continue
    }
    current += word
    currentWidth += wordWidth
  }
  lines.push(current)
  return lines
}

function isPrintable(data: string): boolean {
  if (!data) return false
  if (data.startsWith('\x1b')) return false
  return [...data].every((char) => {
    const code = char.codePointAt(0) ?? 0
    return code >= 32 && code !== 127
  })
}

function splitTerminalInput(data: string): string[] {
  const tokens: string[] = []
  let index = 0
  while (index < data.length) {
    const char = data[index]
    if (char === '\x1b') {
      if (data[index + 1] === '[') {
        let end = index + 2
        while (end < data.length && !/[@-~]/.test(data[end] ?? '')) end++
        tokens.push(data.slice(index, Math.min(data.length, end + 1)))
        index = Math.min(data.length, end + 1)
        continue
      }
      if (data[index + 1] === '\r' || data[index + 1] === '\n') {
        tokens.push(data.slice(index, index + 2))
        index += 2
        continue
      }
      tokens.push(char)
      index++
      continue
    }

    const code = char?.codePointAt(0) ?? 0
    if (code < 32 || code === 127) {
      tokens.push(char ?? '')
      index += char?.length ?? 1
      continue
    }

    let end = index
    while (end < data.length) {
      const next = data[end]
      const nextCode = next?.codePointAt(0) ?? 0
      if (next === '\x1b' || nextCode < 32 || nextCode === 127) break
      end += next?.length ?? 1
    }
    tokens.push(data.slice(index, end))
    index = end
  }
  return tokens.filter((token) => token.length > 0)
}

function resolveSize(value: SizeValue, max: number, fallback: number): number {
  if (typeof value === 'number') return Math.max(1, Math.min(max, value))
  const match = value.match(/^(\d+)%$/)
  if (!match) return fallback
  return Math.max(1, Math.min(max, Math.floor((max * Number(match[1])) / 100)))
}
