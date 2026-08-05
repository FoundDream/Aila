import { randomUUID } from 'node:crypto'
import {
  type ConversationSummary,
  MODEL_CATALOG,
  type ModelSelection,
  type PersistedMessage,
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
  loadSettings,
  resolveApiKey,
  saveSettings,
} from '@aila/agent-node/app'
import * as dotenv from 'dotenv'
import {
  CombinedAutocompleteProvider,
  Editor,
  isKeyRelease,
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
  commandHelp,
  createTuiRuntime,
  defaultDataDir,
  formatDate,
  formatToolResultForDisplay,
  modelLabel,
  parseArgs,
  parseModel,
  printConversationList,
  readShellToken,
  resolveSelectionOrNull,
  splitShellWords,
  waitForManagedRun,
  workspacePath,
} from './line-mode'
import { ModelSetupComponent, type ModelSetupResult } from './model-setup'
import { createEditorTheme } from './theme'

dotenv.config()

type SlashResult = 'agent' | 'exit' | 'handled'

interface SessionState {
  selection: ModelSelection | null
}

function entry(kind: TranscriptEntry['kind'], title: string, body = ''): TranscriptEntry {
  return { id: randomUUID(), kind, title, body }
}

function persistedMessageBody(message: PersistedMessage): string {
  const blocks = message.blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.content
        case 'reasoning':
          return `[reasoning]\n${block.content}`
        case 'tool_call':
          return `[tool · ${block.status}] ${block.name}`
        case 'image':
          return `[image] ${block.url}`
      }
      return ''
    })
    .filter((block): block is string => Boolean(block))
  return blocks.join('\n\n') || '[empty message]'
}

function extensionReportText(report: Awaited<ReturnType<typeof getExtensionReport>>): string {
  const lines = [`Data: ${report.dataDir}`]
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
  const usage = summary.usage ? ` · ${summary.usage.totalTokens} tokens` : ''
  return `${formatDate(summary.updatedAt)} · #${summary.id.slice(0, 8)}${usage}`
}

export async function runFullScreenTui(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  configureDataDir(options.dataDir ?? defaultDataDir())
  const approvalMode = options.approvalMode ?? loadSettings().approvalMode ?? 'safe'

  if (options.list) {
    await printConversationList(createTuiRuntime({ approvalMode }), {
      limit: options.limit,
    })
    return
  }

  const session: SessionState = {
    selection: resolveSelectionOrNull(options.model),
  }

  const app = new AilaFullScreenApp({
    approvalMode,
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
  private readonly ui = new TUI(this.terminal)
  private readonly editor = new Editor(this.ui, createEditorTheme(), {
    autocompleteMaxVisible: 6,
    paddingX: 2,
  })
  private readonly runtime: Workbench
  private readonly frame: AilaFrameComponent
  private readonly completions = new Map<string, () => void>()
  private readonly toolNames = new Map<string, string>()
  private readonly toolArgs = new Map<string, string>()
  private readonly entries: TranscriptEntry[] = []
  private readonly queue: string[] = []
  private readonly streamSegmentCounts = new Map<string, number>()
  private readonly streamSegments = new Map<
    string,
    { id: string; kind: 'assistant' | 'reasoning' }
  >()
  private activeConversationId: string | null = null
  private approvalMode: ToolApprovalMode
  private configurationPromise: Promise<boolean> | null = null
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
    this.approvalMode = input.approvalMode
    this.conversationId = ''
    this.session = input.session
    this.state = {
      active: false,
      approvalMode: input.approvalMode,
      conversationId: '',
      dataDir: getDataDir(),
      queueCount: 0,
      selection: input.session.selection,
      status: 'initializing conversation',
    }
    this.frame = new AilaFrameComponent(this.editor, this.state)
    this.runtime = createTuiRuntime({
      getApprovalMode: () => this.approvalMode,
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
    const needsSetup =
      !this.session.selection || !resolveApiKey(this.session.selection.providerId, loadSettings())
    this.addEntry(
      'welcome',
      resolved.isExisting ? 'Welcome back' : 'Welcome to Aila',
      this.welcomeBody(resolved.isExisting),
    )
    if (needsSetup) {
      this.setState({ status: 'ready · /setup connects a model' })
    }

    if (this.showHistoryOnStart) await this.loadHistory()
  }

  async run(): Promise<void> {
    this.terminal.setTitle('Aila TUI')
    this.frame.setEntries(this.entries)
    this.ui.start()
    this.ui.requestRender()
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
    await this.terminal.drainInput(250, 25).catch(() => {})
    this.ui.stop()
    this.resolveStopped?.()
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (isKeyRelease(data)) return { consume: true }
    if (matchesKey(data, Key.ctrl('l'))) {
      this.ui.requestRender(true)
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (this.configurationPromise) return undefined
      if (this.ui.hasOverlay()) return undefined
      void this.handleCtrlC()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (this.configurationPromise) return undefined
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

  private async sendAgentPrompt(text: string): Promise<void> {
    if (!(await this.ensureModelConfigured()) || !this.session.selection) {
      this.addEntry('system', 'setup required', 'Configure a model and API key to send messages.')
      this.setState({ status: 'model setup required' })
      return
    }
    this.addEntry('user', '', text)
    this.setState({ active: true, status: 'sending prompt' })
    const { assistantMessageId } = await this.runtime.send({
      conversationId: this.conversationId,
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
    if (!(await this.ensureModelConfigured()) || !this.session.selection) {
      this.addEntry('system', 'setup required', 'Configure a model and API key to retry.')
      this.setState({ status: 'model setup required' })
      return
    }
    this.setState({ active: true, status: 'retrying last user turn' })
    try {
      const { assistantMessageId } = await this.runtime.retryLastUserMessage({
        conversationId: this.conversationId,
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
        case 'retry':
          await this.retryLastTurn()
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
        case 'setup':
          await this.startModelSetup(null)
          return 'handled'
        case 'approval':
        case 'safe':
        case 'yolo':
          this.handleApprovalMode(name, rest)
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
    const runs = await this.runtime.listRunSnapshots(this.conversationId)
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
      const snapshot = inspection.snapshot
      const body = [
        `status: ${snapshot.loop.state.status}`,
        `next: ${snapshot.loop.state.nextAction?.type ?? 'none'}`,
        `steps: ${snapshot.loop.state.steps.length}`,
        `events: ${inspection.events.length}`,
        `payloads: ${inspection.payloads.length}`,
        `recovery: ${snapshot.recovery.strategy}`,
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
    const registry = await this.runtime.reloadTools()
    const message = `reloaded extensions, ${registry.specs.length} tools available`
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
    await this.setModel(parseModel(words[0]))
  }

  private showModelPicker(): void {
    let handle: OverlayHandle | null = null
    const items: SelectItem[] = MODEL_CATALOG.map((model) => ({
      description: [
        providerLabel(model.providerId),
        ...(model.tags ?? []),
        ...(this.session.selection?.providerId === model.providerId &&
        this.session.selection.modelId === model.modelId
          ? ['current']
          : []),
      ].join(' · '),
      label: model.displayName,
      value: `${model.providerId}:${model.modelId}`,
    }))
    const picker = new PickerDialog(
      'Select a model',
      items,
      (item) => {
        handle?.hide()
        void this.setModel(parseModel(item.value))
      },
      () => {
        handle?.hide()
        this.ui.setFocus(this.editor)
      },
      this.session.selection
        ? `${this.session.selection.providerId}:${this.session.selection.modelId}`
        : undefined,
    )
    handle = this.ui.showOverlay(picker, {
      width: '80%',
      minWidth: 60,
      maxHeight: '80%',
      margin: 1,
    })
  }

  private async setModel(selection: ModelSelection): Promise<void> {
    const settings = loadSettings()
    if (!resolveApiKey(selection.providerId, settings)) {
      this.setState({ status: `connect ${providerLabel(selection.providerId)} to use this model` })
      await this.startModelSetup(selection)
      return
    }
    settings.defaultModel = selection
    saveSettings(settings)
    this.session = { ...this.session, selection }
    this.refreshWelcome()
    this.addEntry('system', 'model changed', modelLabel(selection))
    this.setState({ selection, status: `model: ${modelLabel(selection)}` })
    this.ui.setFocus(this.editor)
  }

  private ensureModelConfigured(): Promise<boolean> {
    if (this.configurationPromise) return this.configurationPromise

    const selection = this.session.selection
    if (selection && resolveApiKey(selection.providerId, loadSettings())) {
      return Promise.resolve(true)
    }

    return this.startModelSetup(selection)
  }

  private startModelSetup(initialSelection: ModelSelection | null): Promise<boolean> {
    if (this.configurationPromise) return this.configurationPromise
    this.configurationPromise = this.runModelSetup(initialSelection).finally(() => {
      this.configurationPromise = null
    })
    return this.configurationPromise
  }

  private runModelSetup(initialSelection: ModelSelection | null): Promise<boolean> {
    const settings = loadSettings()
    this.setState({ status: 'model setup' })
    return new Promise((resolve) => {
      const finish = (configured: boolean) => {
        this.frame.setInputComponent(this.editor)
        this.ui.setFocus(this.editor)
        this.setState({ inputHint: undefined })
        this.requestRender()
        resolve(configured)
      }
      const setup = new ModelSetupComponent({
        initialSelection,
        providerHasApiKey: (providerId) => Boolean(resolveApiKey(providerId, settings)),
        onCancel: () => {
          this.setState({ status: 'setup cancelled · run /setup when ready' })
          finish(false)
        },
        onDone: (result) => {
          this.completeModelSetup(settings, result)
          finish(true)
        },
      })
      this.frame.setInputComponent(setup)
      this.ui.setFocus(setup)
      this.setState({ inputHint: 'Setup stays local · follow the step hints above' })
      this.requestRender()
    })
  }

  private completeModelSetup(
    settings: ReturnType<typeof loadSettings>,
    result: ModelSetupResult,
  ): void {
    if (result.apiKey) {
      settings.apiKeys = {
        ...settings.apiKeys,
        [result.selection.providerId]: result.apiKey,
      }
    }
    settings.defaultModel = result.selection
    saveSettings(settings)
    this.session = { ...this.session, selection: result.selection }
    this.refreshWelcome()
    this.addEntry(
      'system',
      'model connected',
      `${modelLabel(result.selection)} is ready. Credentials and defaults were saved in the active Aila data directory.`,
    )
    this.setState({
      selection: result.selection,
      status: `ready · ${modelLabel(result.selection)}`,
    })
  }

  private handleApprovalMode(name: string, rest: string): void {
    const words = splitShellWords(rest)
    const requested = name === 'approval' ? words[0] : name
    if (!requested) {
      this.addEntry('system', 'approval mode', this.approvalMode)
      this.setState({ status: `approval: ${this.approvalMode}` })
      return
    }
    if (
      words.length > (name === 'approval' ? 1 : 0) ||
      (requested !== 'safe' && requested !== 'yolo')
    ) {
      throw new Error('usage: /approval [safe|yolo]')
    }

    this.approvalMode = requested
    const settings = loadSettings()
    settings.approvalMode = requested
    saveSettings(settings)
    this.addEntry(
      'system',
      `approval mode: ${requested}`,
      requested === 'yolo'
        ? 'Future tool calls run without confirmation.'
        : 'Risky tool calls require confirmation.',
    )
    this.setState({
      approvalMode: requested,
      status:
        requested === 'yolo'
          ? 'YOLO enabled · tools run without confirmation'
          : 'safe mode · risky tools require confirmation',
    })
  }

  private async showSessionPicker(): Promise<void> {
    const conversations = await this.runtime.listConversations()
    if (conversations.length === 0) {
      this.addEntry('system', 'sessions', 'No conversations found.')
      return
    }
    let handle: OverlayHandle | null = null
    const picker = new PickerDialog(
      'Switch conversation',
      conversations.slice(0, 80).map((summary) => ({
        description: `${conversationText(summary)}${summary.id === this.conversationId ? ' · current' : ''}`,
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
      this.conversationId,
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
    await this.loadHistory()
    this.setState({
      conversationId,
      status: `conversation: ${conversationId}`,
    })
    this.ui.requestRender(true)
  }

  private async readFile(rest: string): Promise<void> {
    const [pathArg] = splitShellWords(rest)
    if (!pathArg) throw new Error('usage: /read <path>')
    const path = workspacePath(pathArg)
    const result = await this.runLocalTool('read', { path })
    this.addEntry('local', `[read] ${path}`, result)
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
    this.addEntry('local', `[run] ${rest}`, display)
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
    this.addEntry('local', `[write] ${path}`, result)
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
    this.addEntry('local', `[edit] ${path}`, result)
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
        this.appendStreamDelta(event.data.messageId, 'assistant', event.data.delta)
        this.setState({ active: true, status: 'receiving response' })
        break
      case 'chat:reasoning-delta':
        this.appendStreamDelta(event.data.messageId, 'reasoning', event.data.delta)
        this.setState({ active: true, status: 'thinking' })
        break
      case 'chat:tool-call-start':
        this.streamSegments.delete(event.data.messageId)
        this.toolNames.set(event.data.toolCallId, event.data.name)
        this.toolArgs.set(event.data.toolCallId, event.data.arguments)
        this.upsertEntry(
          `tool:${event.data.toolCallId}`,
          'tool',
          event.data.name,
          event.data.arguments,
        )
        this.setState({ active: true, status: `tool: ${event.data.name}` })
        break
      case 'chat:tool-call-args-delta': {
        const next = `${this.toolArgs.get(event.data.toolCallId) ?? ''}${event.data.delta}`
        this.toolArgs.set(event.data.toolCallId, next)
        const name = this.toolNames.get(event.data.toolCallId) ?? event.data.toolCallId
        this.upsertEntry(`tool:${event.data.toolCallId}`, 'tool', name, next)
        break
      }
      case 'chat:tool-call-result': {
        const name = this.toolNames.get(event.data.toolCallId) ?? event.data.toolCallId
        const status = event.data.isError ? 'error' : 'done'
        this.upsertEntry(
          `tool:${event.data.toolCallId}`,
          event.data.isError ? 'error' : 'tool',
          `${name} (${status})`,
          formatToolResultForDisplay(name, event.data.result),
        )
        this.setState({ active: true, status: `tool ${status}: ${name}` })
        break
      }
      case 'chat:image-block':
        this.streamSegments.delete(event.data.messageId)
        this.addEntry('image', 'image block', event.data.block.url)
        break
      case 'chat:done':
        this.finishStream(event.data.messageId)
        this.setState({ active: false, status: 'ready', usage: event.data.usage })
        this.completions.get(event.data.messageId)?.()
        break
      case 'chat:error':
        this.finishStream(event.data.messageId)
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
          this.finishStream(event.data.messageId)
          this.setState({ active: false, status: `paused: ${nextType}` })
          this.completions.get(event.data.messageId)?.()
        } else if (event.data.type === 'turn.interrupted') {
          const reason =
            typeof event.data.data?.reason === 'string' && event.data.data.reason.length > 0
              ? event.data.data.reason
              : 'Interrupted'
          this.addEntry('error', 'interrupted', reason)
          this.finishStream(event.data.messageId)
          this.setState({ active: false, status: 'interrupted' })
          this.completions.get(event.data.messageId)?.()
        }
        break
      case 'conversations:updated':
        break
    }
    this.requestRender()
  }

  private appendStreamDelta(
    messageId: string,
    kind: 'assistant' | 'reasoning',
    delta: string,
  ): void {
    if (!delta) return
    const segment = this.streamSegments.get(messageId)
    if (segment?.kind === kind) {
      const current = this.entries.find((item) => item.id === segment.id)
      if (current) {
        current.body += delta
        return
      }
    }

    const count = (this.streamSegmentCounts.get(messageId) ?? 0) + 1
    const id = `stream:${messageId}:${count}`
    this.streamSegmentCounts.set(messageId, count)
    this.streamSegments.set(messageId, { id, kind })
    this.entries.push({ body: delta, id, kind, title: '' })
  }

  private finishStream(messageId: string): void {
    this.streamSegments.delete(messageId)
    this.streamSegmentCounts.delete(messageId)
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

  private welcomeBody(resumed = false): string {
    const selection = this.session.selection
    const connected = selection && resolveApiKey(selection.providerId, loadSettings())
    return [
      `Workspace: ${process.cwd()}`,
      `Conversation: ${this.conversationId}${resumed ? ' (resumed)' : ''}`,
      `Model: ${selection ? modelLabel(selection) : 'not connected'}`,
      '',
      connected
        ? 'Write a message to begin. Type `/` to browse commands.'
        : 'Run `/setup` to connect a provider, or write your first message and Aila will guide you before sending it.',
    ].join('\n')
  }

  private refreshWelcome(): void {
    const welcome = this.entries.find((item) => item.kind === 'welcome')
    if (welcome) welcome.body = this.welcomeBody()
  }

  private async loadHistory(): Promise<void> {
    const record = await this.runtime.getConversation(this.conversationId)
    if (record.messages.length === 0) return
    for (const message of record.messages) {
      const status = message.status === 'done' ? '' : ` (${message.status})`
      if (message.role === 'user') {
        this.addEntry('user', status.trim(), persistedMessageBody(message))
        continue
      }
      if (message.blocks.length === 0) {
        this.addEntry('assistant', status.trim(), '[empty message]')
        continue
      }
      for (const block of message.blocks) {
        switch (block.type) {
          case 'text':
            this.addEntry('assistant', status.trim(), block.content)
            break
          case 'reasoning':
            this.addEntry('reasoning', '', block.content)
            break
          case 'tool_call':
            this.addEntry('tool', `${block.name} (${block.status})`)
            break
          case 'image':
            this.addEntry('image', 'image block', block.url)
            break
        }
      }
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
    { name: 'runs', description: 'List persisted agent runs' },
    { name: 'inspect-run', description: 'Inspect a persisted run', argumentHint: '<id>' },
    { name: 'step-run', description: 'Execute one pending run action', argumentHint: '<id>' },
    { name: 'continue-run', description: 'Continue a paused run', argumentHint: '<id>' },
    { name: 'abort-run', description: 'Cancel a persisted run', argumentHint: '<id>' },
    { name: 'fork-run', description: 'Fork a persisted run', argumentHint: '<id>' },
    { name: 'sessions', description: 'Open saved conversation picker' },
    { name: 'extensions', description: 'Show extension manifests', argumentHint: '[reload]' },
    { name: 'setup', description: 'Connect a provider and choose a model' },
    {
      name: 'approval',
      description: 'Show or change tool approval mode',
      argumentHint: '[safe|yolo]',
    },
    { name: 'yolo', description: 'Run future tools without confirmation' },
    { name: 'safe', description: 'Require confirmation for risky tools' },
    { name: 'model', description: 'Show or switch model', argumentHint: '[provider:model]' },
    { name: 'read', description: 'Read file into context', argumentHint: '<path>' },
    { name: 'run', description: 'Run shell command', argumentHint: '<command>' },
    { name: 'write', description: 'Write file', argumentHint: '<path> <content>' },
    { name: 'edit', description: 'Edit file', argumentHint: '<path> <old> => <new>' },
  ]
}
