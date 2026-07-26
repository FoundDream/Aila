#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import {
  type AgentRuntimeApi,
  type AgentRuntimeEvent,
  type AilaExecutionMode,
  type ConversationSummary,
  createToolPolicy,
  findModel,
  isAilaExecutionMode,
  isToolApprovalMode,
  MODEL_CATALOG,
  type ModelSelection,
  type PersistedMessage,
  PROVIDER_ORDER,
  type ProviderId,
  providerLabel,
  requestToolApprovalWithActivity,
  type ToolApprovalMode,
  type ToolApprovalRequest,
} from '@aila/agent'
import {
  configureDataDir,
  configuredProviders,
  createPersistedAgentRuntime,
  type ExtensionReport,
  getDataDir,
  getExtensionReport,
  getToolPacksDir,
  loadSettings,
} from '@aila/agent-node/app'
import * as dotenv from 'dotenv'

dotenv.config()

export interface CliOptions {
  conversationId?: string
  dataDir?: string
  list: boolean
  limit: number
  model?: ModelSelection
  mode: AilaExecutionMode
  planId?: string
  approvalMode: ToolApprovalMode
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
  mode: AilaExecutionMode
  planId?: string
}

export interface TuiRuntimeInput {
  approvalMode?: ToolApprovalMode
  onEvent?: (event: AgentRuntimeEvent) => void
  onToolApproval?: (request: ToolApprovalRequest) => Promise<boolean>
}

export function createTuiRuntime(input: TuiRuntimeInput = {}): AgentRuntimeApi {
  let runtime: AgentRuntimeApi
  runtime = createPersistedAgentRuntime({
    host: {
      onToolPolicy: createToolPolicy(input.approvalMode ?? 'safe'),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      ...(input.onToolApproval
        ? {
            onToolApproval: (request: ToolApprovalRequest) =>
              requestToolApprovalWithActivity({
                request,
                approve: input.onToolApproval ?? (() => false),
                recordAgentEvent: async (_conversationId, event) => {
                  await runtime.recordAgentEvent(event)
                },
                logger: console,
              }),
          }
        : {}),
    },
  })
  return runtime
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
    '  --mode <mode>           Runtime mode: agent, plan, or chat (default: agent)',
    '  --plan <id>             Bind prompts and approvals to a plan id',
    '  --approval-mode <mode>  Tool execution mode: safe or yolo (default: safe)',
    '  --safe                  Use safe tool mode',
    '  --yolo                  Run tools without approval prompts',
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
    '  /model [provider:id]    Show or switch the active model',
    '  /mode [agent|plan|chat] Show or switch runtime mode',
    '  /plan [prompt]          Switch to Plan mode, or run prompt in Plan mode',
    '  /plans                  List plans for this conversation',
    '  /use-plan <id>          Bind following prompts to a plan',
    '  /approve-plan [id]      Approve a ready plan and start implementation',
    '  /cancel-plan [id]       Cancel a plan',
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
  if (!PROVIDER_ORDER.includes(providerId)) {
    throw new Error(`unknown provider: ${providerId}`)
  }
  return { providerId, modelId }
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    approvalMode: 'safe',
    list: false,
    limit: 20,
    mode: 'agent',
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
      case '--mode':
        options.mode = parseExecutionMode(requireValue(argv, ++i, arg))
        break
      case '--plan':
        options.planId = requireValue(argv, ++i, arg)
        break
      case '--approval-mode':
        options.approvalMode = parseApprovalMode(requireValue(argv, ++i, arg))
        break
      case '--no-history':
        options.showHistory = false
        break
      case '--safe':
        options.approvalMode = 'safe'
        break
      case '--yolo':
        options.approvalMode = 'yolo'
        break
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

function parseApprovalMode(value: string): ToolApprovalMode {
  if (isToolApprovalMode(value)) return value
  throw new Error('--approval-mode must be safe or yolo')
}

function parseExecutionMode(value: string): AilaExecutionMode {
  if (isAilaExecutionMode(value)) return value
  throw new Error('--mode must be agent, plan, or chat')
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
  return `${providerLabel(selection.providerId)} / ${meta?.displayName ?? selection.modelId}`
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

export async function printConversationList(
  runtime: AgentRuntimeApi,
  input: { limit: number },
): Promise<void> {
  const conversations = await runtime.listConversations()
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

export async function printPlanList(
  runtime: AgentRuntimeApi,
  conversationId: string,
): Promise<void> {
  const plans = await runtime.listPlans(conversationId)
  writeLine('Aila plans')
  writeLine(`Conversation: ${conversationId}`)
  if (plans.length === 0) {
    writeLine('No plans found.')
    return
  }

  for (const plan of plans) {
    const revision = plan.latestRevisionId ? `, revision ${plan.latestRevisionId}` : ''
    writeLine(`${formatDate(plan.updatedAt)}  ${plan.id}  ${plan.status}${revision}  ${plan.title}`)
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
    '  /model [provider:id]    Show or switch the active model',
    '  /mode [agent|plan|chat] Show or switch runtime mode',
    '  /plan [prompt]          Switch to Plan mode, or run prompt in Plan mode',
    '  /plans                  List plans for this conversation',
    '  /use-plan <id>          Bind following prompts to a plan',
    '  /approve-plan [id]      Approve a ready plan and start implementation',
    '  /cancel-plan [id]       Cancel a plan',
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
  runtime: AgentRuntimeApi
  conversationId: string
  command: string
  result: string
}): Promise<void> {
  await input.runtime.appendUserMessage({
    conversationId: input.conversationId,
    text: `[local command]\n${input.command}\n\n[result]\n${input.result}`,
  })
}

export async function runLocalTool(input: {
  runtime: AgentRuntimeApi
  toolName: 'read' | 'bash' | 'write' | 'edit'
  args: Record<string, unknown>
}): Promise<string> {
  return input.runtime.executeTool({
    name: input.toolName,
    args: input.args,
  })
}

export function writeExtensionReport(report: ExtensionReport): void {
  writeLine('Aila extensions')
  writeLine(`Data: ${report.dataDir}`)
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

  writeLine(`Skills: ${report.skillsDir}`)
  const skillErrors = report.errors.filter((error) => error.kind === 'skills')
  for (const skillError of skillErrors) {
    writeLine(`  [error] ${skillError.message}`)
  }
  if (report.skills.length === 0) {
    if (skillErrors.length === 0) writeLine('  (none)')
  } else {
    for (const skill of report.skills) {
      writeLine(`  ${skill.name} - ${skill.description}`)
    }
  }
}

export async function handleSlashCommand(input: {
  text: string
  conversationId: string
  runtime: AgentRuntimeApi
  session: TuiSessionState
}): Promise<'handled' | 'exit' | 'agent'> {
  const { text, conversationId, runtime, session } = input
  if (!text.startsWith('/')) return 'agent'

  const commandText = text.slice(1).trim()
  const command = readShellToken(commandText)
  const name = command?.token.toLowerCase() ?? ''
  const rest = command?.rest ?? ''

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
          const registry = await runtime.reloadToolPacks()
          writeLine(
            `[extensions] reloaded ${registry.toolPacks.length} tool packs, ${registry.specs.length} tools`,
          )
        }
        writeExtensionReport(await getExtensionReport())
        return 'handled'
      }
      case 'reload':
      case 'refresh': {
        const registry = await runtime.reloadToolPacks()
        writeLine(
          `[extensions] reloaded ${registry.toolPacks.length} tool packs, ${registry.specs.length} tools`,
        )
        return 'handled'
      }
      case 'session':
      case 'sessions':
        await printConversationList(runtime, { limit: 20 })
        return 'handled'
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
      case 'mode': {
        const words = splitShellWords(rest)
        if (words.length === 0) {
          writeLine(`[mode] ${session.mode}`)
          return 'handled'
        }
        if (words.length > 1) throw new Error('usage: /mode [agent|plan|chat]')
        session.mode = parseExecutionMode(words[0])
        writeLine(`[mode] ${session.mode}`)
        return 'handled'
      }
      case 'plan':
        session.mode = 'plan'
        writeLine('[mode] plan')
        return 'handled'
      case 'plans':
        await printPlanList(runtime, conversationId)
        return 'handled'
      case 'use-plan': {
        const [planId] = splitShellWords(rest)
        if (!planId) throw new Error('usage: /use-plan <id>')
        session.planId = planId
        writeLine(`[plan] using ${planId}`)
        return 'handled'
      }
      case 'cancel-plan': {
        const [planId] = splitShellWords(rest)
        const targetPlanId = planId ?? session.planId
        if (!targetPlanId) throw new Error('usage: /cancel-plan [id]')
        const plan = await runtime.cancelPlan({
          conversationId,
          planId: targetPlanId,
          reason: 'tui',
        })
        if (session.planId === targetPlanId) session.planId = undefined
        writeLine(`[plan] cancelled ${plan.id} (${plan.status})`)
        return 'handled'
      }
      case 'read': {
        const [pathArg] = splitShellWords(rest)
        if (!pathArg) throw new Error('usage: /read <path>')
        const path = workspacePath(pathArg)
        const result = await runLocalTool({
          runtime,
          toolName: 'read',
          args: { path },
        })
        writeLine(`\n[read] ${path}\n${displayPreview(result)}`)
        await appendLocalContext({ runtime, conversationId, command: `/read ${path}`, result })
        return 'handled'
      }
      case 'run': {
        if (!rest) throw new Error('usage: /run <command>')
        const result = await runLocalTool({
          runtime,
          toolName: 'bash',
          args: { command: rest },
        })
        const display = formatToolResultForDisplay('bash', result)
        writeLine(`\n[run] ${rest}\n${displayPreview(display)}`)
        await appendLocalContext({
          runtime,
          conversationId,
          command: `/run ${rest}`,
          result: display,
        })
        return 'handled'
      }
      case 'write': {
        const parsed = readShellToken(rest)
        if (!parsed?.rest) throw new Error('usage: /write <path> <content>')
        const path = workspacePath(parsed.token)
        const result = await runLocalTool({
          runtime,
          toolName: 'write',
          args: { path, content: parsed.rest },
        })
        writeLine(`\n[write] ${path}\n${displayPreview(result)}`)
        await appendLocalContext({ runtime, conversationId, command: `/write ${path}`, result })
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
          runtime,
          toolName: 'edit',
          args: { path, oldText: oldText.trim(), newText: newText.trim() },
        })
        writeLine(`\n[edit] ${path}\n${displayPreview(result)}`)
        await appendLocalContext({ runtime, conversationId, command: `/edit ${path}`, result })
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

export async function printRecentHistory(
  runtime: AgentRuntimeApi,
  conversationId: string,
  maxMessages = 6,
): Promise<void> {
  const record = await runtime.getConversation(conversationId)
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
    await printConversationList(createTuiRuntime({ approvalMode: options.approvalMode }), {
      limit: options.limit,
    })
    return
  }

  const session: TuiSessionState = {
    selection: resolveSelection(options.model),
    mode: options.mode,
    ...(options.planId ? { planId: options.planId } : {}),
  }

  let activeConversationId: string | null = null
  const completions = new Map<string, () => void>()
  const toolNames = new Map<string, string>()
  let startedAssistantText = false
  const prompt = createPromptReader()
  const runtime = createTuiRuntime({
    approvalMode: options.approvalMode,
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
  })
  const { conversationId, isExisting } = await runtime.resolveConversation({
    conversationId: options.conversationId,
    resumeLatest: options.resumeLatest,
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
  writeLine(`Tool packs: ${getToolPacksDir()}`)
  writeLine(`Conversation: ${conversationId}${isExisting ? ' (resumed)' : ''}`)
  writeLine(`Model: ${modelLabel(session.selection)}`)
  writeLine(`Runtime mode: ${session.mode}`)
  if (session.planId) writeLine(`Plan: ${session.planId}`)
  writeLine('Type /exit to quit. Ctrl+C aborts an active response.')
  if (isExisting && options.showHistory) await printRecentHistory(runtime, conversationId)

  async function waitForAssistantTurn(assistantMessageId: string): Promise<void> {
    activeConversationId = conversationId
    try {
      await new Promise<void>((resolve) => completions.set(assistantMessageId, resolve))
    } finally {
      completions.delete(assistantMessageId)
      activeConversationId = null
    }
  }

  async function runSendTurn(
    userText: string,
    input: { mode?: AilaExecutionMode; planId?: string } = {},
  ): Promise<void> {
    startedAssistantText = false
    const mode = input.mode ?? session.mode
    const planId = input.planId ?? session.planId
    const { assistantMessageId } =
      mode === 'plan' && planId
        ? await runtime.revisePlan({
            conversationId,
            planId,
            userText,
            selection: session.selection,
          })
        : await runtime.send({
            conversationId,
            userText,
            selection: session.selection,
            mode,
            ...(planId ? { planId } : {}),
          })
    await waitForAssistantTurn(assistantMessageId)
  }

  async function runApprovePlan(planId: string): Promise<void> {
    startedAssistantText = false
    const { assistantMessageId } = await runtime.approvePlan({
      conversationId,
      planId,
      selection: session.selection,
    })
    await waitForAssistantTurn(assistantMessageId)
  }

  async function retryLastTurn(): Promise<void> {
    startedAssistantText = false
    const { assistantMessageId } = await runtime.retryLastUserMessage({
      conversationId,
      selection: session.selection,
      mode: session.mode,
      ...(session.planId ? { planId: session.planId } : {}),
    })
    await waitForAssistantTurn(assistantMessageId)
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
      if (text.startsWith('/')) {
        const commandText = text.slice(1).trim()
        const command = readShellToken(commandText)
        const name = command?.token.toLowerCase() ?? ''
        const rest = command?.rest ?? ''
        if (name === 'plan') {
          if (!rest) {
            session.mode = 'plan'
            writeLine('[mode] plan')
            continue
          }
          await runSendTurn(rest, {
            mode: 'plan',
            ...(session.planId ? { planId: session.planId } : {}),
          })
          continue
        }
        if (name === 'approve-plan') {
          const [planId] = splitShellWords(rest)
          const targetPlanId = planId ?? session.planId
          if (!targetPlanId) throw new Error('usage: /approve-plan [id]')
          await runApprovePlan(targetPlanId)
          continue
        }
      }

      const slashResult = await handleSlashCommand({
        text,
        conversationId,
        runtime,
        session,
      })
      if (slashResult === 'exit') break
      if (slashResult === 'handled') {
        continue
      }

      await runSendTurn(text)
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
    case 'agent:event':
      if (event.data.type === 'turn.interrupted') {
        const reason =
          typeof event.data.data?.reason === 'string' && event.data.data.reason.length > 0
            ? event.data.data.reason
            : 'Interrupted'
        writeLine(`\n[interrupted] ${reason}`)
        state.completions.get(event.data.messageId)?.()
      } else if (event.data.type.startsWith('plan.')) {
        const data = event.data.data ?? {}
        const planId = typeof data.planId === 'string' ? ` ${data.planId}` : ''
        const status = typeof data.status === 'string' ? ` (${data.status})` : ''
        writeLine(`\n[plan] ${event.data.type}${planId}${status}`)
      }
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
