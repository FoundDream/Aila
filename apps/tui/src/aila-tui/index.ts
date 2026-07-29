import {
  type Component,
  decodeKittyPrintable,
  Key,
  matchesKey,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'

export {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  Box,
  CancellableLoader,
  CombinedAutocompleteProvider,
  type Component,
  Container,
  CURSOR_MARKER,
  type DefaultTextStyle,
  decodeKittyPrintable,
  Editor,
  type EditorOptions,
  type EditorTheme,
  type Focusable,
  Image,
  type ImageOptions,
  type ImageTheme,
  Input,
  isKeyRelease,
  isKeyRepeat,
  Key,
  Loader,
  Markdown,
  type MarkdownOptions,
  type MarkdownTheme,
  matchesKey,
  type OverlayHandle,
  type OverlayOptions,
  ProcessTerminal,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  type SizeValue,
  type SlashCommand,
  Spacer,
  type Terminal,
  Text,
  TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'

/**
 * A searchable picker list used by Aila's model and conversation dialogs.
 *
 * pi-tui's SelectList intentionally keeps filtering controlled by its host.
 * Aila's existing picker contract accepts text directly, clears the query on
 * the first Escape, and cancels on the second, so that behavior remains in
 * this thin product-layer adapter.
 */
export class SelectList implements Component {
  private filteredItems: SelectItem[]
  private query = ''
  private selectedIndex = 0

  onSelect?: (item: SelectItem) => void
  onCancel?: () => void
  onSelectionChange?: (item: SelectItem) => void

  constructor(
    private readonly items: SelectItem[],
    private readonly maxVisible: number,
    private readonly theme: SelectListTheme,
    private readonly layout: SelectListLayoutOptions = {},
  ) {
    this.filteredItems = items
  }

  invalidate(): void {}

  get filterQuery(): string {
    return this.query
  }

  clearFilter(): boolean {
    if (!this.query) return false
    this.setFilter('')
    return true
  }

  setSelectedValue(value: string): void {
    const index = this.filteredItems.findIndex((item) => item.value === value)
    if (index >= 0) this.selectedIndex = index
  }

  render(width: number): string[] {
    if (this.filteredItems.length === 0) return [this.theme.noMatch('  No matches')]

    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        Math.max(0, this.filteredItems.length - this.maxVisible),
      ),
    )
    const visible = this.filteredItems.slice(start, start + this.maxVisible)
    const configuredMax = this.layout.maxPrimaryColumnWidth ?? Number.POSITIVE_INFINITY
    const configuredMin = this.layout.minPrimaryColumnWidth ?? 12
    const labelWidth = Math.min(
      configuredMax,
      Math.max(
        configuredMin,
        Math.min(
          Math.max(...visible.map((item) => visibleWidth(item.label)), configuredMin),
          Math.max(configuredMin, Math.floor(width * 0.5)),
        ),
      ),
    )

    const lines = visible.map((item, offset) => {
      const index = start + offset
      const selected = index === this.selectedIndex
      const label = truncateToWidth(item.label, labelWidth, '…')
      const labelPadding = ' '.repeat(Math.max(1, labelWidth - visibleWidth(label) + 2))
      const description = item.description
        ? this.theme.description(
            truncateToWidth(
              item.description.replace(/\s+/g, ' '),
              Math.max(1, width - 4 - visibleWidth(label) - labelPadding.length),
              '…',
            ),
          )
        : ''
      const prefix = selected ? this.theme.selectedPrefix('› ') : '  '
      const styledLabel = selected ? this.theme.selectedText(label) : label
      return fitToWidth(
        `${prefix}${styledLabel}${description ? `${labelPadding}${description}` : ''}`,
        width,
      )
    })

    if (this.filteredItems.length > this.maxVisible) {
      const remaining = Math.max(0, this.filteredItems.length - (start + visible.length))
      lines.push(
        this.theme.scrollInfo(
          remaining > 0
            ? `  ${this.selectedIndex + 1}/${this.filteredItems.length} · ${remaining} more`
            : `  ${this.selectedIndex + 1}/${this.filteredItems.length}`,
        ),
      )
    }
    return lines
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      if (this.filteredItems.length === 0) return
      this.selectedIndex =
        this.selectedIndex <= 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1
      this.notifySelectionChange()
      return
    }
    if (matchesKey(data, Key.down)) {
      if (this.filteredItems.length === 0) return
      this.selectedIndex =
        this.selectedIndex >= this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1
      this.notifySelectionChange()
      return
    }
    if (matchesKey(data, Key.enter)) {
      const item = this.filteredItems[this.selectedIndex]
      if (item) this.onSelect?.(item)
      return
    }
    if (matchesKey(data, Key.backspace)) {
      this.setFilter(this.query.slice(0, -1))
      return
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      if (this.clearFilter()) return
      this.onCancel?.()
      return
    }

    const printable = printableText(data)
    if (printable) this.setFilter(this.query + printable)
  }

  private setFilter(query: string): void {
    this.query = query
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    this.filteredItems =
      terms.length === 0
        ? this.items
        : this.items.filter((item) => {
            const text = `${item.label} ${item.value} ${item.description ?? ''}`.toLowerCase()
            return terms.every((term) => text.includes(term))
          })
    this.selectedIndex = 0
    this.notifySelectionChange()
  }

  private notifySelectionChange(): void {
    const item = this.filteredItems[this.selectedIndex]
    if (item) this.onSelectionChange?.(item)
  }
}

function printableText(data: string): string | null {
  const kittyPrintable = decodeKittyPrintable(data) ?? null
  if (kittyPrintable !== null) return kittyPrintable
  if (!data || data.startsWith('\x1b')) return null
  return [...data].every((char) => {
    const code = char.codePointAt(0) ?? 0
    return code >= 32 && code !== 127 && visibleWidth(char) > 0
  })
    ? data
    : null
}

function fitToWidth(text: string, width: number): string {
  if (width <= 0) return ''
  const truncated = truncateToWidth(text, width, '')
  const missing = width - visibleWidth(truncated)
  return missing > 0 ? truncated + ' '.repeat(missing) : truncated
}
