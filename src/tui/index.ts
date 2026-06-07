#!/usr/bin/env bun

import { stdout as output } from 'node:process'
import { runFullScreenTui } from './fullscreen'
import { runLineMode, usage } from './line-mode'

function shouldRunLineMode(): boolean {
  if (process.env.AILA_TUI_HEADLESS === '1') return true
  if (process.env.CI === 'true') return true
  return !process.stdin.isTTY || !process.stdout.isTTY
}

const runner = shouldRunLineMode() ? runLineMode : runFullScreenTui

runner(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  output.write(`Aila TUI failed: ${message}\n\n${usage()}\n`)
  process.exitCode = 1
})
