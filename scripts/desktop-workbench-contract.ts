import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AILA_RUN_EVENT_SCHEMA_VERSION,
  type ToolApprovalRequestPayload,
  type ToolApprovalResolvedPayload,
  ToolApprovalStore,
} from '@aila/agent'
import {
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  appendMessage,
  appendRunEvent,
  appendRunEventAndTouchConversation,
  configureDataDir,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listRunEvents,
  recoverInterruptedConversationActivities,
} from '@aila/agent-node/app'
import {
  buildDesktopWorkspaceContextFromRecord,
  getDesktopWorkspaceRoots,
} from '../apps/desktop/src/main/workspace-context'
import type { ConversationSummary, ConversationWorkspaceRef } from '../apps/desktop/src/preload'
import {
  buildConversationSidebarSections,
  groupConversationsByWorkspace,
} from '../apps/desktop/src/renderer/src/pages/chat/ConversationList'
import {
  createChatStreamsStateForTest,
  reduceChatStreamsForTest,
} from '../apps/desktop/src/renderer/src/pages/chat/useChatStreams'
import { mergeConversationSummaryUpdate } from '../apps/desktop/src/renderer/src/pages/chat/useConversations'
import {
  createToolApprovalsState,
  mergeToolApprovals,
  resolveToolApproval,
  resolveToolApprovalsForConversation,
} from '../apps/desktop/src/renderer/src/toolApprovalsState'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

async function withTempDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'aila-desktop-workbench-'))
  try {
    configureDataDir(dir)
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

async function testWorkspaceConversationContext(): Promise<void> {
  await withTempDataDir(async () => {
    const workspace: ConversationWorkspaceRef = {
      id: '/tmp/aila-workbench-contract',
      path: '/tmp/aila-workbench-contract',
      label: 'Workbench Contract',
    }
    const conversation = await createConversation(workspace)

    const context = await buildDesktopWorkspaceContextFromRecord(
      await getConversation(conversation.id),
    )
    assertEqual(context.length, 1, 'workspace conversation should get one context message')
    assertEqual(context[0]?.role, 'system', 'context should be a system message')

    const rawContent = context[0]?.content ?? ''
    const content = typeof rawContent === 'string' ? rawContent : ''
    assert(content.includes('Desktop workspace context:'), 'context should identify Desktop scope')
    assert(content.includes('Workspace: Workbench Contract'), 'context should include label')
    assert(content.includes(workspace.path), 'context should include absolute workspace path')
  })
}

async function testDesktopWorkspaceRoots(): Promise<void> {
  await withTempDataDir(async () => {
    const roots = getDesktopWorkspaceRoots()
    assertEqual(roots?.length, 1, 'Desktop should expose only the project root')
    const root = roots?.[0]
    assert(root && typeof root !== 'string', 'Desktop project root should keep a label')
    assertEqual(root.path, process.cwd(), 'Desktop project root path')
  })
}

async function testDesktopMainUsesEsmSafeRuntimePaths(): Promise<void> {
  const mainSource = await readFile(join(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf-8')
  const configSource = await readFile(
    join(process.cwd(), 'apps/desktop/electron.vite.config.ts'),
    'utf-8',
  )
  assert(
    mainSource.includes('dirname(fileURLToPath(import.meta.url))'),
    'Desktop main should resolve bundled paths from import.meta.url',
  )
  assert(!mainSource.includes('__dirname'), 'Desktop ESM main must not depend on __dirname')
  assert(
    mainSource.includes('[startup] fatal initialization failure:'),
    'Desktop startup should handle initialization promise failures',
  )
  assert(
    configSource.includes('dirname(fileURLToPath(import.meta.url))'),
    'electron-vite config should resolve aliases from import.meta.url',
  )
  assert(
    !configSource.includes('__dirname'),
    'electron-vite ESM config must not depend on __dirname',
  )
  assert(
    configSource.includes("find: '@aila/agent/internal'") &&
      configSource.includes('packages/agent/src/internal.ts'),
    'electron-vite must resolve the agent internal subpath before the package root alias',
  )
}

async function testDesktopUsesSharedRuntimeFactory(): Promise<void> {
  const source = await readFile(join(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf-8')
  const workbenchSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/main/runtime-workbench.ts'),
    'utf-8',
  )
  assert(
    source.includes('createDesktopRuntimeWorkbench'),
    'Desktop main process should use the runtime workbench adapter',
  )
  assert(
    !source.includes('new WorkbenchRuntime'),
    'Desktop main process should not construct WorkbenchRuntime directly',
  )
  assert(
    !source.includes('createPersistedWorkbench'),
    'Desktop main process should not wire the persisted runtime factory directly',
  )
  assert(
    !source.includes('createPersistedRuntimeStore'),
    'Desktop main process should not wire the persisted store directly',
  )
  assert(
    !source.includes('loadToolPacksFromDir'),
    'Desktop main process should not wire tool-pack loaders directly',
  )
  assert(
    workbenchSource.includes('createPersistedWorkbench') &&
      workbenchSource.includes('ToolApprovalStore') &&
      workbenchSource.includes('Workbench') &&
      workbenchSource.includes('registerRuntimeWorkbenchIpcHandlers'),
    'Desktop runtime workbench should own runtime construction, approvals, typed runtime API, and IPC registration',
  )
  assert(
    workbenchSource.includes('let runtime: Workbench') &&
      !workbenchSource.includes('ReturnType<typeof createPersistedWorkbench>'),
    'Desktop runtime workbench should depend on the host-facing runtime API type',
  )
  assert(
    workbenchSource.includes("from '@aila/agent'") &&
      !workbenchSource.includes("from './runtime'") &&
      !workbenchSource.includes("from './agent-protocol'") &&
      !workbenchSource.includes("from './conversation-core'") &&
      !workbenchSource.includes("from './tool-approvals'") &&
      !workbenchSource.includes("from './tools'"),
    'Desktop runtime workbench should import runtime contracts from @aila/agent',
  )
  assert(
    !workbenchSource.includes("from '../runtime/internal'"),
    'Desktop runtime workbench should not import runtime implementation internals',
  )
}

async function testDesktopExposesRuntimeStateApi(): Promise<void> {
  const mainSource = await readFile(join(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf-8')
  const workbenchSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/main/runtime-workbench.ts'),
    'utf-8',
  )
  const preloadSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/preload/index.ts'),
    'utf-8',
  )
  assert(
    mainSource.includes('registerRuntimeWorkbenchIpcHandlers(ipcMain, runtimeWorkbench)') &&
      !mainSource.includes("'conversations:get-runtime-state'") &&
      !mainSource.includes("'chat:list-active-streams'"),
    'Desktop main should delegate runtime IPC to the runtime workbench',
  )
  assert(
    workbenchSource.includes("'runtime:hydrate-conversation'") &&
      workbenchSource.includes('workbench.hydrateConversation(conversationId)'),
    'Desktop runtime workbench should expose conversation hydration through IPC',
  )
  assert(
    workbenchSource.includes("'runtime:compact-conversation'") &&
      workbenchSource.includes('workbench.compactConversation(request)'),
    'Desktop runtime workbench should expose manual context compaction through IPC',
  )
  assert(
    workbenchSource.includes("'runtime:list-active-turns'") &&
      workbenchSource.includes('workbench.listActiveTurns()') &&
      workbenchSource.includes('return runtime.listActiveTurns()') &&
      !workbenchSource.includes('runtime.listActiveStreams()'),
    'Desktop runtime workbench should expose live active turns through the runtime namespace',
  )
  assert(
    preloadSource.includes('runtime: {') &&
      preloadSource.includes('hydrateConversation:') &&
      preloadSource.includes("'runtime:hydrate-conversation'") &&
      preloadSource.includes('compactConversation:') &&
      preloadSource.includes("'runtime:compact-conversation'") &&
      preloadSource.includes('listActiveTurns:') &&
      preloadSource.includes("'runtime:list-active-turns'"),
    'Desktop preload should expose a runtime namespace to renderer',
  )
}

async function testDesktopKeepsRunControlsOutOfChatCanvas(): Promise<void> {
  const workbenchSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/main/runtime-workbench.ts'),
    'utf-8',
  )
  const preloadSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/preload/index.ts'),
    'utf-8',
  )
  const chatPageSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/renderer/src/pages/chat/ChatPage.tsx'),
    'utf-8',
  )
  const appSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/renderer/src/App.tsx'),
    'utf-8',
  )
  for (const action of ['list', 'inspect', 'step', 'continue', 'resume', 'abort', 'fork']) {
    assert(
      workbenchSource.includes(`'runtime:runs:${action}'`),
      `Desktop workbench should register runtime:runs:${action}`,
    )
  }
  for (const action of ['list-summaries', 'get-artifact']) {
    assert(
      workbenchSource.includes(`'runtime:runs:${action}'`),
      `Desktop workbench should register scalable inspector API runtime:runs:${action}`,
    )
  }
  assert(
    preloadSource.includes('listRuns:') &&
      preloadSource.includes('listRunSummaries:') &&
      preloadSource.includes('inspectRun:') &&
      preloadSource.includes('getRunArtifact:') &&
      preloadSource.includes('stepRun:') &&
      preloadSource.includes('continueRun:') &&
      preloadSource.includes('abortRun:') &&
      preloadSource.includes('forkRun:'),
    'Desktop preload should expose run inspection and control methods',
  )
  assert(
    !chatPageSource.includes('ExecutionInspector') &&
      !chatPageSource.includes('stepMode') &&
      !chatPageSource.includes('inspectorOpen') &&
      !chatPageSource.includes('PanelRight') &&
      !chatPageSource.includes('WorkbenchDisplayMode') &&
      !chatPageSource.includes('<ModeSwitch') &&
      !appSource.includes('displayMode='),
    'Desktop chat canvas should stay full-width without an embedded run inspector or step controls',
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function testDesktopDoesNotExposeEmbeddedTerminalApi(): Promise<void> {
  const mainSource = await readFile(join(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf-8')
  const preloadSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/preload/index.ts'),
    'utf-8',
  )
  const appSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/renderer/src/App.tsx'),
    'utf-8',
  )
  const sidebarSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/renderer/src/pages/chat/ConversationList.tsx'),
    'utf-8',
  )
  const desktopPackageSource = await readFile(
    join(process.cwd(), 'apps/desktop/package.json'),
    'utf-8',
  )
  const terminalAdapterPath = join(process.cwd(), 'apps/desktop/src/main/terminal.ts')
  const terminalPanelPath = join(
    process.cwd(),
    'apps/desktop/src/renderer/src/components/terminal/WorkspaceTerminalPanel.tsx',
  )

  assert(
    !mainSource.includes('createTerminalSessionManager') &&
      !mainSource.includes('registerTerminalIpcHandlers') &&
      !mainSource.includes('terminalManager'),
    'Desktop main process should not own embedded terminal IPC or lifecycle',
  )
  assert(
    !preloadSource.includes('terminal: {') &&
      !preloadSource.includes("'terminal:create'") &&
      !preloadSource.includes("'terminal:write'") &&
      !preloadSource.includes("'terminal:data'") &&
      !preloadSource.includes("'terminal:exit'"),
    'Desktop preload should not expose a terminal namespace to the renderer',
  )
  assert(
    !appSource.includes('terminalWorkspace') &&
      !appSource.includes('WorkspaceTerminalPanel') &&
      !sidebarSource.includes('TerminalIcon') &&
      !sidebarSource.includes('Open Terminal') &&
      !sidebarSource.includes('onOpenTerminal'),
    'Desktop renderer should not expose an embedded terminal entry point or panel',
  )
  assert(
    !desktopPackageSource.includes('"node-pty"') &&
      !desktopPackageSource.includes('"@xterm/xterm"') &&
      !desktopPackageSource.includes('"@xterm/addon-fit"'),
    'Desktop package should not depend on PTY or terminal rendering packages',
  )
  assert(
    !(await pathExists(terminalAdapterPath)) && !(await pathExists(terminalPanelPath)),
    'Desktop embedded terminal adapter and panel should be removed',
  )
}

async function testRendererUsesRuntimeHydrationApi(): Promise<void> {
  const streamSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/renderer/src/pages/chat/useChatStreams.ts'),
    'utf-8',
  )
  assert(
    streamSource.includes('window.api.runtime.hydrateConversation(id)'),
    'chat streams should hydrate from the runtime lifecycle API',
  )
  for (const forbidden of [
    'window.api.conversations.get',
    'window.api.conversations.listEvents',
    'window.api.conversations.getRuntimeState',
    'window.api.listActiveStreams',
  ]) {
    assert(
      !streamSource.includes(forbidden),
      `chat streams should not rebuild runtime hydration from scattered IPC: ${forbidden}`,
    )
  }
}

async function testDesktopExposesMcpIntegrationOAuthApi(): Promise<void> {
  const mainSource = await readFile(join(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf-8')
  const preloadSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/preload/index.ts'),
    'utf-8',
  )
  const settingsSource = await readFile(
    join(process.cwd(), 'apps/desktop/src/renderer/src/components/SettingsModal.tsx'),
    'utf-8',
  )
  const integrationSource = await readFile(
    join(process.cwd(), 'packages/agent-node/src/app/integrations.ts'),
    'utf-8',
  )

  assert(
    mainSource.includes("'extensions:integration-save'") &&
      mainSource.includes("'extensions:mcp-oauth-start'") &&
      mainSource.includes("'extensions:mcp-oauth-clear'") &&
      mainSource.includes('shell.openExternal(url)'),
    'Desktop main should expose integration save and MCP OAuth IPC',
  )
  assert(
    preloadSource.includes('saveIntegration:') &&
      preloadSource.includes("'extensions:integration-save'") &&
      preloadSource.includes('startMcpOAuth:') &&
      preloadSource.includes("'extensions:mcp-oauth-start'") &&
      preloadSource.includes('clearMcpOAuth:') &&
      preloadSource.includes("'extensions:mcp-oauth-clear'"),
    'Desktop preload should expose integration and MCP OAuth APIs',
  )
  assert(
    settingsSource.includes('handleSaveGmailIntegration') &&
      settingsSource.includes('handleConnectGmail') &&
      settingsSource.includes('handleClearGmailOAuth') &&
      settingsSource.includes('Gmail'),
    'Settings extensions view should expose a Gmail integration surface',
  )
  assert(
    integrationSource.includes('https://gmailmcp.googleapis.com/mcp/v1') &&
      integrationSource.includes('https://www.googleapis.com/auth/gmail.readonly') &&
      integrationSource.includes('https://www.googleapis.com/auth/gmail.compose'),
    'Gmail integration preset should target the official Gmail MCP endpoint and scopes',
  )
}

async function testConversationListContract(): Promise<void> {
  await withTempDataDir(async () => {
    const general = await createConversation()
    const workspace = await createConversation({
      id: '/tmp/aila-list-contract',
      path: '/tmp/aila-list-contract',
      label: 'List Contract',
    })

    const all = await listConversations()
    assertEqual(all.length, 2, 'conversation list should include every thread')
    assert(
      all.some((conversation) => conversation.id === general.id),
      'general thread is listed',
    )
    assert(
      all.some((conversation) => conversation.id === workspace.id),
      'workspace thread is listed',
    )
  })
}

async function testConversationDeleteCleansActivity(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'message',
      role: 'user',
      blocks: [{ type: 'text', content: 'delete me' }],
      status: 'done',
    })
    await appendRunEvent(conversation.id, {
      timestamp: 1,
      conversationId: conversation.id,
      messageId: 'message',
      type: 'turn.started',
    })

    await deleteConversation(conversation.id)
    assertEqual(
      (await listRunEvents(conversation.id)).length,
      0,
      'delete should remove activity log',
    )
    try {
      await getConversation(conversation.id)
      throw new Error('deleted conversation unexpectedly loaded')
    } catch (error) {
      assert(
        error instanceof Error && !error.message.includes('unexpectedly loaded'),
        'deleted conversation should not be recoverable from disk',
      )
    }
  })
}

async function testActivityUpdatesConversationSummary(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const before = await getConversation(conversation.id)

    const { event, summary } = await appendRunEventAndTouchConversation(conversation.id, {
      timestamp: before.meta.updatedAt,
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'tool.execution.started',
      data: { toolName: 'read', target: { kind: 'file', preview: '/workspace/app.ts', size: 17 } },
    })

    assertEqual(
      event.schemaVersion,
      AILA_RUN_EVENT_SCHEMA_VERSION,
      'activity event should be versioned',
    )
    assert(summary, 'activity append should return refreshed summary')
    assert(
      summary.updatedAt > before.meta.updatedAt,
      'activity append should bump conversation updatedAt',
    )
    assertEqual(summary.activity?.state, 'running', 'activity summary state')
    assertEqual(summary.activity?.title, 'Running: read', 'activity summary title')
    assertEqual(summary.activity?.detail, '/workspace/app.ts', 'activity summary target detail')
    assertEqual(summary.activity?.toolName, 'read', 'activity summary tool')
    assertEqual(
      summary.activity?.eventType,
      'tool.execution.started',
      'activity summary event type',
    )
    assertEqual(
      (await listRunEvents(conversation.id))[0]?.type,
      'tool.execution.started',
      'activity append should still persist the event log',
    )
    assertEqual(
      (await listConversations())[0]?.id,
      conversation.id,
      'activity append should refresh conversation summaries',
    )
  })
}

async function testActivityDeltaDoesNotTouchConversationSummary(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const before = await getConversation(conversation.id)

    const { event, summary } = await appendRunEventAndTouchConversation(conversation.id, {
      timestamp: before.meta.updatedAt + 10,
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'tool.input.delta',
      data: { deltaSize: 64, toolCallId: 'tool-call' },
    })

    assertEqual(
      event.schemaVersion,
      AILA_RUN_EVENT_SCHEMA_VERSION,
      'delta event should be versioned',
    )
    assertEqual(summary, undefined, 'input deltas should not refresh conversation summaries')
    assertEqual(
      (await listRunEvents(conversation.id))[0]?.type,
      'tool.input.delta',
      'input deltas should still persist the event log',
    )

    const after = await getConversation(conversation.id)
    assertEqual(
      after.meta.updatedAt,
      before.meta.updatedAt,
      'input deltas should not bump conversation updatedAt',
    )
    assertEqual(after.meta.activity, undefined, 'input deltas should not set activity')
  })
}

async function testStaleActivityDoesNotOverwriteNewerSummary(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendRunEventAndTouchConversation(conversation.id, {
      timestamp: 200,
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'turn.completed',
    })
    const { summary } = await appendRunEventAndTouchConversation(conversation.id, {
      timestamp: 100,
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'tool.execution.started',
      data: { toolName: 'read_file' },
    })

    assert(summary, 'stale activity append should still return a summary')
    assertEqual(summary.activity?.state, 'completed', 'newer activity state should be preserved')
    assertEqual(summary.activity?.eventType, 'turn.completed', 'newer activity event should stay')
    assertEqual(summary.activity?.updatedAt, 200, 'newer activity timestamp should stay')
    const events = await listRunEvents(conversation.id)
    assertEqual(events.length, 2, 'stale activity should still persist in the event log')
    assertEqual(
      events[0]?.type,
      'turn.completed',
      'event log should preserve durable append sequence despite stale timestamps',
    )
    assertEqual(events[0]?.seq, 1, 'first durable event sequence')
    assertEqual(events[1]?.seq, 2, 'second durable event sequence')
  })
}

async function testToolResultActivityKeepsToolName(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const { summary } = await appendRunEventAndTouchConversation(conversation.id, {
      timestamp: Date.now(),
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'tool.result.returned',
      data: {
        toolCallId: 'tool-call',
        toolName: 'read_file',
        isError: false,
        result: { preview: 'ok', size: 2 },
      },
    })

    assert(summary, 'tool result activity should return refreshed summary')
    assertEqual(summary.activity?.state, 'running', 'tool result activity state')
    assertEqual(
      summary.activity?.title,
      'Tool result returned: read_file',
      'tool result activity title should keep tool name',
    )
    assertEqual(summary.activity?.toolName, 'read_file', 'tool result activity tool name')
    assertEqual(
      summary.activity?.eventType,
      'tool.result.returned',
      'tool result activity event type',
    )
  })
}

function testRendererHydratesActiveAssistantTurn(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'HYDRATE',
    conversationId: 'conversation-active',
    messages: [
      { id: 'user', role: 'user', blocks: [{ type: 'text', content: 'hello' }], status: 'done' },
    ],
    usage: null,
    events: [],
    activeTurn: {
      conversationId: 'conversation-active',
      assistantMessageId: 'assistant-active',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })

  const stream = state.streams.get('conversation-active')
  assert(stream, 'active hydrate should create a stream')
  assertEqual(stream.runningMessageId, 'assistant-active', 'active hydrate running message id')
  const assistant = stream.messages.at(-1)
  assertEqual(assistant?.id, 'assistant-active', 'active hydrate assistant message id')
  assertEqual(assistant?.role, 'assistant', 'active hydrate assistant role')
  assertEqual(assistant?.status, 'streaming', 'active hydrate assistant status')
  assertEqual(assistant?.model?.modelId, 'contract/mock', 'active hydrate assistant model')
}

function testRendererHydratesTerminalRuntimeReplayState(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'HYDRATE',
    conversationId: 'conversation-runtime-terminal',
    messages: [
      {
        id: 'user-runtime-terminal',
        role: 'user',
        blocks: [{ type: 'text', content: 'recover terminal replay' }],
        status: 'done',
      },
    ],
    usage: null,
    events: [
      {
        schemaVersion: 1,
        timestamp: 10,
        conversationId: 'conversation-runtime-terminal',
        messageId: 'assistant-runtime-terminal',
        type: 'turn.started',
        data: { providerId: 'openrouter', modelId: 'contract/mock' },
      },
      {
        schemaVersion: 1,
        timestamp: 20,
        conversationId: 'conversation-runtime-terminal',
        messageId: 'assistant-runtime-terminal',
        type: 'turn.interrupted',
        data: { reason: 'runtime replay recovered terminal state' },
      },
    ],
    runtimeState: {
      phase: 'interrupted',
      active: false,
      turn: {
        conversationId: 'conversation-runtime-terminal',
        assistantMessageId: 'assistant-runtime-terminal',
        updatedAt: 20,
        eventType: 'turn.interrupted',
        startedAt: 10,
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      },
    },
  })

  const stream = state.streams.get('conversation-runtime-terminal')
  assert(stream, 'terminal runtime replay hydrate should create a stream')
  assertEqual(stream.runningMessageId, null, 'terminal runtime replay hydrate should not be busy')
  const assistant = stream.messages.find((message) => message.id === 'assistant-runtime-terminal')
  assert(assistant, 'terminal runtime replay should create assistant message')
  assertEqual(assistant.status, 'error', 'terminal runtime replay assistant status')
  assertEqual(
    assistant.error,
    'runtime replay recovered terminal state',
    'terminal runtime replay should preserve interrupted reason',
  )
  assertEqual(assistant.model?.modelId, 'contract/mock', 'terminal runtime replay assistant model')
}

function testRendererDoesNotTreatStaleActiveRuntimeReplayAsLive(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'HYDRATE',
    conversationId: 'conversation-stale-runtime-active',
    messages: [
      {
        id: 'user-stale-runtime-active',
        role: 'user',
        blocks: [{ type: 'text', content: 'stale active replay' }],
        status: 'done',
      },
    ],
    usage: null,
    events: [
      {
        schemaVersion: 1,
        timestamp: 10,
        conversationId: 'conversation-stale-runtime-active',
        messageId: 'assistant-stale-runtime-active',
        type: 'turn.started',
        data: { providerId: 'openrouter', modelId: 'contract/mock' },
      },
    ],
    runtimeState: {
      phase: 'running',
      active: true,
      turn: {
        conversationId: 'conversation-stale-runtime-active',
        assistantMessageId: 'assistant-stale-runtime-active',
        updatedAt: 10,
        eventType: 'turn.started',
        startedAt: 10,
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      },
    },
  })

  const stream = state.streams.get('conversation-stale-runtime-active')
  assert(stream, 'stale active runtime replay hydrate should create a stream')
  assertEqual(
    stream.runningMessageId,
    null,
    'stale active runtime replay should not be treated as a live stream',
  )
  assertEqual(
    stream.messages.some((message) => message.id === 'assistant-stale-runtime-active'),
    false,
    'stale active runtime replay without active stream should not create streaming assistant',
  )
}

function testRendererHydratePreservesLocalStreamingMessages(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_STARTED',
    conversationId: 'conversation-hydrate-race',
    userMessage: {
      id: 'user-hydrate-race',
      role: 'user',
      blocks: [{ type: 'text', content: 'draft prompt' }],
      status: 'done',
    },
    assistantMessage: {
      id: 'assistant-hydrate-race',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'partial' }],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'HYDRATE',
    conversationId: 'conversation-hydrate-race',
    messages: [],
    usage: null,
    events: [],
  })

  const stream = state.streams.get('conversation-hydrate-race')
  assert(stream, 'hydrate race should keep stream')
  assertEqual(stream.messages.length, 2, 'hydrate should keep local user and assistant')
  assertEqual(stream.messages[0]?.id, 'user-hydrate-race', 'hydrate should keep local user')
  assertEqual(
    stream.messages[1]?.id,
    'assistant-hydrate-race',
    'hydrate should keep local assistant',
  )
  assertEqual(stream.runningMessageId, 'assistant-hydrate-race', 'hydrate should keep running id')
}

function testRendererHydrateReplacesStreamingWithPersistedTerminal(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_STARTED',
    conversationId: 'conversation-hydrate-terminal',
    userMessage: {
      id: 'user-hydrate-terminal',
      role: 'user',
      blocks: [{ type: 'text', content: 'finish before hydrate' }],
      status: 'done',
    },
    assistantMessage: {
      id: 'assistant-hydrate-terminal',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'partial' }],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'HYDRATE',
    conversationId: 'conversation-hydrate-terminal',
    messages: [
      {
        id: 'user-hydrate-terminal',
        role: 'user',
        blocks: [{ type: 'text', content: 'finish before hydrate' }],
        status: 'done',
      },
      {
        id: 'assistant-hydrate-terminal',
        role: 'assistant',
        blocks: [{ type: 'text', content: 'final answer' }],
        status: 'done',
        model: { providerId: 'openrouter', modelId: 'contract/mock' },
      },
    ],
    usage: null,
    events: [],
  })

  const stream = state.streams.get('conversation-hydrate-terminal')
  assert(stream, 'terminal hydrate should keep stream')
  assertEqual(stream.messages.length, 2, 'terminal hydrate should keep merged messages')
  assertEqual(
    stream.messages[1]?.status,
    'done',
    'terminal hydrate should replace local streaming assistant',
  )
  assertEqual(stream.runningMessageId, null, 'terminal hydrate should clear running id')
}

function testRendererCompletedEventWaitsForFinishMessage(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_STARTED',
    conversationId: 'conversation-completed-order',
    userMessage: {
      id: 'user-completed-order',
      role: 'user',
      blocks: [{ type: 'text', content: 'complete after event' }],
      status: 'done',
    },
    assistantMessage: {
      id: 'assistant-completed-order',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'streaming text' }],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_EVENT',
    event: {
      schemaVersion: 1,
      timestamp: 1,
      conversationId: 'conversation-completed-order',
      messageId: 'assistant-completed-order',
      type: 'turn.completed',
      data: { outputBlockCount: 1 },
    },
  })

  let stream = state.streams.get('conversation-completed-order')
  assert(stream, 'completed event should keep stream')
  assertEqual(
    stream.runningMessageId,
    'assistant-completed-order',
    'completed event should not clear running before finish message',
  )
  assertEqual(
    stream.messages[1]?.status,
    'streaming',
    'completed event should keep streaming message',
  )
  assertEqual(stream.events.length, 1, 'completed event should append timeline event')

  state = reduceChatStreamsForTest(state, {
    type: 'FINISH',
    conversationId: 'conversation-completed-order',
    messageId: 'assistant-completed-order',
    message: {
      id: 'assistant-completed-order',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'final text' }],
      status: 'done',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })

  stream = state.streams.get('conversation-completed-order')
  assert(stream, 'finish should keep stream')
  assertEqual(stream.runningMessageId, null, 'finish should clear running message')
  assertEqual(stream.messages[1]?.status, 'done', 'finish should replace streaming message')
}

function testRendererFailedEventFinalizesStreamingPlaceholder(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_STARTED',
    conversationId: 'conversation-failed-event',
    userMessage: {
      id: 'user-failed-event',
      role: 'user',
      blocks: [{ type: 'text', content: 'fail before error message' }],
      status: 'done',
    },
    assistantMessage: {
      id: 'assistant-failed-event',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'partial before failure' }],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_EVENT',
    event: {
      schemaVersion: 1,
      timestamp: 1,
      conversationId: 'conversation-failed-event',
      messageId: 'assistant-failed-event',
      type: 'turn.failed',
      data: { error: 'provider disconnected' },
    },
  })

  const stream = state.streams.get('conversation-failed-event')
  assert(stream, 'failed event should keep stream')
  assertEqual(stream.runningMessageId, null, 'failed event should clear running message')
  assertEqual(stream.messages[1]?.status, 'error', 'failed event should mark assistant error')
  assertEqual(stream.messages[1]?.error, 'provider disconnected', 'failed event should keep error')
  assertEqual(stream.events.length, 1, 'failed event should append timeline event')
}

function testRendererInterruptedEventFinalizesStreamingPlaceholder(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_STARTED',
    conversationId: 'conversation-interrupted-event',
    userMessage: {
      id: 'user-interrupted-event',
      role: 'user',
      blocks: [{ type: 'text', content: 'recover interrupted turn' }],
      status: 'done',
    },
    assistantMessage: {
      id: 'assistant-interrupted-event',
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_EVENT',
    event: {
      schemaVersion: 1,
      timestamp: 1,
      conversationId: 'conversation-interrupted-event',
      messageId: 'assistant-interrupted-event',
      type: 'turn.interrupted',
      data: { reason: 'runtime restarted before this turn finished' },
    },
  })

  const stream = state.streams.get('conversation-interrupted-event')
  assert(stream, 'interrupted event should keep stream')
  assertEqual(stream.runningMessageId, null, 'interrupted event should clear running message')
  assertEqual(stream.messages[1]?.status, 'error', 'interrupted event should mark assistant error')
  assertEqual(
    stream.messages[1]?.error,
    'runtime restarted before this turn finished',
    'interrupted event should expose recovery reason',
  )
  assertEqual(stream.events.length, 1, 'interrupted event should append timeline event')
}

function testRendererStaleFailureDoesNotDowngradeFinishedMessage(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'FINISH',
    conversationId: 'conversation-stale-failure',
    messageId: 'assistant-stale-failure',
    message: {
      id: 'assistant-stale-failure',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'already done' }],
      status: 'done',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_EVENT',
    event: {
      schemaVersion: 1,
      timestamp: 1,
      conversationId: 'conversation-stale-failure',
      messageId: 'assistant-stale-failure',
      type: 'turn.failed',
      data: { error: 'late stale failure' },
    },
  })

  const stream = state.streams.get('conversation-stale-failure')
  assert(stream, 'stale failure should keep stream')
  assertEqual(stream.messages.length, 1, 'stale failure should not append duplicate message')
  assertEqual(
    stream.messages[0]?.status,
    'done',
    'stale failure should not downgrade finished assistant',
  )
  assertEqual(stream.messages[0]?.error, undefined, 'stale failure should not add error')
  assertEqual(stream.events.length, 1, 'stale failure should still append timeline event')
}

function testRendererLateStartedEventDoesNotReviveFinishedMessage(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'FINISH',
    conversationId: 'conversation-late-started',
    messageId: 'assistant-late-started',
    message: {
      id: 'assistant-late-started',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'already final' }],
      status: 'done',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_EVENT',
    event: {
      schemaVersion: 1,
      timestamp: 1,
      conversationId: 'conversation-late-started',
      messageId: 'assistant-late-started',
      type: 'turn.started',
      data: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })

  const stream = state.streams.get('conversation-late-started')
  assert(stream, 'late started should keep stream')
  assertEqual(stream.runningMessageId, null, 'late started should not revive running state')
  assertEqual(stream.messages.length, 1, 'late started should not append duplicate assistant')
  assertEqual(stream.messages[0]?.status, 'done', 'late started should keep terminal message')
  assertEqual(stream.events.length, 1, 'late started should still append timeline event')
}

function testRendererLateStreamingPatchDoesNotMutateFinishedMessage(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'FINISH',
    conversationId: 'conversation-late-delta',
    messageId: 'assistant-late-delta',
    message: {
      id: 'assistant-late-delta',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'final text' }],
      status: 'done',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'TEXT_DELTA',
    conversationId: 'conversation-late-delta',
    messageId: 'assistant-late-delta',
    kind: 'text',
    delta: ' stale suffix',
  })
  state = reduceChatStreamsForTest(state, {
    type: 'TOOL_CALL_RESULT',
    conversationId: 'conversation-late-delta',
    messageId: 'assistant-late-delta',
    toolCallId: 'late-tool',
    name: 'read',
    result: 'late tool result',
    isError: false,
  })

  const stream = state.streams.get('conversation-late-delta')
  assert(stream, 'late patch should keep stream')
  assertEqual(stream.runningMessageId, null, 'late patch should not revive running state')
  assertEqual(stream.messages.length, 1, 'late patch should not append duplicate assistant')
  assertEqual(
    stream.messages[0]?.blocks[0]?.type === 'text' ? stream.messages[0].blocks[0].content : '',
    'final text',
    'late patch should not mutate final content',
  )
  assertEqual(stream.messages[0]?.blocks.length, 1, 'late tool result should not append tool block')
}

function testRendererDropTombstonesLateStreamEvents(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_STARTED',
    conversationId: 'conversation-dropped',
    userMessage: {
      id: 'user-dropped',
      role: 'user',
      blocks: [{ type: 'text', content: 'delete while streaming' }],
      status: 'done',
    },
    assistantMessage: {
      id: 'assistant-dropped',
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'DROP',
    conversationId: 'conversation-dropped',
  })
  state = reduceChatStreamsForTest(state, {
    type: 'TEXT_DELTA',
    conversationId: 'conversation-dropped',
    messageId: 'assistant-dropped',
    kind: 'text',
    delta: 'late text',
  })
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_EVENT',
    event: {
      schemaVersion: 1,
      timestamp: 1,
      conversationId: 'conversation-dropped',
      messageId: 'assistant-dropped',
      type: 'turn.interrupted',
      data: { reason: 'delete cleanup timed out' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'FINISH',
    conversationId: 'conversation-dropped',
    messageId: 'assistant-dropped',
    message: {
      id: 'assistant-dropped',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'late final' }],
      status: 'done',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })

  assert(
    !state.streams.has('conversation-dropped'),
    'dropped stream should not be recreated by late stream events',
  )
  assert(
    state.droppedConversationIds.has('conversation-dropped'),
    'dropped stream should keep a renderer tombstone',
  )
}

function testRendererDropClearsQueueAndBlocksFutureActions(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'ENQUEUE',
    conversationId: 'conversation-dropped-queue',
    queued: {
      id: 'queued-before-delete',
      kind: 'send',
      text: 'queued before delete',
      attachments: [],
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'ENQUEUE',
    conversationId: 'conversation-dropped-queue',
    queued: {
      id: 'queued-retry-before-delete',
      kind: 'retryLast',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })

  const beforeDrop = state.streams.get('conversation-dropped-queue')
  assert(beforeDrop, 'queued conversation should have a stream before drop')
  assertEqual(beforeDrop.queue.length, 2, 'queued conversation should start busy')

  state = reduceChatStreamsForTest(state, {
    type: 'DROP',
    conversationId: 'conversation-dropped-queue',
  })
  state = reduceChatStreamsForTest(state, {
    type: 'HYDRATE',
    conversationId: 'conversation-dropped-queue',
    messages: [
      {
        id: 'user-dropped-queue',
        role: 'user',
        blocks: [{ type: 'text', content: 'late hydrate' }],
        status: 'done',
      },
    ],
    usage: null,
    events: [],
    activeTurn: {
      conversationId: 'conversation-dropped-queue',
      assistantMessageId: 'assistant-dropped-queue',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'ENQUEUE',
    conversationId: 'conversation-dropped-queue',
    queued: {
      id: 'queued-after-delete',
      kind: 'send',
      text: 'queued after delete',
      attachments: [],
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'RETRY_STARTED',
    conversationId: 'conversation-dropped-queue',
    assistantMessage: {
      id: 'assistant-dropped-queue-retry',
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })

  assert(
    !state.streams.has('conversation-dropped-queue'),
    'dropped stream should clear queued work and reject future actions',
  )
  assert(
    state.droppedConversationIds.has('conversation-dropped-queue'),
    'dropped queued stream should keep a renderer tombstone',
  )
}

function conversationSummary(id: string, title: string, updatedAt: number): ConversationSummary {
  return {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id,
    title,
    createdAt: 1,
    updatedAt,
  }
}

function workspaceConversationSummary(
  id: string,
  title: string,
  workspace: ConversationWorkspaceRef,
  updatedAt: number,
): ConversationSummary {
  return {
    ...conversationSummary(id, title, updatedAt),
    workspace,
  }
}

function testRendererConversationListIgnoresRemovedSummaryUpdates(): void {
  const removedIds = new Set<string>(['conversation-deleted'])
  const deletedSummary = conversationSummary('conversation-deleted', 'Deleted', 10)
  const visibleSummary = conversationSummary('conversation-visible', 'Visible', 5)

  let conversations = mergeConversationSummaryUpdate(
    [deletedSummary, visibleSummary],
    deletedSummary,
    removedIds,
  )
  assert(
    !conversations.some((conversation) => conversation.id === 'conversation-deleted'),
    'removed conversation should be filtered immediately',
  )

  conversations = mergeConversationSummaryUpdate(
    conversations,
    {
      ...deletedSummary,
      updatedAt: 20,
      activity: {
        state: 'interrupted',
        title: 'Interrupted',
        updatedAt: 20,
        eventType: 'turn.interrupted',
        messageId: 'assistant-deleted',
      },
    },
    removedIds,
  )

  assertEqual(conversations.length, 1, 'late summary should not reinsert removed conversation')
  assertEqual(
    conversations[0]?.id,
    'conversation-visible',
    'visible conversation should remain after late removed update',
  )
}

function testRendererConversationListGroupsWorkspaceSessions(): void {
  const alpha: ConversationWorkspaceRef = {
    id: '/workspace/alpha',
    path: '/workspace/alpha',
    label: 'Alpha',
  }
  const beta: ConversationWorkspaceRef = {
    id: '/workspace/beta',
    path: '/workspace/beta',
    label: 'Beta',
  }
  const groups = groupConversationsByWorkspace([
    conversationSummary('general-old', 'General old', 5),
    workspaceConversationSummary('alpha-new', 'Alpha new', alpha, 30),
    workspaceConversationSummary('beta-only', 'Beta only', beta, 20),
    workspaceConversationSummary('alpha-old', 'Alpha old', alpha, 10),
    conversationSummary('general-new', 'General new', 25),
  ])
  const sections = buildConversationSidebarSections([
    conversationSummary('general-old', 'General old', 5),
    workspaceConversationSummary('alpha-new', 'Alpha new', alpha, 30),
    workspaceConversationSummary('beta-only', 'Beta only', beta, 20),
    workspaceConversationSummary('alpha-old', 'Alpha old', alpha, 10),
    conversationSummary('general-new', 'General new', 25),
  ])

  assertEqual(groups.length, 3, 'conversation list should group sessions by optional workspace')
  assertEqual(
    groups.map((group) => group.label).join(','),
    'Alpha,Beta,General',
    'workspace groups should sort by latest session update before the General group',
  )
  assertEqual(
    groups
      .find((group) => group.workspace?.id === alpha.id)
      ?.conversations.map((conversation) => conversation.id)
      .join(','),
    'alpha-new,alpha-old',
    'workspace group should keep same-workspace sessions together',
  )
  assertEqual(
    groups
      .find((group) => group.workspace === null)
      ?.conversations.map((conversation) => conversation.id)
      .join(','),
    'general-new,general-old',
    'sessions without workspace should stay in the General group',
  )
  assertEqual(
    sections.projects.map((project) => project.label).join(','),
    'Alpha,Beta',
    'Codex-style sidebar should render workspace sessions under Projects',
  )
  assertEqual(
    sections.chats.map((conversation) => conversation.id).join(','),
    'general-new,general-old',
    'Codex-style sidebar should render sessions without workspace under Chats',
  )
}

function testRendererFinishAppendsMissingAssistantMessage(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'FINISH',
    conversationId: 'conversation-finish',
    messageId: 'assistant-finish',
    message: {
      id: 'assistant-finish',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'final answer' }],
      status: 'done',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })

  const stream = state.streams.get('conversation-finish')
  assert(stream, 'finish should create a stream for late renderer events')
  assertEqual(stream.messages.length, 1, 'finish should append missing assistant message')
  assertEqual(stream.messages[0]?.id, 'assistant-finish', 'finish appended assistant id')
  assertEqual(stream.messages[0]?.status, 'done', 'finish appended assistant status')
}

function testRendererRunStartedDoesNotDuplicateFinishedAssistant(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'FINISH',
    conversationId: 'conversation-early-error',
    messageId: 'assistant-early-error',
    message: {
      id: 'assistant-early-error',
      role: 'assistant',
      blocks: [],
      status: 'error',
      error: 'workspace roots unavailable',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })
  state = reduceChatStreamsForTest(state, {
    type: 'RUN_STARTED',
    conversationId: 'conversation-early-error',
    userMessage: {
      id: 'user-early-error',
      role: 'user',
      blocks: [{ type: 'text', content: 'fail before stream starts' }],
      status: 'done',
    },
    assistantMessage: {
      id: 'assistant-early-error',
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  })

  const stream = state.streams.get('conversation-early-error')
  assert(stream, 'early error should create a stream')
  assertEqual(
    stream.messages.filter((message) => message.id === 'assistant-early-error').length,
    1,
    'RUN_STARTED should not duplicate an already finished assistant',
  )
  assertEqual(
    stream.messages.find((message) => message.id === 'assistant-early-error')?.status,
    'error',
    'RUN_STARTED should not downgrade an early error to streaming',
  )
  assertEqual(stream.messages[0]?.id, 'user-early-error', 'RUN_STARTED should preserve user order')
  assertEqual(
    stream.messages[1]?.id,
    'assistant-early-error',
    'RUN_STARTED should keep assistant after user',
  )
  assertEqual(stream.runningMessageId, null, 'early error should not become running')
}

function testRendererToolResultAppendsMissingAssistantMessage(): void {
  let state = createChatStreamsStateForTest()
  state = reduceChatStreamsForTest(state, {
    type: 'TOOL_CALL_RESULT',
    conversationId: 'conversation-tool',
    messageId: 'assistant-tool',
    toolCallId: 'tool-call',
    name: 'read_file',
    result: 'file contents',
    isError: false,
  })

  const stream = state.streams.get('conversation-tool')
  assert(stream, 'tool result should create a stream for late renderer events')
  assertEqual(stream.runningMessageId, 'assistant-tool', 'tool result running message id')
  const assistant = stream.messages[0]
  assertEqual(assistant?.id, 'assistant-tool', 'tool result assistant id')
  const block = assistant?.blocks[0]
  assertEqual(block?.type, 'tool_call', 'tool result should create a tool block')
  assertEqual(
    block?.type === 'tool_call' ? block.name : undefined,
    'read_file',
    'tool result should keep tool name',
  )
  assertEqual(
    block?.type === 'tool_call' ? block.status : undefined,
    'done',
    'tool result should mark tool done',
  )
}

async function testInterruptedActivityRecovery(): Promise<void> {
  await withTempDataDir(async () => {
    const running = await createConversation()
    await appendMessage(running.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'running-user',
      role: 'user',
      blocks: [{ type: 'text', content: 'recover interrupted running turn' }],
      status: 'done',
    })
    await appendRunEventAndTouchConversation(running.id, {
      timestamp: Date.now(),
      conversationId: running.id,
      messageId: 'running-assistant',
      type: 'turn.started',
    })

    const approval = await createConversation()
    await appendRunEventAndTouchConversation(approval.id, {
      timestamp: Date.now(),
      conversationId: approval.id,
      messageId: 'approval-assistant',
      type: 'tool.approval.requested',
      data: { toolName: 'write_file', requestId: 'approval-request' },
    })

    const completed = await createConversation()
    await appendRunEventAndTouchConversation(completed.id, {
      timestamp: Date.now(),
      conversationId: completed.id,
      messageId: 'completed-assistant',
      type: 'turn.completed',
    })

    const recovered = await recoverInterruptedConversationActivities('contract restart')
    assertEqual(recovered.length, 2, 'recovery should update active runtime activities only')

    const runningRecord = await getConversation(running.id)
    assertEqual(
      runningRecord.meta.activity?.state,
      'interrupted',
      'running activity should recover as interrupted',
    )
    assertEqual(
      runningRecord.meta.activity?.title,
      'Interrupted',
      'running recovery activity title',
    )
    assertEqual(
      runningRecord.meta.activity?.messageId,
      'running-assistant',
      'running recovery should keep assistant message id',
    )

    const approvalRecord = await getConversation(approval.id)
    assertEqual(
      approvalRecord.meta.activity?.state,
      'interrupted',
      'approval activity should recover as interrupted',
    )

    const completedRecord = await getConversation(completed.id)
    assertEqual(
      completedRecord.meta.activity?.state,
      'completed',
      'completed activity should not be recovered',
    )

    const events = await listRunEvents(running.id)
    assertEqual(events.at(-1)?.type, 'turn.interrupted', 'recovery should append event log entry')
    assertEqual(
      events.at(-1)?.data?.previousState,
      'running',
      'recovery event should include previous state',
    )
  })
}

async function testInterruptedActivityRecoveryRespectsSameTimestampAppendOrder(): Promise<void> {
  await withTempDataDir(async () => {
    const completed = await createConversation()
    const timestamp = Date.now()
    await appendRunEvent(completed.id, {
      timestamp,
      conversationId: completed.id,
      messageId: 'same-timestamp-assistant',
      type: 'turn.started',
    })
    await appendRunEvent(completed.id, {
      timestamp,
      conversationId: completed.id,
      messageId: 'same-timestamp-assistant',
      type: 'turn.completed',
    })

    const recovered = await recoverInterruptedConversationActivities('same timestamp restart')
    assert(
      !recovered.some((summary) => summary.id === completed.id),
      'same-timestamp completed turn should not recover as interrupted',
    )

    const events = await listRunEvents(completed.id)
    assertEqual(
      events.map((event) => event.type).join(','),
      'turn.started,turn.completed',
      'Desktop recovery should preserve same-timestamp append order',
    )
    assert(
      !events.some((event) => event.type === 'turn.interrupted'),
      'Desktop recovery should not append interrupted after same-timestamp completion',
    )
    assertEqual(
      (await getConversation(completed.id)).meta.activity?.state,
      'completed',
      'Desktop recovery should repair activity to completed from same-timestamp replay',
    )
  })
}

async function testToolApprovalsCanHydrateAndResolvePendingRequests(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const requested: ToolApprovalRequestPayload[] = []
    const resolved: ToolApprovalResolvedPayload[] = []
    const store = new ToolApprovalStore({
      timeoutMs: 1000,
      createId: () => 'approval-store-contract-id',
      recordRunEvent: appendRunEventAndTouchConversation,
      onRequest: (payload) => requested.push(payload),
      onResolved: (payload) => resolved.push(payload),
    })

    const approval = store.request({
      name: 'write_file',
      args: { path: '/workspace/note.md', content: 'approved write' },
      metadata: {
        name: 'write_file',
        readOnly: false,
        destructive: true,
        requiresApproval: true,
        access: ['write'],
        scope: ['workspace'],
      },
      conversationId: conversation.id,
      messageId: 'assistant-message',
      turnId: 'turn-approval',
      runId: 'run-approval',
      stepId: 'step-approval',
      toolCallId: 'tool-call',
    })

    assertEqual(requested.length, 1, 'approval store should emit request payload')
    assertEqual(
      requested[0]?.requestId,
      'approval-store-contract-id',
      'approval store should use injected request id',
    )
    const pending = store.list()
    assertEqual(pending.length, 1, 'approval store should list pending request')
    assertEqual(
      pending[0]?.requestId,
      requested[0]?.requestId,
      'listed approval should match emitted request',
    )
    assertEqual(pending[0]?.name, 'write_file', 'listed approval tool name')
    assert(
      typeof pending[0]?.requestedAt === 'number' && pending[0].requestedAt <= pending[0].expiresAt,
      'listed approval should include timing metadata',
    )

    store.resolve(requested[0]?.requestId ?? '', true, 'user')
    assertEqual(await approval, true, 'resolved approval promise')
    assertEqual(store.list().length, 0, 'resolved approval should leave pending list')
    await waitFor(() => resolved.length === 1, 'approval store should emit resolved payload')
    assertEqual(resolved[0]?.approved, true, 'resolved approval approved flag')
    assertEqual(resolved[0]?.reason, 'user', 'resolved approval reason')

    await store.flushActivity()
    const events = await listRunEvents(conversation.id)
    assertEqual(events[0]?.type, 'tool.approval.requested', 'approval requested event')
    assertEqual(events[0]?.turnId, 'turn-approval', 'approval event turn identity')
    assertEqual(events[0]?.runId, 'run-approval', 'approval event run identity')
    assertEqual(events[0]?.stepId, 'step-approval', 'approval event step identity')
    assertEqual(
      (events[0]?.data?.target as { preview?: unknown } | undefined)?.preview,
      '/workspace/note.md',
      'approval requested event should include target preview',
    )
    assertEqual(events[1]?.type, 'tool.approval.resolved', 'approval resolved event')
    assertEqual(events[1]?.data?.approved, true, 'approval resolved event approved flag')

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'running', 'approved activity state')
    assertEqual(record.meta.activity?.title, 'Approved: write_file', 'approved activity title')
  })
}

async function testToolApprovalStoreSnapshotsMutableBoundaries(): Promise<void> {
  const requested: ToolApprovalRequestPayload[] = []
  const recorded: Array<{ type: string; data?: Record<string, unknown> }> = []
  const store = new ToolApprovalStore({
    timeoutMs: 1000,
    recordRunEvent: (_conversationId, event) => {
      recorded.push({ type: event.type, data: event.data })
    },
    onRequest: (payload) => {
      requested.push(payload)
      payload.args.path = '/workspace/request-callback-mutated.md'
      const nested = payload.args.nested as { value: string }
      nested.value = 'request-callback-mutated'
      payload.metadata.access.push('shell')
    },
  })

  const request: Parameters<ToolApprovalStore['request']>[0] = {
    name: 'write_file',
    args: {
      path: '/workspace/original.md',
      content: 'original write',
      nested: { value: 'original' },
    },
    metadata: {
      name: 'write_file',
      readOnly: false,
      destructive: true,
      requiresApproval: true,
      access: ['write'],
      scope: ['workspace'],
    },
    conversationId: 'approval-snapshot-conversation',
    messageId: 'approval-snapshot-assistant',
    toolCallId: 'approval-snapshot-tool-call',
  }

  const approval = store.request(request)
  request.args.path = '/workspace/caller-mutated.md'
  const requestNested = request.args.nested as { value: string }
  requestNested.value = 'caller-mutated'
  request.metadata.access.push('shell')
  request.metadata.scope.push('external')
  request.metadata.destructive = false

  assertEqual(requested.length, 1, 'snapshot approval should emit request callback payload')

  const listed = store.list()
  assertEqual(listed.length, 1, 'snapshot approval should be pending')
  listed[0].args.path = '/workspace/list-mutated.md'
  const listedNested = listed[0].args.nested as { value: string }
  listedNested.value = 'list-mutated'
  listed[0].metadata.scope.push('external')

  const relisted = store.list()
  assertEqual(
    relisted[0]?.args.path,
    '/workspace/original.md',
    'approval list should return payload snapshots',
  )
  assertEqual(
    (relisted[0]?.args.nested as { value?: unknown } | undefined)?.value,
    'original',
    'approval list should isolate nested args',
  )
  assertEqual(
    relisted[0]?.metadata.access.includes('shell'),
    false,
    'approval request callback should not mutate pending metadata',
  )
  assertEqual(
    relisted[0]?.metadata.scope.includes('external'),
    false,
    'approval list mutation should not mutate pending metadata',
  )
  assertEqual(
    relisted[0]?.metadata.destructive,
    true,
    'caller metadata mutation should not mutate pending metadata',
  )

  store.resolve(relisted[0]?.requestId ?? '', true, 'user')
  assertEqual(await approval, true, 'snapshot approval promise should resolve')
  await store.flushActivity()

  assertEqual(recorded[0]?.type, 'tool.approval.requested', 'snapshot requested activity type')
  assertEqual(
    (recorded[0]?.data?.target as { preview?: unknown } | undefined)?.preview,
    '/workspace/original.md',
    'approval activity should use original target snapshot',
  )
  assert(
    String((recorded[0]?.data?.args as { preview?: unknown } | undefined)?.preview).includes(
      'original write',
    ),
    'approval activity should use original args snapshot',
  )
  assertEqual(
    ((recorded[0]?.data?.access as string[] | undefined) ?? []).includes('shell'),
    false,
    'approval activity should isolate metadata access from mutation',
  )
  assertEqual(
    ((recorded[0]?.data?.scope as string[] | undefined) ?? []).includes('external'),
    false,
    'approval activity should isolate metadata scope from mutation',
  )
  assertEqual(recorded[1]?.type, 'tool.approval.resolved', 'snapshot resolved activity type')
}

async function testToolApprovalStoreRequiresInjectedActivityRecorder(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const store = new ToolApprovalStore({
      timeoutMs: 1000,
    })

    const approval = store.request({
      name: 'write_file',
      args: { path: '/workspace/no-recorder.md', content: 'not persisted by default' },
      metadata: {
        name: 'write_file',
        readOnly: false,
        destructive: true,
        requiresApproval: true,
        access: ['write'],
        scope: ['workspace'],
      },
      conversationId: conversation.id,
      messageId: 'assistant-message',
      toolCallId: 'tool-call',
    })

    const requestId = store.list()[0]?.requestId
    assert(requestId, 'approval request should be pending')
    store.resolve(requestId, true, 'user')
    assertEqual(await approval, true, 'approval without recorder should resolve')
    await store.flushActivity()

    assertEqual(
      (await listRunEvents(conversation.id)).length,
      0,
      'approval store should not write conversation activity without an injected recorder',
    )
  })
}

async function testToolApprovalStoreUsesInjectedActivityRecorder(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const recorded: Array<{ conversationId: string; type: string }> = []
    const store = new ToolApprovalStore({
      timeoutMs: 1000,
      recordRunEvent: (conversationId, event) => {
        recorded.push({ conversationId, type: event.type })
      },
    })

    const approval = store.request({
      name: 'write_file',
      args: { path: '/workspace/custom.md', content: 'custom recorder' },
      metadata: {
        name: 'write_file',
        readOnly: false,
        destructive: true,
        requiresApproval: true,
        access: ['write'],
        scope: ['workspace'],
      },
      conversationId: conversation.id,
      messageId: 'assistant-message',
      toolCallId: 'tool-call',
    })

    const requestId = store.list()[0]?.requestId
    assert(requestId, 'approval request should be pending')
    store.resolve(requestId, true, 'user')
    assertEqual(await approval, true, 'custom recorder approval promise')
    await store.flushActivity()

    assertEqual(recorded.length, 2, 'custom recorder should receive requested and resolved events')
    assertEqual(
      recorded.map((event) => event.type).join(','),
      'tool.approval.requested,tool.approval.resolved',
      'custom recorder event order',
    )
    assertEqual(
      recorded.every((event) => event.conversationId === conversation.id),
      true,
      'custom recorder should receive conversation id',
    )
    assertEqual(
      (await listRunEvents(conversation.id)).length,
      0,
      'custom recorder should own any event persistence and fanout',
    )
  })
}

async function testToolApprovalTimeoutClearsPendingRequests(): Promise<void> {
  const resolved: ToolApprovalResolvedPayload[] = []
  const store = new ToolApprovalStore({
    timeoutMs: 10,
    onResolved: (payload) => resolved.push(payload),
  })

  const approval = store.request({
    name: 'run_shell',
    args: { command: 'echo timeout' },
    metadata: {
      name: 'run_shell',
      readOnly: false,
      destructive: false,
      requiresApproval: true,
      access: ['shell'],
      scope: ['workspace'],
    },
  })

  assertEqual(store.list().length, 1, 'timed approval should start pending')
  assertEqual(await approval, false, 'timed approval should resolve denied')
  assertEqual(store.list().length, 0, 'timed approval should clear pending list')
  await waitFor(() => resolved.length === 1, 'timed approval should emit resolved payload')
  assertEqual(resolved[0]?.approved, false, 'timed approval resolved approved flag')
  assertEqual(resolved[0]?.reason, 'timeout', 'timed approval resolved reason')
}

async function testToolApprovalCancellationClearsConversationRequests(): Promise<void> {
  await withTempDataDir(async () => {
    const cancelledConversation = await createConversation()
    const otherConversation = await createConversation()
    const resolved: ToolApprovalResolvedPayload[] = []
    const store = new ToolApprovalStore({
      timeoutMs: 1000,
      recordRunEvent: appendRunEventAndTouchConversation,
      onResolved: (payload) => resolved.push(payload),
    })

    const cancelledApproval = store.request({
      name: 'write_file',
      args: { path: '/workspace/cancelled.md', content: 'cancelled write' },
      metadata: {
        name: 'write_file',
        readOnly: false,
        destructive: true,
        requiresApproval: true,
        access: ['write'],
        scope: ['workspace'],
      },
      conversationId: cancelledConversation.id,
      messageId: 'cancelled-assistant',
      toolCallId: 'cancelled-tool-call',
    })
    const otherApproval = store.request({
      name: 'write_file',
      args: { path: '/workspace/other.md', content: 'other write' },
      metadata: {
        name: 'write_file',
        readOnly: false,
        destructive: true,
        requiresApproval: true,
        access: ['write'],
        scope: ['workspace'],
      },
      conversationId: otherConversation.id,
      messageId: 'other-assistant',
      toolCallId: 'other-tool-call',
    })

    assertEqual(
      store.resolveForConversation(cancelledConversation.id, false, 'cancelled'),
      1,
      'conversation cancellation should resolve matching approvals only',
    )
    assertEqual(await cancelledApproval, false, 'cancelled approval promise')
    assertEqual(store.list().length, 1, 'conversation cancellation should keep other approvals')
    assertEqual(
      store.list()[0]?.conversationId,
      otherConversation.id,
      'remaining approval conversation id',
    )
    await waitFor(() => resolved.length === 1, 'cancelled approval should emit resolved payload')
    assertEqual(resolved[0]?.approved, false, 'cancelled approval resolved approved flag')
    assertEqual(resolved[0]?.reason, 'cancelled', 'cancelled approval resolved reason')

    await store.flushActivity()
    const events = await listRunEvents(cancelledConversation.id)
    assertEqual(events.at(-1)?.type, 'tool.approval.resolved', 'cancelled approval event type')
    assertEqual(events.at(-1)?.data?.reason, 'cancelled', 'cancelled approval event reason')

    const record = await getConversation(cancelledConversation.id)
    assertEqual(record.meta.activity?.state, 'failed', 'cancelled approval activity state')
    assertEqual(record.meta.activity?.title, 'Denied: write_file', 'cancelled approval title')

    await store.shutdown()
    assertEqual(await otherApproval, false, 'shutdown should clear remaining approval')

    const shutdownEvents = await listRunEvents(otherConversation.id)
    assertEqual(
      shutdownEvents.at(-1)?.type,
      'tool.approval.resolved',
      'shutdown approval event type',
    )
    assertEqual(shutdownEvents.at(-1)?.data?.reason, 'shutdown', 'shutdown approval event reason')
    const shutdownRecord = await getConversation(otherConversation.id)
    assertEqual(shutdownRecord.meta.activity?.state, 'failed', 'shutdown approval activity state')
    assertEqual(
      shutdownRecord.meta.activity?.title,
      'Denied: write_file',
      'shutdown approval title',
    )
  })
}

function toolApprovalRequest(
  requestId: string,
  requestedAt: number,
  conversationId = 'conversation-approval-state',
): ToolApprovalRequestPayload {
  return {
    requestId,
    name: 'write_file',
    args: { path: '/workspace/state.md', content: 'pending write' },
    metadata: {
      name: 'write_file',
      readOnly: false,
      destructive: true,
      requiresApproval: true,
      access: ['write'],
      scope: ['workspace'],
    },
    conversationId,
    messageId: 'assistant-approval-state',
    toolCallId: 'tool-call-approval-state',
    requestedAt,
    expiresAt: requestedAt + 60_000,
  }
}

function testRendererApprovalHydrationDoesNotResurrectResolvedRequest(): void {
  const request = toolApprovalRequest('approval-stale-hydrate', 1)
  let state = createToolApprovalsState()
  state = mergeToolApprovals(state, [request])
  assertEqual(state.pending.length, 1, 'approval state should hydrate pending request')

  state = resolveToolApproval(state, request.requestId)
  assertEqual(state.pending.length, 0, 'approval state should clear resolved request')
  assertEqual(
    state.resolvedIds.has(request.requestId),
    true,
    'approval state should keep resolved tombstone',
  )

  state = mergeToolApprovals(state, [request])
  assertEqual(
    state.pending.length,
    0,
    'late approval hydration should not resurrect resolved request',
  )
}

function testRendererConversationApprovalClearDoesNotResurrectHydration(): void {
  const removedConversationId = 'conversation-approval-removed'
  const keptConversationId = 'conversation-approval-kept'
  const removedEarly = toolApprovalRequest('approval-removed-early', 1, removedConversationId)
  const removedLate = toolApprovalRequest('approval-removed-late', 3, removedConversationId)
  const kept = toolApprovalRequest('approval-kept', 2, keptConversationId)

  let state = createToolApprovalsState()
  state = mergeToolApprovals(state, [removedEarly, kept, removedLate])
  assertEqual(state.pending.length, 3, 'approval state should start with all pending requests')

  state = resolveToolApprovalsForConversation(state, removedConversationId)
  assertEqual(
    state.pending.length,
    1,
    'conversation approval clear should remove matching requests',
  )
  assertEqual(state.pending[0]?.requestId, kept.requestId, 'approval clear should keep other chats')
  assert(
    state.resolvedIds.has(removedEarly.requestId) && state.resolvedIds.has(removedLate.requestId),
    'conversation approval clear should tombstone removed requests',
  )

  state = mergeToolApprovals(state, [removedEarly, removedLate])
  assertEqual(
    state.pending.length,
    1,
    'late approval hydration should not resurrect removed conversation requests',
  )
  assertEqual(state.pending[0]?.requestId, kept.requestId, 'late hydration should keep other chat')
}

function testRendererApprovalHydrationSortsPendingRequests(): void {
  let state = createToolApprovalsState()
  state = mergeToolApprovals(state, [
    toolApprovalRequest('approval-late', 20),
    toolApprovalRequest('approval-early', 10),
  ])

  assertEqual(state.pending.length, 2, 'approval state should keep pending requests')
  assertEqual(
    state.pending[0]?.requestId,
    'approval-early',
    'approval state should sort oldest first',
  )
  assertEqual(
    state.pending[1]?.requestId,
    'approval-late',
    'approval state should sort newest last',
  )
}

async function main(): Promise<void> {
  await testWorkspaceConversationContext()
  await testDesktopWorkspaceRoots()
  await testDesktopMainUsesEsmSafeRuntimePaths()
  await testDesktopUsesSharedRuntimeFactory()
  await testDesktopExposesRuntimeStateApi()
  await testDesktopKeepsRunControlsOutOfChatCanvas()
  await testDesktopDoesNotExposeEmbeddedTerminalApi()
  await testRendererUsesRuntimeHydrationApi()
  await testDesktopExposesMcpIntegrationOAuthApi()
  await testConversationListContract()
  await testConversationDeleteCleansActivity()
  await testActivityUpdatesConversationSummary()
  await testActivityDeltaDoesNotTouchConversationSummary()
  await testStaleActivityDoesNotOverwriteNewerSummary()
  await testToolResultActivityKeepsToolName()
  testRendererHydratesActiveAssistantTurn()
  testRendererHydratesTerminalRuntimeReplayState()
  testRendererDoesNotTreatStaleActiveRuntimeReplayAsLive()
  testRendererHydratePreservesLocalStreamingMessages()
  testRendererHydrateReplacesStreamingWithPersistedTerminal()
  testRendererCompletedEventWaitsForFinishMessage()
  testRendererFailedEventFinalizesStreamingPlaceholder()
  testRendererInterruptedEventFinalizesStreamingPlaceholder()
  testRendererStaleFailureDoesNotDowngradeFinishedMessage()
  testRendererLateStartedEventDoesNotReviveFinishedMessage()
  testRendererLateStreamingPatchDoesNotMutateFinishedMessage()
  testRendererDropTombstonesLateStreamEvents()
  testRendererDropClearsQueueAndBlocksFutureActions()
  testRendererConversationListIgnoresRemovedSummaryUpdates()
  testRendererConversationListGroupsWorkspaceSessions()
  testRendererFinishAppendsMissingAssistantMessage()
  testRendererRunStartedDoesNotDuplicateFinishedAssistant()
  testRendererToolResultAppendsMissingAssistantMessage()
  await testInterruptedActivityRecovery()
  await testInterruptedActivityRecoveryRespectsSameTimestampAppendOrder()
  await testToolApprovalsCanHydrateAndResolvePendingRequests()
  await testToolApprovalStoreSnapshotsMutableBoundaries()
  await testToolApprovalStoreRequiresInjectedActivityRecorder()
  await testToolApprovalStoreUsesInjectedActivityRecorder()
  await testToolApprovalTimeoutClearsPendingRequests()
  await testToolApprovalCancellationClearsConversationRequests()
  testRendererApprovalHydrationDoesNotResurrectResolvedRequest()
  testRendererConversationApprovalClearDoesNotResurrectHydration()
  testRendererApprovalHydrationSortsPendingRequests()
  console.log('desktop workbench contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
