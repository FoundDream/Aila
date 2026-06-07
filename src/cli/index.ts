#!/usr/bin/env bun

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { stdin as input, stdout as output, stderr } from 'node:process'
import * as dotenv from 'dotenv'
import {
  type AgentProfileId,
  AgentRuntime,
  type AgentRuntimeEvent,
  applyFindReplace,
  type ConversationSummary,
  configureDataDir,
  configuredProviders,
  createConversation,
  type DocEditRequest,
  type DocEditResult,
  findModel,
  formatFindReplaceErrors,
  getConversation,
  getDataDir,
  getDoc,
  getExtensionReport,
  getProfilesDir,
  getToolPacksDir,
  listConversations,
  listDocConversations,
  loadAgentProfilesFromDir,
  loadSettings,
  loadToolPacksFromDir,
  MODEL_CATALOG,
  type ModelSelection,
  type PersistedMessage,
  PROVIDER_LABELS,
  type ProviderId,
  type ToolApprovalRequest,
  updateDoc,
} from '../runtime'

dotenv.config()

interface CliOptions {
  autoApprove: boolean
  conversationId?: string
  dataDir?: string
  docPath?: string
  events: boolean
  extensions: boolean
  json: boolean
  list: boolean
  limit: number
  model?: ModelSelection
  profileId: AgentProfileId
  prompt?: string
  retryLast: boolean
  resumeLatest: boolean
}

interface CompletionState {
  assistantText: string
  error: string | null
  message: PersistedMessage | null
  status: 'done' | 'error'
  usage: unknown
}

function usage(): string {
  return [
    'Usage: bun run cli -- [options] [prompt]',
    '',
    'Examples:',
    '  bun run cli -- "summarize this repo"',
    '  cat task.txt | bun run cli -- --profile coding',
    '  bun run cli -- --resume --json "continue"',
    '',
    'Options:',
    '  --prompt <text>         Prompt text; positional prompt and stdin are also supported',
    '  --conversation <id>     Continue an existing conversation',
    '  --data-dir <path>       Data directory (default: $AILA_DATA_DIR, ./.dev-data, or ~/.aila)',
    '  --doc <path>            Bind a new or existing doc conversation to a markdown doc path',
    '  --extensions            Validate and list manifest profiles/tool packs, then exit',
    '  --list                  List saved conversations and exit',
    '  --limit <n>             Limit rows for --list (default: 20)',
    '  --model <provider:id>   Override model, e.g. openai:gpt-5.4',
    '  --profile <name>        chat | coding | research or a manifest profile (default: coding)',
    '  --resume                Continue the most recently updated conversation',
    '  --retry-last            Retry a dangling last user turn without appending a duplicate',
    '  --json                  Print a final JSON result instead of streaming text',
    '  --events                Print runtime events as NDJSON instead of streaming text',
    '  --yes                   Auto-approve tool executions that request approval',
    '  -h, --help              Show this help',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    autoApprove: false,
    events: false,
    extensions: false,
    json: false,
    list: false,
    limit: 20,
    profileId: 'coding',
    retryLast: false,
    resumeLatest: false,
  }
  const promptParts: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        output.write(`${usage()}\n`)
        process.exit(0)
        return options
      case '--':
        promptParts.push(...argv.slice(i + 1))
        i = argv.length
        break
      case '--conversation':
        options.conversationId = requireValue(argv, ++i, arg)
        break
      case '--data-dir':
        options.dataDir = resolve(requireValue(argv, ++i, arg))
        break
      case '--doc':
        options.docPath = requireValue(argv, ++i, arg)
        break
      case '--events':
        options.events = true
        break
      case '--extensions':
        options.extensions = true
        break
      case '--json':
        options.json = true
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
      case '--profile':
        options.profileId = requireValue(argv, ++i, arg) as AgentProfileId
        break
      case '--prompt':
        options.prompt = requireValue(argv, ++i, arg)
        break
      case '--resume':
        options.resumeLatest = true
        break
      case '--retry-last':
        options.retryLast = true
        break
      case '--yes':
        options.autoApprove = true
        break
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
        promptParts.push(arg)
        break
    }
  }

  if (promptParts.length > 0) {
    if (options.prompt) throw new Error('--prompt cannot be combined with a positional prompt')
    options.prompt = promptParts.join(' ')
  }
  if (options.conversationId && options.resumeLatest) {
    throw new Error('--conversation and --resume cannot be combined')
  }
  if (options.conversationId && options.list) {
    throw new Error('--conversation and --list cannot be combined')
  }
  if (options.events && options.json) {
    throw new Error('--events and --json cannot be combined because both write structured stdout')
  }
  if (options.extensions && options.events) {
    throw new Error('--extensions and --events cannot be combined')
  }
  if (options.extensions && options.list) {
    throw new Error('--extensions and --list cannot be combined')
  }
  if (options.extensions && options.prompt !== undefined) {
    throw new Error('--extensions cannot be combined with a prompt')
  }
  if (options.retryLast && options.prompt !== undefined) {
    throw new Error('--retry-last cannot be combined with a prompt')
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

function parseModel(value: string): ModelSelection {
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

function defaultDataDir(): string {
  if (process.env.AILA_DATA_DIR) return resolve(process.env.AILA_DATA_DIR)
  const repoDevData = resolve(process.cwd(), '.dev-data')
  if (existsSync(repoDevData)) return repoDevData
  return join(homedir(), '.aila')
}

function resolveSelection(explicit?: ModelSelection): ModelSelection {
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

function modelLabel(selection: ModelSelection): string {
  const meta = findModel(selection.providerId, selection.modelId)
  return `${PROVIDER_LABELS[selection.providerId]} / ${meta?.displayName ?? selection.modelId}`
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

function conversationScope(summary: ConversationSummary): string {
  return summary.docId ? `doc:${summary.docId}` : 'chat'
}

function preview(text: string, max = 600): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, max)}...`
}

async function printConversationList(input: { docPath?: string; limit: number }): Promise<void> {
  if (input.docPath) await assertDocExists(input.docPath)
  const conversations = input.docPath
    ? await listDocConversations(input.docPath)
    : await listConversations()
  const shown = conversations.slice(0, input.limit)

  output.write('Aila conversations\n')
  output.write(`Data: ${getDataDir()}\n`)
  if (input.docPath) output.write(`Doc: ${input.docPath}\n`)
  if (shown.length === 0) {
    output.write('No conversations found.\n')
    return
  }

  for (const summary of shown) {
    const usage = summary.usage ? `, ${summary.usage.totalTokens} tokens` : ''
    output.write(
      `${formatDate(summary.updatedAt)}  ${summary.id}  ${conversationScope(summary)}  ${summary.title}${usage}\n`,
    )
  }
  if (conversations.length > shown.length) {
    output.write(`Showing ${shown.length} of ${conversations.length}. Use --limit to show more.\n`)
  }
}

async function printExtensionReport(json: boolean): Promise<boolean> {
  const report = await getExtensionReport()

  if (json) {
    output.write(`${JSON.stringify(report, null, 2)}\n`)
    return report.ok
  }

  output.write('Aila extensions\n')
  output.write(`Data: ${report.dataDir}\n`)
  output.write(`Profiles: ${report.profilesDir}\n`)
  const profileError = report.errors.find((error) => error.kind === 'profiles')
  if (profileError) {
    output.write(`  [error] ${profileError.message}\n`)
  } else if (report.profiles.length === 0) {
    output.write('  (none)\n')
  } else {
    for (const profile of report.profiles) {
      output.write(`  ${profile.id} (${profile.baseProfileId}) - ${profile.label}\n`)
    }
  }

  output.write(`Tool packs: ${report.toolPacksDir}\n`)
  const toolPackError = report.errors.find((error) => error.kind === 'toolPacks')
  if (toolPackError) {
    output.write(`  [error] ${toolPackError.message}\n`)
  } else if (report.toolPacks.length === 0) {
    output.write('  (none)\n')
  } else {
    for (const pack of report.toolPacks) {
      const toolNames = pack.tools.join(', ')
      output.write(`  ${pack.id} - ${pack.tools.length} tools`)
      if (toolNames) output.write(`: ${toolNames}`)
      output.write('\n')
    }
  }

  return report.ok
}

async function resolveConversation(input: {
  conversationId?: string
  docPath?: string
  resumeLatest?: boolean
}): Promise<{ conversationId: string; boundDocPath: string | null; isExisting: boolean }> {
  if (input.resumeLatest) {
    if (input.docPath) {
      await assertDocExists(input.docPath)
      const [summary] = await listDocConversations(input.docPath)
      if (!summary) throw new Error(`no conversations found for doc: ${input.docPath}`)
      return {
        conversationId: summary.id,
        boundDocPath: summary.docId ?? null,
        isExisting: true,
      }
    }

    const [summary] = await listConversations()
    if (!summary) throw new Error('no conversations found to resume')
    return {
      conversationId: summary.id,
      boundDocPath: summary.docId ?? null,
      isExisting: true,
    }
  }

  if (input.conversationId) {
    const record = await getConversation(input.conversationId)
    const boundDocPath = record.meta.docId ?? null
    if (input.docPath) {
      await assertDocExists(input.docPath)
      if (boundDocPath !== input.docPath) {
        throw new Error(
          boundDocPath
            ? `conversation is bound to doc "${boundDocPath}", not "${input.docPath}"`
            : '--doc cannot bind an existing unbound conversation; omit --conversation to create a doc-bound conversation',
        )
      }
    }
    return { conversationId: input.conversationId, boundDocPath, isExisting: true }
  }

  if (input.docPath) {
    await assertDocExists(input.docPath)
    const summary = await createConversation(input.docPath)
    return { conversationId: summary.id, boundDocPath: input.docPath, isExisting: false }
  }

  const summary = await createConversation()
  return { conversationId: summary.id, boundDocPath: null, isExisting: false }
}

async function assertDocExists(docPath: string): Promise<void> {
  try {
    await getDoc(docPath)
  } catch {
    throw new Error(`doc not found: ${docPath}`)
  }
}

function readPrompt(options: CliOptions): string {
  if (options.prompt !== undefined) return options.prompt
  if (!input.isTTY) return readFileSync(0, 'utf-8').trim()
  throw new Error('missing prompt; pass one as an argument, use --prompt, or pipe stdin')
}

async function applyDocEdit(req: DocEditRequest): Promise<DocEditResult> {
  let doc: Awaited<ReturnType<typeof getDoc>>
  try {
    doc = await getDoc(req.docPath)
  } catch {
    return { ok: false, error: `doc not found: ${req.docPath}` }
  }

  const result = applyFindReplace(doc.content, req.edits)
  if (!result.ok) {
    return {
      ok: false,
      error: formatFindReplaceErrors(result.errors),
      conflicts: result.errors.map((error) => `edit #${error.index}: ${error.reason}`),
    }
  }

  await updateDoc(req.docPath, { content: result.body })
  return {
    ok: true,
    title: doc.title,
    appliedCount: result.appliedCount,
    patches: result.patches,
    diffPreview: result.diffPreview,
  }
}

function messageToText(message: PersistedMessage | null): string {
  if (!message) return ''
  return message.blocks
    .map((block) => {
      if (block.type === 'tool_call' || block.type === 'image') return ''
      return block.content
    })
    .join('')
}

function createRuntime(input: {
  autoApprove: boolean
  events: boolean
  json: boolean
  onCompletion: (state: CompletionState) => void
}): AgentRuntime {
  let assistantText = ''
  const toolNames = new Map<string, string>()

  return new AgentRuntime({
    onEvent: (event) => {
      if (input.events) output.write(`${JSON.stringify(event)}\n`)
      handleRuntimeEvent(event, {
        assistantText,
        events: input.events,
        json: input.json,
        toolNames,
        onAssistantText: (delta) => {
          assistantText += delta
        },
        onCompletion: input.onCompletion,
      })
    },
    onToolApproval: (request) => approveTool(request, input.autoApprove, input.events),
    onDocEdit: applyDocEdit,
    loadProfiles: async () => (await loadAgentProfilesFromDir()).map((profile) => profile.profile),
    loadToolPacks: async () => (await loadToolPacksFromDir()).map((pack) => pack.toolPack),
  })
}

async function approveTool(request: ToolApprovalRequest, autoApprove: boolean, events: boolean) {
  if (autoApprove) {
    if (!events) stderr.write(`[approval] approved ${request.name}\n`)
    return true
  }
  if (!events) {
    stderr.write(
      `[approval] denied ${request.name}; pass --yes to approve requested tool executions\n`,
    )
  }
  return false
}

function handleRuntimeEvent(
  event: AgentRuntimeEvent,
  state: {
    assistantText: string
    events: boolean
    json: boolean
    toolNames: Map<string, string>
    onAssistantText: (delta: string) => void
    onCompletion: (state: CompletionState) => void
  },
): void {
  switch (event.type) {
    case 'chat:text-delta':
      state.onAssistantText(event.data.delta)
      if (!state.events && !state.json) output.write(event.data.delta)
      break
    case 'chat:tool-call-start': {
      const existing = state.toolNames.get(event.data.toolCallId)
      state.toolNames.set(event.data.toolCallId, event.data.name)
      if (!existing && !state.events && !state.json) stderr.write(`[tool] ${event.data.name}\n`)
      break
    }
    case 'chat:tool-call-result': {
      if (!state.events && !state.json) {
        const name = state.toolNames.get(event.data.toolCallId) ?? event.data.toolCallId
        const status = event.data.isError ? 'error' : 'done'
        stderr.write(`[tool:${status}] ${name}: ${preview(event.data.result)}\n`)
      }
      break
    }
    case 'chat:image-block':
      if (!state.events && !state.json) stderr.write(`[image] ${event.data.block.url}\n`)
      break
    case 'chat:done':
      if (!state.events && !state.json) output.write('\n')
      state.onCompletion({
        assistantText: state.assistantText || messageToText(event.data.message),
        error: null,
        message: event.data.message,
        status: 'done',
        usage: event.data.usage ?? null,
      })
      break
    case 'chat:error':
      if (!state.events && !state.json) stderr.write(`[error] ${event.data.error}\n`)
      state.onCompletion({
        assistantText: state.assistantText || messageToText(event.data.message),
        error: event.data.error,
        message: event.data.message,
        status: 'error',
        usage: null,
      })
      break
    case 'chat:reasoning-delta':
    case 'chat:tool-call-args-delta':
    case 'conversations:updated':
      break
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  configureDataDir(options.dataDir ?? defaultDataDir())

  if (options.list) {
    await printConversationList({ docPath: options.docPath, limit: options.limit })
    return
  }

  if (options.extensions) {
    const ok = await printExtensionReport(options.json)
    if (!ok) process.exitCode = 1
    return
  }

  const prompt = options.retryLast ? null : readPrompt(options)
  if (prompt !== null && !prompt.trim()) throw new Error('prompt is empty')

  const selection = resolveSelection(options.model)
  const { conversationId, boundDocPath, isExisting } = await resolveConversation({
    conversationId: options.conversationId,
    docPath: options.docPath,
    resumeLatest: options.resumeLatest,
  })

  const completionRef: { current: CompletionState | null } = { current: null }
  let resolveCompletion: () => void = () => {}
  const completionWait = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })
  const runtime = createRuntime({
    autoApprove: options.autoApprove,
    events: options.events,
    json: options.json,
    onCompletion: (state) => {
      completionRef.current = state
      resolveCompletion()
    },
  })

  if (!options.events && !options.json) {
    stderr.write(`Data: ${getDataDir()}\n`)
    stderr.write(`Profiles: ${getProfilesDir()}\n`)
    stderr.write(`Tool packs: ${getToolPacksDir()}\n`)
    stderr.write(`Conversation: ${conversationId}${isExisting ? ' (resumed)' : ''}\n`)
    if (boundDocPath) stderr.write(`Doc: ${boundDocPath}\n`)
    stderr.write(`Model: ${modelLabel(selection)}\n`)
    stderr.write(`Profile: ${boundDocPath ? 'doc' : options.profileId}\n`)
  }

  try {
    const result = options.retryLast
      ? await runtime.retryLastUserMessage({
          conversationId,
          selection,
          requestedProfileId: options.profileId,
        })
      : await runtime.send({
          conversationId,
          userText: prompt ?? '',
          selection,
          requestedProfileId: options.profileId,
        })
    const { assistantMessageId } = result
    process.on('SIGINT', () => {
      runtime.abort(conversationId)
      stderr.write(`Aborted conversation ${conversationId}, message ${assistantMessageId}\n`)
    })
    await completionWait
  } finally {
    runtime.abortAll()
  }

  const completed = completionRef.current
  if (!completed) {
    throw new Error('runtime finished without a completion event')
  }

  if (options.json) {
    output.write(
      `${JSON.stringify(
        {
          id: randomUUID(),
          conversationId,
          dataDir: getDataDir(),
          docPath: boundDocPath,
          profileId: boundDocPath ? 'doc' : options.profileId,
          model: selection,
          status: completed.status,
          text: completed.assistantText,
          error: completed.error,
          usage: completed.usage,
          message: completed.message,
        },
        null,
        2,
      )}\n`,
    )
  }

  if (completed.status === 'error') process.exitCode = 1
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  stderr.write(`Aila CLI failed: ${message}\n\n${usage()}\n`)
  process.exitCode = 1
})
