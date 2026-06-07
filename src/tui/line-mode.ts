#!/usr/bin/env bun

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import * as dotenv from 'dotenv'
import {
  type AgentProfileId,
  AgentRuntime,
  type AgentRuntimeEvent,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  appendMessage,
  type ConversationSummary,
  configureDataDir,
  configuredProviders,
  createConversation,
  type ExtensionReport,
  executeTool,
  findModel,
  getConversation,
  getDataDir,
  getExtensionReport,
  getProfilesDir,
  getToolPacksDir,
  listConversations,
  loadAgentProfilesFromDir,
  loadSettings,
  loadToolPacksFromDir,
  MODEL_CATALOG,
  type ModelSelection,
  type PersistedMessage,
  PROVIDER_LABELS,
  type ProviderId,
  type Settings,
  type ToolApprovalRequest,
} from '../runtime'

dotenv.config()

export interface CliOptions {
  conversationId?: string
  dataDir?: string
  list: boolean
  limit: number
  model?: ModelSelection
  profileId: AgentProfileId
  retryLast: boolean
  resumeLatest: boolean
  showHistory: boolean
}

export interface PromptReader {
  question(prompt: string): Promise<string | null>
  close(): void
}

export interface TuiSessionState {
  selection: ModelSelection
  profileId: AgentProfileId
}

export function usage(): string {
  return [
    'Usage: bun run tui [options]',
    '',
    'Options:',
    '  --conversation <id>     Continue an existing conversation',
    '  --data-dir <path>       Data directory (default: $AILA_DATA_DIR, ./.dev-data, or ~/.aila)',
    '  --list                  List saved conversations and exit',
    '  --limit <n>             Limit rows for --list (default: 20)',
    '  --model <provider:id>   Override model, e.g. openai:gpt-5.4',
    '  --profile <name>        chat | coding | research or a manifest profile (default: coding)',
    '  --resume                Continue the most recently updated conversation',
    '  --retry-last            Retry the last failed or dangling user turn without duplicating it',
    '  --no-history            Do not print recent history when resuming',
    '  -h, --help              Show this help',
    '',
    'Commands:',
    '  /help                   Show TUI commands',
    '  /exit                   Quit',
    '  /abort                  Abort the active response',
    '  /retry                  Retry the last failed or dangling user turn',
    '  /sessions               List saved conversations',
    '  /extensions [reload]    List extension manifests, optionally refresh runtime caches',
    '  /profile [name]         Show or switch the active profile',
    '  /model [provider:id]    Show or switch the active model',
    '  /read <path>            Read a workspace file and attach it as context',
    '  /run <command>          Run an approved shell command and attach output',
    '  /write <path> <content> Write a file after approval',
    '  /edit <path> <old> => <new>',
    '',
    'Ctrl+C aborts the active response, or exits when idle. Full-screen mode also supports Ctrl+D.',
  ].join('\n')
}

export function parseModel(value: string): ModelSelection {
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('model must be formatted as <provider>:<modelId>')
  }
  const providerId = value.slice(0, separator) as ProviderId
  const modelId = value.slice(separator + 1)
  if (!PROVIDER_LABELS[providerId]) {
    throw new Error(`unknown provider: ${providerId}`)
  }
  return { providerId, modelId }
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    list: false,
    limit: 20,
    profileId: 'coding',
    retryLast: false,
    resumeLatest: false,
    showHistory: true,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        output.write(`${usage()}\n`)
        process.exit(0)
        return options
      case '--conversation':
        options.conversationId = requireValue(argv, ++i, arg)
        break
      case '--data-dir':
        options.dataDir = resolve(requireValue(argv, ++i, arg))
        break
      case '--list':
        options.list = true
        break
      case '--limit':
        options.limit = parseLimit(requireValue(argv, ++i, arg))
        break
      case '--model':
        options.model = parseModel(requireValue(argv, ++i, arg))
        break
      case '--no-history':
        options.showHistory = false
        break
      case '--profile': {
        const profile = requireValue(argv, ++i, arg) as AgentProfileId
        options.profileId = profile
        break
      }
      case '--resume':
        options.resumeLatest = true
        break
      case '--retry-last':
        options.retryLast = true
        break
      default:
        throw new Error(`unknown option: ${arg}`)
    }
  }

  if (options.conversationId && options.resumeLatest) {
    throw new Error('--conversation and --resume cannot be combined')
  }
  if (options.conversationId && options.list) {
    throw new Error('--conversation and --list cannot be combined')
  }

  return options
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseLimit(value: string): number {
  const limit = Number.parseInt(value, 10)
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('--limit must be a positive integer')
  }
  return limit
}

export function resolveSelection(explicit?: ModelSelection): ModelSelection {
  if (explicit) return explicit

  const settings = loadSettings()
  if (settings.defaultModel) return settings.defaultModel

  const providers = configuredProviders(settings)
  for (const providerId of providers) {
    const entry = MODEL_CATALOG.find((model) => model.providerId === providerId)
    if (entry) return { providerId: entry.providerId, modelId: entry.modelId }
  }

  throw new Error(
    'No model configured. Set a default model in Desktop, pass --model, or provide an API key in env.',
  )
}

export function modelLabel(selection: ModelSelection): string {
  const meta = findModel(selection.providerId, selection.modelId)
  return `${PROVIDER_LABELS[selection.providerId]} / ${meta?.displayName ?? selection.modelId}`
}

export function preview(text: string, max = 600): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, max)}...`
}

export function displayPreview(text: string, max = 8000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n...[display truncated; full result was saved to conversation context]`
}

export async function resolveConversation(input: {
  conversationId?: string
  resumeLatest?: boolean
}): Promise<{ conversationId: string; isExisting: boolean }> {
  if (input.resumeLatest) {
    const [summary] = await listConversations()
    if (!summary) throw new Error('no conversations found to resume')
    return {
      conversationId: summary.id,
      isExisting: true,
    }
  }

  if (input.conversationId) {
    await getConversation(input.conversationId)
    return { conversationId: input.conversationId, isExisting: true }
  }

  const summary = await createConversation()
  return { conversationId: summary.id, isExisting: false }
}

function writeLine(line = ''): void {
  output.write(`${line}\n`)
}

async function askReadlineQuestion(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string | null> {
  try {
    return await rl.question(question)
  } catch (error) {
    if (error instanceof Error && error.message === 'readline was closed') return null
    throw error
  }
}

function createPromptReader(): PromptReader {
  if (!input.isTTY) {
    const raw = readFileSync(0, 'utf-8')
    const lines = raw.split(/\r?\n/)
    if (lines[lines.length - 1] === '') lines.pop()
    return {
      async question(prompt) {
        output.write(prompt)
        const line = lines.shift()
        if (line === undefined) return null
        return line
      },
      close() {},
    }
  }

  const rl = createInterface({ input, output })
  return {
    question: (prompt) => askReadlineQuestion(rl, prompt),
    close: () => rl.close(),
  }
}

export function defaultDataDir(): string {
  if (process.env.AILA_DATA_DIR) return resolve(process.env.AILA_DATA_DIR)
  const repoDevData = resolve(process.cwd(), '.dev-data')
  if (existsSync(repoDevData)) return repoDevData
  return join(homedir(), '.aila')
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

export function conversationScope(summary: ConversationSummary): string {
  return summary.docId ? `doc:${summary.docId}` : 'chat'
}

export async function printConversationList(input: { limit: number }): Promise<void> {
  const conversations = await listConversations()
  const shown = conversations.slice(0, input.limit)

  writeLine('Aila conversations')
  writeLine(`Data: ${getDataDir()}`)
  if (shown.length === 0) {
    writeLine('No conversations found.')
    return
  }

  for (const summary of shown) {
    const usage = summary.usage ? `, ${summary.usage.totalTokens} tokens` : ''
    writeLine(
      `${formatDate(summary.updatedAt)}  ${summary.id}  ${conversationScope(summary)}  ${summary.title}${usage}`,
    )
  }
  if (conversations.length > shown.length) {
    writeLine(`Showing ${shown.length} of ${conversations.length}. Use --limit to show more.`)
  }
}

export function blockPreview(message: PersistedMessage): string {
  const text = message.blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
        case 'reasoning':
          return block.content
        case 'tool_call':
          return `[tool:${block.status}] ${block.name}`
        case 'image':
          return `[image] ${block.url}`
      }
      return ''
    })
    .join(' ')
  return preview(text || '[empty]', 260)
}

export function commandHelp(): string {
  return [
    'TUI commands:',
    '  /help                   Show this command list',
    '  /exit                   Quit',
    '  /abort                  Abort the active response',
    '  /retry                  Retry a dangling last user turn',
    '  /sessions               List saved conversations',
    '  /extensions [reload]    List extension manifests, optionally refresh runtime caches',
    '  /profile [name]         Show or switch the active profile',
    '  /model [provider:id]    Show or switch the active model',
    '  /read <path>            Read a workspace file and attach it as context',
    '  /run <command>          Run an approved shell command and attach output',
    '  /write <path> <content> Write a file after approval',
    '  /edit <path> <old> => <new>',
    '',
    'Paths may be absolute or relative to the current workspace.',
    'Use quotes around paths that contain spaces.',
  ].join('\n')
}

export function readShellToken(inputText: string): { token: string; rest: string } | null {
  const input = inputText.trimStart()
  if (!input) return null

  let quote: '"' | "'" | null = null
  let escaped = false
  let token = ''
  let index = 0

  for (; index < input.length; index++) {
    const char = input[index]
    if (escaped) {
      token += char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        token += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) break
    token += char
  }

  if (quote) throw new Error('unterminated quote')
  return { token, rest: input.slice(index).trimStart() }
}

export function splitShellWords(inputText: string): string[] {
  const words: string[] = []
  let rest = inputText
  while (rest.trim().length > 0) {
    const next = readShellToken(rest)
    if (!next) break
    words.push(next.token)
    rest = next.rest
  }
  return words
}

export function workspacePath(path: string): string {
  return resolve(path)
}

export function formatToolResultForDisplay(toolName: string, result: string): string {
  if (toolName !== 'bash') return result
  try {
    const parsed = JSON.parse(result) as { exit_code?: number; stdout?: string; stderr?: string }
    return [
      `exit_code: ${parsed.exit_code ?? 'unknown'}`,
      parsed.stdout ? `stdout:\n${parsed.stdout}` : '',
      parsed.stderr ? `stderr:\n${parsed.stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  } catch {
    return result
  }
}

export async function appendLocalContext(input: {
  conversationId: string
  command: string
  result: string
}): Promise<void> {
  await appendMessage(input.conversationId, {
    schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
    id: randomUUID(),
    role: 'user',
    blocks: [
      {
        type: 'text',
        content: `[local command]\n${input.command}\n\n[result]\n${input.result}`,
      },
    ],
    status: 'done',
  })
}

export async function runLocalTool(input: {
  toolName: 'read' | 'bash' | 'write' | 'edit'
  args: Record<string, unknown>
  profileId: AgentProfileId
  settings: Settings
  prompt: PromptReader
}): Promise<string> {
  return executeTool(input.toolName, input.args, {
    settings: input.settings,
    profileId: input.profileId,
    onToolApproval: (request) => askToolApproval(input.prompt, request),
  })
}

export function writeExtensionReport(report: ExtensionReport): void {
  writeLine('Aila extensions')
  writeLine(`Data: ${report.dataDir}`)
  writeLine(`Profiles: ${report.profilesDir}`)
  const profileError = report.errors.find((error) => error.kind === 'profiles')
  if (profileError) {
    writeLine(`  [error] ${profileError.message}`)
  } else if (report.profiles.length === 0) {
    writeLine('  (none)')
  } else {
    for (const profile of report.profiles) {
      writeLine(`  ${profile.id} (${profile.baseProfileId}) - ${profile.label}`)
    }
  }

  writeLine(`Tool packs: ${report.toolPacksDir}`)
  const toolPackError = report.errors.find((error) => error.kind === 'toolPacks')
  if (toolPackError) {
    writeLine(`  [error] ${toolPackError.message}`)
  } else if (report.toolPacks.length === 0) {
    writeLine('  (none)')
  } else {
    for (const pack of report.toolPacks) {
      const toolNames = pack.tools.join(', ')
      writeLine(`  ${pack.id} - ${pack.tools.length} tools${toolNames ? `: ${toolNames}` : ''}`)
    }
  }
}

export async function writeProfileList(runtime: AgentRuntime, currentProfileId: AgentProfileId) {
  const profiles = await runtime.getProfiles()
  writeLine(`Profile: ${currentProfileId}`)
  writeLine('Available profiles:')
  for (const profile of [...profiles.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    writeLine(`  ${profile.id} (${profile.baseProfileId ?? profile.id}) - ${profile.label}`)
  }
}

export async function handleSlashCommand(input: {
  text: string
  conversationId: string
  runtime: AgentRuntime
  session: TuiSessionState
  prompt: PromptReader
}): Promise<'handled' | 'exit' | 'agent'> {
  const { text, conversationId, runtime, session, prompt } = input
  if (!text.startsWith('/')) return 'agent'

  const commandText = text.slice(1).trim()
  const command = readShellToken(commandText)
  const name = command?.token.toLowerCase() ?? ''
  const rest = command?.rest ?? ''
  const settings = loadSettings()
  const localToolProfileId: AgentProfileId = 'coding'

  try {
    switch (name) {
      case 'help':
        writeLine(commandHelp())
        return 'handled'
      case 'exit':
      case 'quit':
        return 'exit'
      case 'abort':
        runtime.abort(conversationId)
        return 'handled'
      case 'extensions': {
        const [action] = splitShellWords(rest)
        if (action && !['reload', 'refresh'].includes(action.toLowerCase())) {
          throw new Error('usage: /extensions [reload]')
        }
        if (action) {
          const [profiles, registry] = await Promise.all([
            runtime.reloadProfiles(),
            runtime.reloadToolPacks(),
          ])
          writeLine(
            `[extensions] reloaded ${profiles.size} profiles, ${registry.toolPacks.length} tool packs, ${registry.specs.length} tools`,
          )
        }
        writeExtensionReport(await getExtensionReport())
        return 'handled'
      }
      case 'reload':
      case 'refresh': {
        const [profiles, registry] = await Promise.all([
          runtime.reloadProfiles(),
          runtime.reloadToolPacks(),
        ])
        writeLine(
          `[extensions] reloaded ${profiles.size} profiles, ${registry.toolPacks.length} tool packs, ${registry.specs.length} tools`,
        )
        return 'handled'
      }
      case 'session':
      case 'sessions':
        await printConversationList({ limit: 20 })
        return 'handled'
      case 'profile': {
        const words = splitShellWords(rest)
        if (words.length === 0) {
          await writeProfileList(runtime, session.profileId)
          return 'handled'
        }
        if (words.length > 1) throw new Error('usage: /profile [name]')

        const profiles = await runtime.getProfiles()
        const nextProfileId = words[0] as AgentProfileId
        const profile = profiles.get(nextProfileId)
        if (!profile) {
          throw new Error(
            `unknown profile: ${nextProfileId}; use /extensions reload if you just added it`,
          )
        }
        session.profileId = nextProfileId
        writeLine(
          `[profile] ${profile.id} (${profile.baseProfileId ?? profile.id}) - ${profile.label}`,
        )
        return 'handled'
      }
      case 'model': {
        const words = splitShellWords(rest)
        if (words.length === 0) {
          writeLine(`[model] ${modelLabel(session.selection)}`)
          return 'handled'
        }
        if (words.length > 1) throw new Error('usage: /model [provider:modelId]')
        session.selection = parseModel(words[0])
        writeLine(`[model] ${modelLabel(session.selection)}`)
        return 'handled'
      }
      case 'read': {
        const [pathArg] = splitShellWords(rest)
        if (!pathArg) throw new Error('usage: /read <path>')
        const path = workspacePath(pathArg)
        const result = await runLocalTool({
          toolName: 'read',
          args: { path },
          profileId: localToolProfileId,
          settings,
          prompt,
        })
        writeLine(`\n[read] ${path}\n${displayPreview(result)}`)
        await appendLocalContext({ conversationId, command: `/read ${path}`, result })
        return 'handled'
      }
      case 'run': {
        if (!rest) throw new Error('usage: /run <command>')
        const result = await runLocalTool({
          toolName: 'bash',
          args: { command: rest },
          profileId: localToolProfileId,
          settings,
          prompt,
        })
        const display = formatToolResultForDisplay('bash', result)
        writeLine(`\n[run] ${rest}\n${displayPreview(display)}`)
        await appendLocalContext({ conversationId, command: `/run ${rest}`, result: display })
        return 'handled'
      }
      case 'write': {
        const parsed = readShellToken(rest)
        if (!parsed?.rest) throw new Error('usage: /write <path> <content>')
        const path = workspacePath(parsed.token)
        const result = await runLocalTool({
          toolName: 'write',
          args: { path, content: parsed.rest },
          profileId: localToolProfileId,
          settings,
          prompt,
        })
        writeLine(`\n[write] ${path}\n${displayPreview(result)}`)
        await appendLocalContext({ conversationId, command: `/write ${path}`, result })
        return 'handled'
      }
      case 'edit': {
        const parsed = readShellToken(rest)
        if (!parsed?.rest.includes('=>')) {
          throw new Error('usage: /edit <path> <old> => <new>')
        }
        const [oldText, ...newParts] = parsed.rest.split('=>')
        const newText = newParts.join('=>')
        if (!oldText || newParts.length === 0) {
          throw new Error('usage: /edit <path> <old> => <new>')
        }
        const path = workspacePath(parsed.token)
        const result = await runLocalTool({
          toolName: 'edit',
          args: { path, oldText: oldText.trim(), newText: newText.trim() },
          profileId: localToolProfileId,
          settings,
          prompt,
        })
        writeLine(`\n[edit] ${path}\n${displayPreview(result)}`)
        await appendLocalContext({ conversationId, command: `/edit ${path}`, result })
        return 'handled'
      }
      default:
        writeLine(`Unknown command: /${name || ''}. Type /help for commands.`)
        return 'handled'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeLine(`\n[command:error] ${message}`)
    return 'handled'
  }
}

export async function printRecentHistory(conversationId: string, maxMessages = 6): Promise<void> {
  const record = await getConversation(conversationId)
  if (record.messages.length === 0) return

  writeLine('')
  writeLine('Recent history:')
  for (const message of record.messages.slice(-maxMessages)) {
    const status = message.status === 'done' ? '' : ` (${message.status})`
    writeLine(`${message.role}${status}: ${blockPreview(message)}`)
  }

  const last = record.messages[record.messages.length - 1]
  if (last?.role === 'user') {
    writeLine('[resume] Last user message has no persisted assistant response yet.')
  }
}

export async function runLineMode(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  configureDataDir(options.dataDir ?? defaultDataDir())

  if (options.list) {
    await printConversationList({ limit: options.limit })
    return
  }

  const session: TuiSessionState = {
    selection: resolveSelection(options.model),
    profileId: options.profileId,
  }
  const { conversationId, isExisting } = await resolveConversation({
    conversationId: options.conversationId,
    resumeLatest: options.resumeLatest,
  })

  let activeConversationId: string | null = null
  const completions = new Map<string, () => void>()
  const toolNames = new Map<string, string>()
  let startedAssistantText = false
  const prompt = createPromptReader()

  const runtime = new AgentRuntime({
    onEvent: (event) => {
      handleRuntimeEvent(event, {
        completions,
        toolNames,
        onAssistantTextStart: () => {
          if (!startedAssistantText) {
            startedAssistantText = true
            output.write('\nAila> ')
          }
        },
      })
    },
    onToolApproval: (request) => askToolApproval(prompt, request),
    loadProfiles: async () => (await loadAgentProfilesFromDir()).map((profile) => profile.profile),
    loadToolPacks: async () => (await loadToolPacksFromDir()).map((pack) => pack.toolPack),
  })

  process.on('SIGINT', () => {
    if (activeConversationId) {
      void runtime.abort(activeConversationId)
      return
    }
    void (async () => {
      await runtime.abortAll()
      output.write('\n')
      process.exit(0)
    })()
  })

  writeLine('Aila TUI')
  writeLine(`Data: ${getDataDir()}`)
  writeLine(`Profiles: ${getProfilesDir()}`)
  writeLine(`Tool packs: ${getToolPacksDir()}`)
  writeLine(`Conversation: ${conversationId}${isExisting ? ' (resumed)' : ''}`)
  writeLine(`Model: ${modelLabel(session.selection)}`)
  writeLine(`Profile: ${session.profileId}`)
  writeLine('Type /exit to quit. Ctrl+C aborts an active response.')
  if (isExisting && options.showHistory) await printRecentHistory(conversationId)

  async function retryLastTurn(): Promise<void> {
    startedAssistantText = false
    const { assistantMessageId } = await runtime.retryLastUserMessage({
      conversationId,
      selection: session.selection,
      requestedProfileId: session.profileId,
    })
    activeConversationId = conversationId
    try {
      await new Promise<void>((resolve) => completions.set(assistantMessageId, resolve))
    } finally {
      completions.delete(assistantMessageId)
      activeConversationId = null
    }
  }

  if (options.retryLast) {
    try {
      await retryLastTurn()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLine(`\n[retry:error] ${message}`)
    }
  }

  try {
    while (true) {
      const answer = await prompt.question('\nYou> ')
      if (answer === null) break
      const text = answer.trim()
      if (!text) continue
      if (text === '/retry' || text === '/continue') {
        try {
          await retryLastTurn()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeLine(`\n[retry:error] ${message}`)
        }
        continue
      }

      const slashResult = await handleSlashCommand({
        text,
        conversationId,
        runtime,
        session,
        prompt,
      })
      if (slashResult === 'exit') break
      if (slashResult === 'handled') {
        continue
      }

      startedAssistantText = false
      const { assistantMessageId } = await runtime.send({
        conversationId,
        userText: text,
        selection: session.selection,
        requestedProfileId: session.profileId,
      })
      activeConversationId = conversationId
      await new Promise<void>((resolve) => completions.set(assistantMessageId, resolve))
      completions.delete(assistantMessageId)
      activeConversationId = null
    }
  } finally {
    prompt.close()
    await runtime.abortAll()
  }
}

export async function askToolApproval(
  prompt: PromptReader,
  request: ToolApprovalRequest,
): Promise<boolean> {
  writeLine(`\n[approval] ${request.name}`)
  writeLine(`access: ${request.metadata.access.join(', ')}`)
  writeLine(`scope: ${request.metadata.scope.join(', ')}`)
  writeLine(`args: ${preview(JSON.stringify(request.args), 1000)}`)
  const answer = (await prompt.question('Approve tool execution? [y/N] '))?.trim().toLowerCase()
  const approved = answer === 'y' || answer === 'yes'
  writeLine(approved ? '[approval] approved' : '[approval] denied')
  return approved
}

export function handleRuntimeEvent(
  event: AgentRuntimeEvent,
  state: {
    completions: Map<string, () => void>
    toolNames: Map<string, string>
    onAssistantTextStart: () => void
  },
): void {
  switch (event.type) {
    case 'chat:text-delta':
      state.onAssistantTextStart()
      output.write(event.data.delta)
      break
    case 'chat:reasoning-delta':
      break
    case 'chat:tool-call-start': {
      const existing = state.toolNames.get(event.data.toolCallId)
      state.toolNames.set(event.data.toolCallId, event.data.name)
      if (!existing) writeLine(`\n[tool] ${event.data.name}`)
      break
    }
    case 'chat:tool-call-result': {
      const name = state.toolNames.get(event.data.toolCallId) ?? event.data.toolCallId
      const status = event.data.isError ? 'error' : 'done'
      writeLine(`\n[tool:${status}] ${name}: ${preview(event.data.result)}`)
      break
    }
    case 'chat:image-block':
      writeLine(`\n[image] ${event.data.block.url}`)
      break
    case 'chat:done':
      if (event.data.usage) {
        const usage = event.data.usage
        writeLine(
          `\n[done] tokens: ${usage.promptTokens} in, ${usage.completionTokens} out, ${usage.totalTokens} total`,
        )
      } else {
        writeLine('\n[done]')
      }
      state.completions.get(event.data.messageId)?.()
      break
    case 'chat:error':
      writeLine(`\n[error] ${event.data.error}`)
      state.completions.get(event.data.messageId)?.()
      break
    case 'conversations:updated':
    case 'chat:tool-call-args-delta':
      break
  }
}

if (import.meta.main) {
  runLineMode().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    output.write(`Aila TUI failed: ${message}\n\n${usage()}\n`)
    process.exitCode = 1
  })
}
