import { randomUUID } from 'node:crypto'
import {
  type AilaExecutionMode,
  type ConversationSummary,
  isAilaExecutionMode,
  MODEL_CATALOG,
  type ModelSelection,
  providerLabel,
  type ToolApprovalMode,
  type ToolApprovalRequest,
  type Workbench,
  type WorkbenchEvent,
} from '@aila/agent'
import {
  configureDataDir,
  getDataDir,
  getExtensionReport,
  getToolPacksDir,
} from '@aila/agent-node/app'
import * as dotenv from 'dotenv'
import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  type SelectItem,
  TUI,
} from './aila-tui'
import {
  AilaFrameComponent,
  type AilaFrameState,
  ApprovalDialog,
  PickerDialog,
  showPanelOverlay,
  type TranscriptEntry,
} from './components'
import {
  appendLocalContext,
  blockPreview,
  commandHelp,
  createTuiRuntime,
  defaultDataDir,
  displayPreview,
  formatDate,
  formatToolResultForDisplay,
  modelLabel,
  parseArgs,
  parseModel,
  printConversationList,
  readShellToken,
  resolveSelection,
  splitShellWords,
  waitForManagedRun,
  workspacePath,
} from './line-mode'
import { createEditorTheme } from './theme'

dotenv.config()

type SlashResult = 'agent' | 'exit' | 'handled'

interface SessionState {
  selection: ModelSelection
  mode: AilaExecutionMode
}

function entry(kind: TranscriptEntry['kind'], title: string, body = ''): TranscriptEntry {
  return { id: randomUUID(), kind, title, body }
}

function extensionReportText(report: Awaited<ReturnType<typeof getExtensionReport>>): string {
  const lines = [`Data: ${report.dataDir}`]
  lines.push('', `Tool packs: ${report.toolPacksDir}`)
  const toolPackError = report.errors.find((error) => error.kind === 'toolPacks')
  if (toolPackError) {
    lines.push(`  [error] ${toolPackError.message}`)
  } else if (report.toolPacks.length === 0) {
    lines.push('  (none)')
  } else {
    for (const pack of report.toolPacks) {
      const names = pack.tools.join(', ')
      lines.push(`  ${pack.id} - ${pack.tools.length} tools${names ? `: ${names}` : ''}`)
    }
  }

  lines.push('', `Skills: ${report.skillsDir}`)
  const skillErrors = report.errors.filter((error) => error.kind === 'skills')
  for (const skillError of skillErrors) {
    lines.push(`  [error] ${skillError.message}`)
  }
  if (report.skills.length === 0) {
    if (skillErrors.length === 0) lines.push('  (none)')
  } else {
    for (const skill of report.skills) {
      lines.push(`  ${skill.name} - ${skill.description}`)
    }
  }

  return lines.join('\n')
}

function conversationText(summary: ConversationSummary): string {
  const usage = summary.usage ? `, ${summary.usage.totalTokens} tokens` : ''
  return `${formatDate(summary.updatedAt)}  ${summary.id}  thread  ${summary.title}${usage}`
}

export async function runFullScreenTui(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  configureDataDir(options.dataDir ?? defaultDataDir())

  if (options.list) {
    await printConversationList(createTuiRuntime({ approvalMode: options.approvalMode }), {
      limit: options.limit,
    })
    return
  }

  const session: SessionState = {
    selection: resolveSelection(options.model),
    mode: options.mode,
  }

  const app = new AilaFullScreenApp({
    approvalMode: options.approvalMode,
    retryLast: options.retryLast,
    session,
    showHistory: options.showHistory,
  })
  await app.initializeConversation({
    conversationId: options.conversationId,
    resumeLatest: options.resumeLatest,
  })
  await app.run()
}

class AilaFullScreenApp {
  private readonly terminal = new ProcessTerminal()
  private readonly ui = new TUI(this.terminal, true)
  private readonly editor = new Editor(this.ui, createEditorTheme(), {
    autocompleteMaxVisible: 8,
    paddingX: 2,
  })
  private readonly runtime: Workbench
  private readonly frame: AilaFrameComponent
  private readonly completions = new Map<string, () => void>()
  private readonly toolNames = new Map<string, string>()
  private readonly toolArgs = new Map<string, string>()
  private readonly entries: TranscriptEntry[] = []
  private readonly queue: string[] = []
  private activeConversationId: string | null = null
  private conversationId: string
  private lastIdleCtrlC = 0
  private running = false
  private stopped = false
  private resolveStopped: (() => void) | null = null
  private session: SessionState
  private state: AilaFrameState

  constructor(input: {
    approvalMode: ToolApprovalMode
    retryLast: boolean
    session: SessionState
    showHistory: boolean
  }) {
    this.conversationId = ''
    this.session = input.session
    this.state = {
      active: false,
      conversationId: '',
      dataDir: getDataDir(),
      queueCount: 0,
      selection: input.session.selection,
      status: 'initializing conversation',
    }
    this.frame = new AilaFrameComponent(this.terminal, this.editor, this.state)
    this.runtime = createTuiRuntime({
      approvalMode: input.approvalMode,
      onEvent: (event) => this.handleRuntimeEvent(event),
      onToolApproval: (request) => this.askToolApproval(request),
    })

    this.editor.onSubmit = (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      this.editor.addToHistory(trimmed)
      void this.submit(trimmed)
    }
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(slashCommands(), process.cwd()),
    )

    this.ui.addChild(this.frame)
    this.ui.setFocus(this.editor)
    this.ui.addInputListener((data) => this.handleGlobalInput(data))
    this.retryLastOnStart = input.retryLast
    this.showHistoryOnStart = input.showHistory
  }

  private readonly retryLastOnStart: boolean
  private readonly showHistoryOnStart: boolean

  async initializeConversation(input: {
    conversationId?: string
    resumeLatest?: boolean
  }): Promise<void> {
    const resolved = await this.runtime.resolveConversation({
      conversationId: input.conversationId,
      resumeLatest: input.resumeLatest,
    })
    this.conversationId = resolved.conversationId
    this.setState({
      conversationId: resolved.conversationId,
      status: resolved.isExisting ? 'resumed conversation' : 'new conversation',
    })
    this.addEntry(
      'system',
      'runtime',
      [
        `Data: ${getDataDir()}`,
        `Tool packs: ${getToolPacksDir()}`,
        `Conversation: ${resolved.conversationId}${resolved.isExisting ? ' (resumed)' : ''}`,
        `Model: ${modelLabel(this.session.selection)}`,
        `Runtime mode: ${this.session.mode}`,
      ].join('\n'),
    )

    if (this.showHistoryOnStart) await this.loadHistory()
  }

  async run(): Promise<void> {
    this.terminal.setTitle('Aila TUI')
    this.frame.setEntries(this.entries)
    this.ui.start()
    this.ui.requestRender(true)
    if (this.retryLastOnStart) {
      queueMicrotask(() => {
        void this.submit('/retry')
      })
    }
    await new Promise<void>((resolve) => {
      this.resolveStopped = resolve
    })
  }

  private async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.runtime.abortAll()
    this.terminal.setProgress(false)
    this.ui.stop()
    await this.terminal.drainInput(250, 25).catch(() => {})
    this.resolveStopped?.()
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (matchesKey(data, Key.ctrl('l'))) {
      this.ui.requestRender(true)
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      void this.handleCtrlC()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (this.activeConversationId) {
        this.runtime.abort(this.activeConversationId)
        this.setState({ status: 'aborting active response' })
      } else {
        void this.stop()
      }
      return { consume: true }
    }
    return undefined
  }

  private async handleCtrlC(): Promise<void> {
    if (this.activeConversationId) {
      this.runtime.abort(this.activeConversationId)
      this.setState({ status: 'aborting active response' })
      return
    }

    if (this.queue.length > 0) {
      this.queue.length = 0
      this.setState({ queueCount: 0, status: 'cleared queued prompts' })
      return
    }

    const now = Date.now()
    if (now - this.lastIdleCtrlC < 1500) {
      await this.stop()
      return
    }
    this.lastIdleCtrlC = now
    this.setState({ status: 'press Ctrl+C again to exit' })
  }

  private async submit(text: string): Promise<void> {
    if (this.running) {
      if (text === '/abort') {
        if (this.activeConversationId) this.runtime.abort(this.activeConversationId)
        this.setState({ status: 'aborting active response' })
        return
      }
      if (text === '/exit' || text === '/quit') {
        await this.stop()
        return
      }
      this.queue.push(text)
      this.addEntry('system', 'queued', text)
      this.setState({ queueCount: this.queue.length, status: 'prompt queued' })
      return
    }

    this.running = true
    try {
      let next: string | undefined = text
      while (next !== undefined) {
        this.setState({ queueCount: this.queue.length })
        await this.processInput(next)
        next = this.queue.shift()
      }
    } finally {
      this.running = false
      this.setState({ active: false, queueCount: 0 })
    }
  }

  private async processInput(text: string): Promise<void> {
    if (text === '/retry' || text === '/continue') {
      await this.retryLastTurn()
      return
    }
    const command = await this.handleSlashCommand(text)
    if (command === 'exit') {
      await this.stop()
      return
    }
    if (command === 'handled') return

    await this.sendAgentPrompt(text)
  }

  private async sendAgentPrompt(
    text: string,
    input: { mode?: AilaExecutionMode } = {},
  ): Promise<void> {
    this.addEntry('user', 'message', text)
    this.setState({ active: true, status: 'sending prompt' })
    const mode = input.mode ?? this.session.mode
    const { assistantMessageId } = await this.runtime.send({
      conversationId: this.conversationId,
      mode,
      selection: this.session.selection,
      userText: text,
    })
    this.activeConversationId = this.conversationId
    this.terminal.setProgress(true)
    try {
      await new Promise<void>((resolve) => this.completions.set(assistantMessageId, resolve))
    } finally {
      this.completions.delete(assistantMessageId)
      this.activeConversationId = null
      this.terminal.setProgress(false)
    }
  }

  private async retryLastTurn(): Promise<void> {
    this.setState({ active: true, status: 'retrying last user turn' })
    try {
      const { assistantMessageId } = await this.runtime.retryLastUserMessage({
        conversationId: this.conversationId,
        mode: this.session.mode,
        selection: this.session.selection,
      })
      this.activeConversationId = this.conversationId
      this.terminal.setProgress(true)
      await new Promise<void>((resolve) => this.completions.set(assistantMessageId, resolve))
      this.completions.delete(assistantMessageId)
    } catch (error) {
      this.addEntry('error', 'retry failed', error instanceof Error ? error.message : String(error))
    } finally {
      this.activeConversationId = null
      this.terminal.setProgress(false)
    }
  }

  private async handleSlashCommand(text: string): Promise<SlashResult> {
    if (!text.startsWith('/')) return 'agent'

    const commandText = text.slice(1).trim()
    const command = readShellToken(commandText)
    const name = command?.token.toLowerCase() ?? ''
    const rest = command?.rest ?? ''

    try {
      switch (name) {
        case 'help':
          showPanelOverlay(this.ui, 'Aila commands', commandHelp())
          return 'handled'
        case 'exit':
        case 'quit':
          return 'exit'
        case 'abort':
          if (this.activeConversationId) this.runtime.abort(this.activeConversationId)
          this.setState({ status: 'aborting active response' })
          return 'handled'
        case 'runs':
          await this.showRuns()
          return 'handled'
        case 'inspect-run':
        case 'step-run':
        case 'continue-run':
        case 'resume-run':
        case 'abort-run':
        case 'fork-run':
          await this.manageRun(name, rest)
          return 'handled'
        case 'extensions':
          await this.handleExtensions(rest)
          return 'handled'
        case 'reload':
        case 'refresh':
          await this.reloadExtensions()
          return 'handled'
        case 'model':
          await this.handleModel(rest)
          return 'handled'
        case 'mode':
          this.handleMode(rest)
          return 'handled'
        case 'sessions':
        case 'session':
          await this.showSessionPicker()
          return 'handled'
        case 'read':
          await this.readFile(rest)
          return 'handled'
        case 'run':
          await this.runShell(rest)
          return 'handled'
        case 'write':
          await this.writeFile(rest)
          return 'handled'
        case 'edit':
          await this.editFile(rest)
          return 'handled'
        default:
          this.addEntry('error', `unknown command: /${name || ''}`, 'Type /help for commands.')
          return 'handled'
      }
    } catch (error) {
      this.addEntry(
        'error',
        `command failed: /${name || ''}`,
        error instanceof Error ? error.message : String(error),
      )
      return 'handled'
    }
  }

  private async showRuns(): Promise<void> {
    const runs = await this.runtime.listRunCheckpoints(this.conversationId)
    const body =
      runs.length === 0
        ? 'No persisted agent runs.'
        : runs
            .map(
              (run) =>
                `${run.identity.runId}  ${run.loop.state.status}  next=${run.loop.state.nextAction?.type ?? 'none'}  r${run.revision}`,
            )
            .join('\n')
    this.addEntry('system', 'agent runs', body)
    showPanelOverlay(this.ui, 'Agent runs', body)
  }

  private async manageRun(name: string, rest: string): Promise<void> {
    const [runId] = splitShellWords(rest)
    if (!runId) throw new Error(`usage: /${name} <id>`)
    const target = { conversationId: this.conversationId, runId }
    this.setState({ active: true, status: `${name}: ${runId}` })
    this.terminal.setProgress(true)
    try {
      if (name === 'step-run') {
        await this.runtime.stepRun(target)
        await waitForManagedRun(this.runtime, runId)
      } else if (name === 'continue-run') {
        await this.runtime.continueRun(target)
        await waitForManagedRun(this.runtime, runId)
      } else if (name === 'resume-run') {
        await this.runtime.resumeRun(target)
        await waitForManagedRun(this.runtime, runId)
      } else if (name === 'abort-run') {
        await this.runtime.abortRun(target)
      } else if (name === 'fork-run') {
        const forked = await this.runtime.forkRun(target)
        this.addEntry('system', 'run forked', forked.identity.runId)
        return
      }
      const inspection = await this.runtime.inspectRun(target)
      const checkpoint = inspection.checkpoint
      const body = [
        `status: ${checkpoint.loop.state.status}`,
        `next: ${checkpoint.loop.state.nextAction?.type ?? 'none'}`,
        `steps: ${checkpoint.loop.state.steps.length}`,
        `events: ${inspection.events.length}`,
        `artifacts: ${inspection.artifacts.length}`,
        `recovery: ${checkpoint.recovery.strategy}`,
      ].join('\n')
      this.addEntry('system', `run ${runId}`, body)
      showPanelOverlay(this.ui, `Run ${runId}`, body)
    } finally {
      this.terminal.setProgress(false)
      this.setState({ active: false, status: 'ready' })
    }
  }

  private async handleExtensions(rest: string): Promise<void> {
    const [action] = splitShellWords(rest)
    if (action && !['reload', 'refresh'].includes(action.toLowerCase())) {
      throw new Error('usage: /extensions [reload]')
    }
    if (action) await this.reloadExtensions()
    const report = await getExtensionReport()
    const body = extensionReportText(report)
    this.addEntry('local', 'extensions', body)
    showPanelOverlay(this.ui, 'Aila extensions', body)
  }

  private async reloadExtensions(): Promise<void> {
    const registry = await this.runtime.reloadToolPacks()
    const message = `reloaded ${registry.toolPacks.length} tool packs, ${registry.specs.length} tools`
    this.addEntry('system', 'extensions reloaded', message)
    this.setState({ status: message })
  }

  private async handleModel(rest: string): Promise<void> {
    const words = splitShellWords(rest)
    if (words.length === 0) {
      this.showModelPicker()
      return
    }
    if (words.length > 1) throw new Error('usage: /model [provider:modelId]')
    this.setModel(parseModel(words[0]))
  }

  private showModelPicker(): void {
    let handle: OverlayHandle | null = null
    const items: SelectItem[] = MODEL_CATALOG.map((model) => ({
      description: `${model.providerId}${model.tags?.length ? ` - ${model.tags.join(', ')}` : ''}`,
      label: `${providerLabel(model.providerId)} / ${model.displayName}`,
      value: `${model.providerId}:${model.modelId}`,
    }))
    const picker = new PickerDialog(
      'Models',
      items,
      (item) => {
        handle?.hide()
        this.setModel(parseModel(item.value))
        this.ui.setFocus(this.editor)
      },
      () => {
        handle?.hide()
        this.ui.setFocus(this.editor)
      },
    )
    handle = this.ui.showOverlay(picker, {
      width: '80%',
      minWidth: 60,
      maxHeight: '80%',
      margin: 1,
    })
  }

  private setModel(selection: ModelSelection): void {
    this.session = { ...this.session, selection }
    this.addEntry('system', 'model changed', modelLabel(selection))
    this.setState({ selection, status: `model: ${modelLabel(selection)}` })
  }

  private handleMode(rest: string): void {
    const words = splitShellWords(rest)
    if (words.length === 0) {
      this.addEntry('system', 'runtime mode', this.session.mode)
      return
    }
    if (words.length > 1) throw new Error('usage: /mode [agent|chat]')
    this.setMode(parseExecutionMode(words[0]))
  }

  private setMode(mode: AilaExecutionMode): void {
    this.session = { ...this.session, mode }
    this.addEntry('system', 'runtime mode changed', mode)
    this.setState({ status: `mode: ${mode}` })
  }

  private async showSessionPicker(): Promise<void> {
    const conversations = await this.runtime.listConversations()
    if (conversations.length === 0) {
      this.addEntry('system', 'sessions', 'No conversations found.')
      return
    }
    let handle: OverlayHandle | null = null
    const picker = new PickerDialog(
      'Sessions',
      conversations.slice(0, 80).map((summary) => ({
        description: conversationText(summary),
        label: summary.title || summary.id,
        value: summary.id,
      })),
      (item) => {
        handle?.hide()
        void this.switchConversation(item.value)
        this.ui.setFocus(this.editor)
      },
      () => {
        handle?.hide()
        this.ui.setFocus(this.editor)
      },
    )
    handle = this.ui.showOverlay(picker, {
      width: '88%',
      minWidth: 70,
      maxHeight: '82%',
      margin: 1,
    })
  }

  private async switchConversation(conversationId: string): Promise<void> {
    await this.runtime.getConversation(conversationId)
    this.conversationId = conversationId
    this.entries.length = 0
    this.addEntry('system', 'conversation switched', conversationId)
    await this.loadHistory(12)
    this.setState({
      conversationId,
      status: `conversation: ${conversationId}`,
    })
  }

  private async readFile(rest: string): Promise<void> {
    const [pathArg] = splitShellWords(rest)
    if (!pathArg) throw new Error('usage: /read <path>')
    const path = workspacePath(pathArg)
    const result = await this.runLocalTool('read', { path })
    this.addEntry('local', `[read] ${path}`, displayPreview(result))
    await appendLocalContext({
      command: `/read ${path}`,
      conversationId: this.conversationId,
      result,
      runtime: this.runtime,
    })
  }

  private async runShell(rest: string): Promise<void> {
    if (!rest) throw new Error('usage: /run <command>')
    const result = await this.runLocalTool('bash', { command: rest })
    const display = formatToolResultForDisplay('bash', result)
    this.addEntry('local', `[run] ${rest}`, displayPreview(display))
    await appendLocalContext({
      command: `/run ${rest}`,
      conversationId: this.conversationId,
      result: display,
      runtime: this.runtime,
    })
  }

  private async writeFile(rest: string): Promise<void> {
    const parsed = readShellToken(rest)
    if (!parsed?.rest) throw new Error('usage: /write <path> <content>')
    const path = workspacePath(parsed.token)
    const result = await this.runLocalTool('write', { content: parsed.rest, path })
    this.addEntry('local', `[write] ${path}`, displayPreview(result))
    await appendLocalContext({
      command: `/write ${path}`,
      conversationId: this.conversationId,
      result,
      runtime: this.runtime,
    })
  }

  private async editFile(rest: string): Promise<void> {
    const parsed = readShellToken(rest)
    if (!parsed?.rest.includes('=>')) throw new Error('usage: /edit <path> <old> => <new>')
    const [oldText, ...newParts] = parsed.rest.split('=>')
    const newText = newParts.join('=>')
    if (!oldText || newParts.length === 0) throw new Error('usage: /edit <path> <old> => <new>')
    const path = workspacePath(parsed.token)
    const result = await this.runLocalTool('edit', {
      newText: newText.trim(),
      oldText: oldText.trim(),
      path,
    })
    this.addEntry('local', `[edit] ${path}`, displayPreview(result))
    await appendLocalContext({
      command: `/edit ${path}`,
      conversationId: this.conversationId,
      result,
      runtime: this.runtime,
    })
  }

  private async runLocalTool(
    toolName: 'bash' | 'edit' | 'read' | 'write',
    args: Record<string, unknown>,
  ): Promise<string> {
    this.setState({ active: true, status: `running /${toolName}` })
    return this.runtime.executeTool({
      name: toolName,
      args,
    })
  }

  private askToolApproval(request: ToolApprovalRequest): Promise<boolean> {
    this.setState({ status: `approval required: ${request.name}` })
    return new Promise((resolve) => {
      let handle: OverlayHandle | null = null
      const dialog = new ApprovalDialog(request, (approved) => {
        handle?.hide()
        this.ui.setFocus(this.editor)
        this.addEntry(
          'system',
          approved ? 'tool approved' : 'tool denied',
          `${request.name}: ${JSON.stringify(request.args)}`,
        )
        this.setState({ status: approved ? 'tool approved' : 'tool denied' })
        resolve(approved)
      })
      handle = this.ui.showOverlay(dialog, {
        width: '76%',
        minWidth: 54,
        maxHeight: '76%',
        margin: 1,
      })
    })
  }

  private handleRuntimeEvent(event: WorkbenchEvent): void {
    switch (event.type) {
      case 'chat:text-delta':
        this.appendAssistantDelta(event.data.messageId, event.data.delta)
        this.setState({ active: true, status: 'receiving response' })
        break
      case 'chat:reasoning-delta':
        this.setState({ active: true, status: 'thinking' })
        break
      case 'chat:tool-call-start':
        this.toolNames.set(event.data.toolCallId, event.data.name)
        this.toolArgs.set(event.data.toolCallId, event.data.arguments)
        this.upsertEntry(
          `tool:${event.data.toolCallId}`,
          'tool',
          event.data.name,
          displayPreview(event.data.arguments, 2000),
        )
        this.setState({ active: true, status: `tool: ${event.data.name}` })
        break
      case 'chat:tool-call-args-delta': {
        const next = `${this.toolArgs.get(event.data.toolCallId) ?? ''}${event.data.delta}`
        this.toolArgs.set(event.data.toolCallId, next)
        const name = this.toolNames.get(event.data.toolCallId) ?? event.data.toolCallId
        this.upsertEntry(`tool:${event.data.toolCallId}`, 'tool', name, displayPreview(next, 2000))
        break
      }
      case 'chat:tool-call-result': {
        const name = this.toolNames.get(event.data.toolCallId) ?? event.data.toolCallId
        const status = event.data.isError ? 'error' : 'done'
        this.upsertEntry(
          `tool:${event.data.toolCallId}`,
          event.data.isError ? 'error' : 'tool',
          `${name} (${status})`,
          displayPreview(formatToolResultForDisplay(name, event.data.result), 3000),
        )
        this.setState({ active: true, status: `tool ${status}: ${name}` })
        break
      }
      case 'chat:image-block':
        this.addEntry('image', 'image block', event.data.block.url)
        break
      case 'chat:done':
        this.setState({ active: false, status: 'done', usage: event.data.usage })
        this.completions.get(event.data.messageId)?.()
        break
      case 'chat:error':
        this.addEntry('error', 'agent error', event.data.error)
        this.setState({ active: false, status: 'error' })
        this.completions.get(event.data.messageId)?.()
        break
      case 'run:event':
        if (event.data.type === 'run.paused') {
          const nextAction = event.data.data?.nextAction
          const nextType =
            nextAction && typeof nextAction === 'object' && 'type' in nextAction
              ? String(nextAction.type)
              : 'unknown'
          this.addEntry('system', 'run paused', `next=${nextType}`)
          this.setState({ active: false, status: `paused: ${nextType}` })
          this.completions.get(event.data.messageId)?.()
        } else if (event.data.type === 'turn.interrupted') {
          const reason =
            typeof event.data.data?.reason === 'string' && event.data.data.reason.length > 0
              ? event.data.data.reason
              : 'Interrupted'
          this.addEntry('error', 'interrupted', reason)
          this.setState({ active: false, status: 'interrupted' })
          this.completions.get(event.data.messageId)?.()
        }
        break
      case 'conversations:updated':
        break
    }
    this.requestRender()
  }

  private appendAssistantDelta(messageId: string, delta: string): void {
    const id = `assistant:${messageId}`
    const current = this.entries.find((item) => item.id === id)
    if (current) {
      current.body += delta
      return
    }
    this.entries.push({ body: delta, id, kind: 'assistant', title: 'response' })
  }

  private upsertEntry(
    id: string,
    kind: TranscriptEntry['kind'],
    title: string,
    body: string,
  ): void {
    const current = this.entries.find((item) => item.id === id)
    if (current) {
      current.kind = kind
      current.title = title
      current.body = body
      return
    }
    this.entries.push({ body, id, kind, title })
  }

  private addEntry(kind: TranscriptEntry['kind'], title: string, body = ''): void {
    this.entries.push(entry(kind, title, body))
    this.requestRender()
  }

  private setState(patch: Partial<AilaFrameState>): void {
    this.state = { ...this.state, ...patch }
    this.frame.setState(this.state)
    this.requestRender()
  }

  private requestRender(): void {
    this.frame.setEntries(this.entries)
    this.ui.requestRender()
  }

  private async loadHistory(maxMessages = 8): Promise<void> {
    const record = await this.runtime.getConversation(this.conversationId)
    if (record.messages.length === 0) return
    for (const message of record.messages.slice(-maxMessages)) {
      const status = message.status === 'done' ? '' : ` (${message.status})`
      this.addEntry(
        message.role === 'assistant' ? 'assistant' : 'user',
        `${message.role}${status}`,
        blockPreview(message),
      )
    }
    const last = record.messages.at(-1)
    if (last?.role === 'user') {
      this.addEntry(
        'system',
        'resume',
        'Last user message has no persisted assistant response yet.',
      )
    }
  }
}

function slashCommands() {
  return [
    { name: 'help', description: 'Show commands' },
    { name: 'exit', description: 'Quit Aila TUI' },
    { name: 'abort', description: 'Abort active response' },
    { name: 'retry', description: 'Retry a dangling user turn' },
    { name: 'sessions', description: 'Open saved conversation picker' },
    { name: 'extensions', description: 'Show extension manifests', argumentHint: '[reload]' },
    { name: 'model', description: 'Show or switch model', argumentHint: '[provider:model]' },
    { name: 'mode', description: 'Show or switch runtime mode', argumentHint: '[agent|chat]' },
    { name: 'read', description: 'Read file into context', argumentHint: '<path>' },
    { name: 'run', description: 'Run shell command', argumentHint: '<command>' },
    { name: 'write', description: 'Write file', argumentHint: '<path> <content>' },
    { name: 'edit', description: 'Edit file', argumentHint: '<path> <old> => <new>' },
  ]
}

function parseExecutionMode(value: string): AilaExecutionMode {
  if (isAilaExecutionMode(value)) return value
  throw new Error('mode must be agent, plan, or chat')
}
