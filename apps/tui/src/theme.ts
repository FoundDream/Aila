import chalk from 'chalk'
import { highlight } from 'cli-highlight'
import type { EditorTheme, MarkdownTheme, SelectListTheme } from './aila-tui'

export interface AilaTuiColors {
  accent: string
  accentMuted: string
  border: string
  dim: string
  error: string
  surface: string
  text: string
  textStrong: string
  warning: string
}

export const AILA_TUI_COLORS: AilaTuiColors = {
  accent: '#3fbf9f',
  accentMuted: '#70a7a0',
  border: '#4f5d75',
  dim: '#8a94a6',
  error: '#ff6b6b',
  surface: '#18202f',
  text: '#d7deea',
  textStrong: '#f3f6fb',
  warning: '#f4bf75',
}

const ANSI_STYLE_SEQUENCE = /\x1b\[[0-9;]*m/g

function visibleStyleText(text: string): string {
  return text.replace(ANSI_STYLE_SEQUENCE, '')
}

export function createMarkdownTheme(colors = AILA_TUI_COLORS): MarkdownTheme {
  return {
    heading: (text) =>
      /^#{3,6} $/.test(visibleStyleText(text)) ? '' : chalk.bold.hex(colors.textStrong)(text),
    link: (text) => chalk.underline.hex(colors.accent)(text),
    linkUrl: (text) => chalk.hex(colors.dim)(text),
    code: (text) => chalk.hex(colors.warning)(text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => {
      const language = text.startsWith('```') ? text.slice(3).trim() : ''
      return language ? chalk.hex(colors.dim)(`  ${language}`) : ''
    },
    quote: (text) => chalk.hex(colors.dim)(text),
    quoteBorder: (text) => chalk.hex(colors.border)(text),
    hr: (text) => chalk.hex(colors.border)(text),
    listBullet: (text) => chalk.hex(colors.accent)(text),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
    codeBlockIndent: '  ',
    highlightCode: (code, lang) => {
      try {
        return highlight(code, { language: lang, ignoreIllegals: true }).split('\n')
      } catch {
        return code.split('\n')
      }
    },
  }
}

export function createEditorTheme(colors = AILA_TUI_COLORS): EditorTheme {
  return {
    borderColor: (text) => chalk.hex(colors.border)(text),
    selectList: createSelectListTheme(colors),
  }
}

export function createSelectListTheme(colors = AILA_TUI_COLORS): SelectListTheme {
  return {
    selectedPrefix: (text) => chalk.hex(colors.accent)(text),
    selectedText: (text) => chalk.bold.hex(colors.textStrong)(text),
    description: (text) => chalk.hex(colors.dim)(text),
    scrollInfo: (text) => chalk.hex(colors.dim)(text),
    noMatch: (text) => chalk.hex(colors.dim)(text),
  }
}
