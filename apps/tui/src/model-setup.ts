import {
  MODEL_CATALOG,
  type ModelEntry,
  type ModelSelection,
  type ProviderId,
  providerLabel,
} from '@aila/agent'
import chalk from 'chalk'
import {
  type Component,
  decodeKittyPrintable,
  type Focusable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from './aila-tui'
import { AILA_TUI_COLORS } from './theme'

export interface ModelSetupResult {
  apiKey?: string
  selection: ModelSelection
}

export interface ModelSetupOptions {
  initialSelection: ModelSelection | null
  providerHasApiKey: (providerId: ProviderId) => boolean
  onCancel: () => void
  onDone: (result: ModelSetupResult) => void
}

type SetupStep = 'provider' | 'api-key' | 'model'

const API_KEY_ENV_BY_PROVIDER: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

const PROVIDERS = Array.from(new Set(MODEL_CATALOG.map((model) => model.providerId)))

export class ModelSetupComponent implements Component, Focusable {
  focused = false
  private apiKey = ''
  private apiKeyError = ''
  private modelIndex = 0
  private providerIndex = 0
  private selectedProvider: ProviderId | null
  private step: SetupStep

  constructor(private readonly options: ModelSetupOptions) {
    const initial = options.initialSelection
    const initialProviderIndex = initial ? PROVIDERS.indexOf(initial.providerId) : -1
    this.providerIndex = Math.max(0, initialProviderIndex)
    this.selectedProvider = initial?.providerId ?? null
    this.step = initial ? 'api-key' : 'provider'
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.step === 'api-key') {
      this.handleApiKeyInput(data)
      return
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      if (this.step === 'provider' || this.options.initialSelection) {
        this.options.onCancel()
      } else {
        this.step = this.providerHasApiKey() ? 'provider' : 'api-key'
      }
      return
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1)
      return
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1)
      return
    }
    if (matchesKey(data, Key.enter)) {
      if (this.step === 'provider') {
        this.selectedProvider = PROVIDERS[this.providerIndex] ?? null
        this.modelIndex = 0
        this.step = this.providerHasApiKey() ? 'model' : 'api-key'
      } else {
        const model = this.models[this.modelIndex]
        if (model) this.complete(model)
      }
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width)
    const lines = [
      chalk.hex(AILA_TUI_COLORS.border)('─'.repeat(safeWidth)),
      this.renderTitle(),
      chalk.hex(AILA_TUI_COLORS.dim)(` ${this.stepHint}`),
      '',
      ...this.renderStep(safeWidth),
      '',
      chalk.hex(AILA_TUI_COLORS.border)('─'.repeat(safeWidth)),
    ]
    return lines.map((line) => truncateToWidth(line, safeWidth, ''))
  }

  private get models(): ModelEntry[] {
    return MODEL_CATALOG.filter((model) => model.providerId === this.selectedProvider)
  }

  private get stepHint(): string {
    if (this.step === 'provider') return '↑↓ navigate · Enter continue · Esc cancel'
    if (this.step === 'api-key') {
      return this.options.initialSelection ? 'Enter save · Esc cancel' : 'Enter continue · Esc back'
    }
    return this.options.initialSelection
      ? '↑↓ navigate · Enter finish · Esc cancel'
      : '↑↓ navigate · Enter finish · Esc back'
  }

  private renderTitle(): string {
    const label =
      this.step === 'provider'
        ? 'Choose a provider'
        : this.step === 'api-key'
          ? `Connect ${this.selectedProvider ? providerLabel(this.selectedProvider) : 'provider'}`
          : 'Choose a default model'
    return (
      chalk.bold.hex(AILA_TUI_COLORS.accent)(' Set up Aila') +
      chalk.hex(AILA_TUI_COLORS.border)('  ·  ') +
      chalk.hex(AILA_TUI_COLORS.textStrong)(label)
    )
  }

  private renderStep(width: number): string[] {
    if (this.step === 'api-key') return this.renderApiKeyStep()
    const items = this.step === 'provider' ? PROVIDERS : this.models
    const selectedIndex = this.step === 'provider' ? this.providerIndex : this.modelIndex
    const maxVisible = 7
    const start = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible),
    )
    const visible = items.slice(start, start + maxVisible)
    const lines = visible.map((item, offset) => {
      const index = start + offset
      const selected = index === selectedIndex
      const label =
        typeof item === 'string'
          ? providerLabel(item)
          : `${item.displayName}${item.tags?.length ? `  ${item.tags.join(' · ')}` : ''}`
      const pointer = selected ? '›' : ' '
      const text = ` ${pointer} ${label}`
      return selected
        ? chalk.bold.hex(AILA_TUI_COLORS.accent)(text)
        : chalk.hex(AILA_TUI_COLORS.text)(text)
    })
    if (items.length > maxVisible) {
      lines.push(
        chalk.hex(AILA_TUI_COLORS.dim)(`   ${selectedIndex + 1}/${items.length} · more below`),
      )
    }
    if (this.step === 'provider') {
      lines.unshift(
        chalk.hex(AILA_TUI_COLORS.dim)(
          ' Select the service where you already have an account or API key.',
        ),
        '',
      )
    } else if (this.selectedProvider) {
      lines.unshift(
        chalk.hex(AILA_TUI_COLORS.dim)(
          ` Models available from ${providerLabel(this.selectedProvider)}.`,
        ),
        '',
      )
    }
    return lines.map((line) => truncateToWidth(line, width, '…'))
  }

  private renderApiKeyStep(): string[] {
    const providerId = this.selectedProvider
    const envName = providerId ? API_KEY_ENV_BY_PROVIDER[providerId] : undefined
    const keyLine = this.apiKey.length > 0 ? '•'.repeat(Math.min(this.apiKey.length, 56)) : ''
    return [
      chalk.hex(AILA_TUI_COLORS.dim)(
        envName
          ? ` Paste API key or set ${envName}.`
          : ' Paste your API key. It will be saved locally.',
      ),
      '',
      chalk.hex(AILA_TUI_COLORS.accent)(' › ') +
        keyLine +
        (this.focused ? chalk.inverse.hex(AILA_TUI_COLORS.accent)(' ') : ''),
      ...(this.apiKeyError ? ['', chalk.hex(AILA_TUI_COLORS.error)(` ${this.apiKeyError}`)] : []),
    ]
  }

  private handleApiKeyInput(data: string): void {
    const pasted = bracketedPasteContent(data)
    if (pasted !== null) {
      this.apiKey += pasted.replaceAll(/\r?\n/g, '')
      this.apiKeyError = ''
      return
    }
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      if (this.options.initialSelection) {
        this.options.onCancel()
      } else {
        this.apiKeyError = ''
        this.step = 'provider'
      }
      return
    }
    if (matchesKey(data, Key.backspace)) {
      this.apiKey = this.apiKey.slice(0, -1)
      this.apiKeyError = ''
      return
    }
    if (matchesKey(data, Key.enter)) {
      const apiKey = this.apiKey.trim()
      if (!apiKey) {
        this.apiKeyError = 'API key cannot be empty.'
        return
      }
      if (this.options.initialSelection) {
        this.options.onDone({ apiKey, selection: this.options.initialSelection })
      } else {
        this.step = 'model'
      }
      return
    }
    const printable = printableInput(data)
    if (printable) {
      this.apiKey += printable
      this.apiKeyError = ''
    }
  }

  private moveSelection(delta: number): void {
    const itemCount = this.step === 'provider' ? PROVIDERS.length : this.models.length
    if (itemCount === 0) return
    const current = this.step === 'provider' ? this.providerIndex : this.modelIndex
    const next = (current + delta + itemCount) % itemCount
    if (this.step === 'provider') this.providerIndex = next
    else this.modelIndex = next
  }

  private providerHasApiKey(): boolean {
    return this.selectedProvider ? this.options.providerHasApiKey(this.selectedProvider) : false
  }

  private complete(model: ModelEntry): void {
    this.options.onDone({
      ...(this.apiKey.trim() ? { apiKey: this.apiKey.trim() } : {}),
      selection: { modelId: model.modelId, providerId: model.providerId },
    })
  }
}

function bracketedPasteContent(data: string): string | null {
  const start = data.indexOf('\x1b[200~')
  if (start < 0) return null
  const contentStart = start + '\x1b[200~'.length
  const end = data.indexOf('\x1b[201~', contentStart)
  return end < 0 ? data.slice(contentStart) : data.slice(contentStart, end)
}

function printableInput(data: string): string | null {
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
