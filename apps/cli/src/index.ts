#!/usr/bin/env bun

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { stdin as input, stdout as output, stderr } from 'node:process'
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
  getDataDir,
  getExtensionReport,
  getToolPacksDir,
  loadSettings,
} from '@aila/agent-node/app'
import * as dotenv from 'dotenv'

dotenv.config()

interface CliOptions {
  approvalMode: ToolApprovalMode
  conversationId?: string
  dataDir?: string
  events: boolean
  extensions: boolean
  json: boolean
  list: boolean
  limit: number
  model?: ModelSelection
  mode: AilaExecutionMode
  planId?: string
  listPlans: boolean
  approvePlanId?: string
  cancelPlanId?: string
  expectedRevisionId?: string
  prompt?: string
  retryLast: boolean
  resumeLatest: boolean
  runAction?: 'inspect' | 'step' | 'continue' | 'resume' | 'abort' | 'fork'
  runId?: string
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
    '  cat task.txt | bun run cli',
    '  bun run cli -- --resume --json "continue"',
    '',
    'Options:',
    '  --prompt <text>         Prompt text; positional prompt and stdin are also supported',
    '  --conversation <id>     Continue an existing conversation',
    '  --data-dir <path>       Data directory (default: $AILA_DATA_DIR, ./.dev-data, or ~/.aila)',
    '  --extensions            Validate and list manifest tool packs, then exit',
    '  --list                  List saved conversations and exit',
    '  --limit <n>             Limit rows for --list (default: 20)',
    '  --model <provider:id>   Override model, e.g. openai:gpt-5.4',
    '  --mode <mode>           Runtime mode: agent, plan, or chat (default: agent)',
    '  --plan <id>             Bind a prompt, revision, or approval to a plan id',
    '  --list-plans            List plans for the resolved conversation and exit',
    '  --approve-plan <id>     Approve a ready plan and start implementation',
    '  --cancel-plan <id>      Cancel a plan and exit',
    '  --expected-revision <id> Guard plan edit/approval against stale revisions',
    '  --resume                Continue the most recently updated conversation',
    '  --retry-last            Retry the last failed or dangling user turn without duplicating it',
    '  --inspect-run <id>      Print a persisted run, its events, and artifacts',
    '  --step-run <id>         Execute exactly one pending run action',
    '  --continue-run <id>     Continue a paused run until it stops',
    '  --resume-run <id>       Resume an interrupted or paused run',
    '  --abort-run <id>        Cancel a persisted run',
    '  --fork-run <id>         Fork a persisted run at its latest checkpoint',
    '  --json                  Print a final JSON result instead of streaming text',
    '  --events                Print runtime events as NDJSON instead of streaming text',
    '  --approval-mode <mode>  Tool execution mode: safe or yolo (default: safe)',
    '  --safe                  Use safe tool mode',
    '  --yolo, --yes           Run tools without approval prompts',
    '  -h, --help              Show this help',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    approvalMode: 'safe',
    events: false,
    extensions: false,
    json: false,
    list: false,
    listPlans: false,
    limit: 20,
    mode: 'agent',
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
      case '--mode':
        options.mode = parseExecutionMode(requireValue(argv, ++i, arg))
        break
      case '--plan':
        options.planId = requireValue(argv, ++i, arg)
        break
      case '--list-plans':
        options.listPlans = true
        break
      case '--approve-plan':
        options.approvePlanId = requireValue(argv, ++i, arg)
        options.planId = options.approvePlanId
        break
      case '--cancel-plan':
        options.cancelPlanId = requireValue(argv, ++i, arg)
        options.planId = options.cancelPlanId
        break
      case '--expected-revision':
        options.expectedRevisionId = requireValue(argv, ++i, arg)
        break
      case '--approval-mode':
        options.approvalMode = parseApprovalMode(requireValue(argv, ++i, arg))
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
      case '--inspect-run':
        setRunAction(options, 'inspect', requireValue(argv, ++i, arg))
        break
      case '--step-run':
        setRunAction(options, 'step', requireValue(argv, ++i, arg))
        break
      case '--continue-run':
        setRunAction(options, 'continue', requireValue(argv, ++i, arg))
        break
      case '--resume-run':
        setRunAction(options, 'resume', requireValue(argv, ++i, arg))
        break
      case '--abort-run':
        setRunAction(options, 'abort', requireValue(argv, ++i, arg))
        break
      case '--fork-run':
        setRunAction(options, 'fork', requireValue(argv, ++i, arg))
        break
      case '--safe':
        options.approvalMode = 'safe'
        break
      case '--yolo':
      case '--yes':
        options.approvalMode = 'yolo'
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
  if (options.list && options.listPlans) {
    throw new Error('--list and --list-plans cannot be combined')
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
  if (options.runAction && options.prompt !== undefined) {
    throw new Error('run management options cannot be combined with a prompt')
  }
  if (options.runAction && !options.conversationId && !options.resumeLatest) {
    throw new Error('run management options require --conversation or --resume')
  }
  const planActions = [
    options.listPlans ? '--list-plans' : '',
    options.approvePlanId ? '--approve-plan' : '',
    options.cancelPlanId ? '--cancel-plan' : '',
  ].filter(Boolean)
  if (planActions.length > 1) {
    throw new Error(`${planActions.join(' and ')} cannot be combined`)
  }
  if ((options.approvePlanId || options.cancelPlanId || options.listPlans) && options.retryLast) {
    throw new Error('--retry-last cannot be combined with plan management options')
  }
  if ((options.approvePlanId || options.cancelPlanId || options.listPlans) && options.prompt) {
    throw new Error('plan management options cannot be combined with a prompt')
  }
  if (
    (options.approvePlanId || options.cancelPlanId || options.listPlans) &&
    !options.conversationId &&
    !options.resumeLatest
  ) {
    throw new Error('plan management options require --conversation or --resume')
  }

  return options
}

function setRunAction(
  options: CliOptions,
  action: NonNullable<CliOptions['runAction']>,
  runId: string,
): void {
  if (options.runAction) throw new Error('run management options cannot be combined')
  options.runAction = action
  options.runId = runId
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

function parseModel(value: string): ModelSelection {
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
  return `${providerLabel(selection.providerId)} / ${meta?.displayName ?? selection.modelId}`
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

async function printConversationList(
  runtime: AgentRuntimeApi,
  input: { limit: number },
): Promise<void> {
  const conversations = await runtime.listConversations()
  const shown = conversations.slice(0, input.limit)

  output.write('Aila conversations\n')
  output.write(`Data: ${getDataDir()}\n`)
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

async function printPlanList(runtime: AgentRuntimeApi, conversationId: string): Promise<void> {
  const plans = await runtime.listPlans(conversationId)

  output.write('Aila plans\n')
  output.write(`Data: ${getDataDir()}\n`)
  output.write(`Conversation: ${conversationId}\n`)
  if (plans.length === 0) {
    output.write('No plans found.\n')
    return
  }

  for (const plan of plans) {
    const revision = plan.latestRevisionId ? `, revision ${plan.latestRevisionId}` : ''
    output.write(
      `${formatDate(plan.updatedAt)}  ${plan.id}  ${plan.status}${revision}  ${plan.title}\n`,
    )
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

  output.write(`Skills: ${report.skillsDir}\n`)
  const skillErrors = report.errors.filter((error) => error.kind === 'skills')
  for (const skillError of skillErrors) {
    output.write(`  [error] ${skillError.message}\n`)
  }
  if (report.skills.length === 0) {
    if (skillErrors.length === 0) output.write('  (none)\n')
  } else {
    for (const skill of report.skills) {
      output.write(`  ${skill.name} - ${skill.description}\n`)
    }
  }

  return report.ok
}

function readPrompt(options: CliOptions): string {
  if (options.prompt !== undefined) return options.prompt
  if (!input.isTTY) return readFileSync(0, 'utf-8').trim()
  throw new Error('missing prompt; pass one as an argument, use --prompt, or pipe stdin')
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
  approvalMode: ToolApprovalMode
  events: boolean
  json: boolean
  onCompletion?: (state: CompletionState) => void
}): AgentRuntimeApi {
  let assistantText = ''
  const toolNames = new Map<string, string>()
  let runtime: AgentRuntimeApi

  runtime = createPersistedAgentRuntime({
    host: {
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
          onCompletion: input.onCompletion ?? (() => {}),
        })
      },
      onToolPolicy: createToolPolicy(input.approvalMode),
      onToolApproval: (request) =>
        requestToolApprovalWithActivity({
          request,
          approve: (approvalRequest) =>
            approveTool(approvalRequest, input.approvalMode, input.events),
          recordAgentEvent: async (_conversationId, event) => {
            await runtime.recordAgentEvent(event)
          },
          logger: console,
        }),
    },
  })
  return runtime
}

async function approveTool(
  request: ToolApprovalRequest,
  approvalMode: ToolApprovalMode,
  events: boolean,
) {
  if (approvalMode === 'yolo') {
    if (!events) stderr.write(`[approval] approved ${request.name}\n`)
    return true
  }
  if (!events) {
    stderr.write(
      `[approval] denied ${request.name}; pass --approval-mode yolo to run without approval\n`,
    )
  }
  return false
}

function interruptedReason(data: Record<string, unknown> | undefined): string {
  const reason = data?.reason
  return typeof reason === 'string' && reason.length > 0 ? reason : 'Interrupted'
}

export function handleRuntimeEvent(
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
    case 'agent:event':
      if (event.data.type === 'turn.interrupted') {
        const reason = interruptedReason(event.data.data)
        if (!state.events && !state.json) stderr.write(`[interrupted] ${reason}\n`)
        state.onCompletion({
          assistantText: state.assistantText,
          error: reason,
          message: null,
          status: 'error',
          usage: null,
        })
      } else if (event.data.type.startsWith('plan.') && !state.events && !state.json) {
        const data = event.data.data ?? {}
        const planId = typeof data.planId === 'string' ? ` ${data.planId}` : ''
        const status = typeof data.status === 'string' ? ` (${data.status})` : ''
        stderr.write(`[plan] ${event.data.type}${planId}${status}\n`)
      }
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
    const runtime = createRuntime({
      approvalMode: options.approvalMode,
      events: options.events,
      json: options.json,
    })
    await printConversationList(runtime, { limit: options.limit })
    return
  }

  if (options.extensions) {
    const ok = await printExtensionReport(options.json)
    if (!ok) process.exitCode = 1
    return
  }

  if (options.runAction && options.runId) {
    const runtime = createRuntime({
      approvalMode: options.approvalMode,
      events: options.events,
      json: options.json,
    })
    const { conversationId } = await runtime.resolveConversation({
      conversationId: options.conversationId,
      resumeLatest: options.resumeLatest,
    })
    const target = { conversationId, runId: options.runId }
    if (options.runAction === 'step') {
      await runtime.stepRun(target)
      await waitForRunIdle(runtime, options.runId)
    } else if (options.runAction === 'continue') {
      await runtime.continueRun(target)
      await waitForRunIdle(runtime, options.runId)
    } else if (options.runAction === 'resume') {
      await runtime.resumeRun(target)
      await waitForRunIdle(runtime, options.runId)
    } else if (options.runAction === 'abort') {
      await runtime.abortRun(target)
    } else if (options.runAction === 'fork') {
      const forked = await runtime.forkRun(target)
      if (!options.events) output.write(`${JSON.stringify(forked, null, 2)}\n`)
      return
    }
    const inspection = await runtime.inspectRun(target)
    if (!options.events) output.write(`${JSON.stringify(inspection, null, 2)}\n`)
    return
  }

  if (options.listPlans || options.cancelPlanId) {
    const runtime = createRuntime({
      approvalMode: options.approvalMode,
      events: options.events,
      json: options.json,
    })
    const { conversationId } = await runtime.resolveConversation({
      conversationId: options.conversationId,
      resumeLatest: options.resumeLatest,
    })
    if (options.listPlans) {
      await printPlanList(runtime, conversationId)
      return
    }
    const plan = await runtime.cancelPlan({
      conversationId,
      planId: options.cancelPlanId ?? '',
      reason: 'cli',
    })
    if (options.json) {
      output.write(`${JSON.stringify({ conversationId, plan }, null, 2)}\n`)
    } else {
      output.write(`Plan cancelled: ${plan.id} (${plan.status})\n`)
    }
    return
  }

  const prompt = options.retryLast || options.approvePlanId ? null : readPrompt(options)
  if (prompt !== null && !prompt.trim()) throw new Error('prompt is empty')

  const selection = resolveSelection(options.model)
  const completionRef: { current: CompletionState | null } = { current: null }
  let resolveCompletion: () => void = () => {}
  const completionWait = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })
  const runtime = createRuntime({
    approvalMode: options.approvalMode,
    events: options.events,
    json: options.json,
    onCompletion: (state) => {
      completionRef.current = state
      resolveCompletion()
    },
  })
  const { conversationId, isExisting } = await runtime.resolveConversation({
    conversationId: options.conversationId,
    resumeLatest: options.resumeLatest,
  })

  if (!options.events && !options.json) {
    stderr.write(`Data: ${getDataDir()}\n`)
    stderr.write(`Tool packs: ${getToolPacksDir()}\n`)
    stderr.write(`Conversation: ${conversationId}${isExisting ? ' (resumed)' : ''}\n`)
    stderr.write(`Model: ${modelLabel(selection)}\n`)
    stderr.write(`Runtime mode: ${options.mode}\n`)
    if (options.planId) stderr.write(`Plan: ${options.planId}\n`)
    stderr.write(`Tool approval: ${options.approvalMode}\n`)
  }

  try {
    const result = options.approvePlanId
      ? await runtime.approvePlan({
          conversationId,
          planId: options.approvePlanId,
          selection,
          expectedRevisionId: options.expectedRevisionId,
          approvalMode: options.approvalMode,
        })
      : options.retryLast
        ? await runtime.retryLastUserMessage({
            conversationId,
            selection,
            mode: options.mode,
            ...(options.planId ? { planId: options.planId } : {}),
          })
        : options.planId && options.mode === 'plan'
          ? await runtime.revisePlan({
              conversationId,
              planId: options.planId,
              userText: prompt ?? '',
              selection,
              expectedRevisionId: options.expectedRevisionId,
            })
          : await runtime.send({
              conversationId,
              userText: prompt ?? '',
              selection,
              mode: options.mode,
              ...(options.planId ? { planId: options.planId } : {}),
            })
    const { assistantMessageId } = result
    process.on('SIGINT', () => {
      runtime.abort(conversationId)
      stderr.write(`Aborted conversation ${conversationId}, message ${assistantMessageId}\n`)
    })
    await completionWait
  } finally {
    await runtime.abortAll()
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
          model: selection,
          mode: options.mode,
          planId: options.planId ?? null,
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

async function waitForRunIdle(runtime: AgentRuntimeApi, runId: string): Promise<void> {
  while (runtime.listActiveTurns().some((turn) => turn.runId === runId)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`Aila CLI failed: ${message}\n\n${usage()}\n`)
    process.exitCode = 1
  })
}
