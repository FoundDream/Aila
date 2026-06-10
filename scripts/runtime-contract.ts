import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runtimeSdk from '@aila/agent'
import * as runtimeCoreSdk from '@aila/agent'
import {
  type AgentEvent,
  AgentRuntime,
  type AgentRuntimeEvent,
  type AgentRuntimeHost,
  type AgentRuntimeStore,
  type ChatMessage,
  AILA_RUNTIME_EVENT_SCHEMA_VERSION,
  AILA_RUNTIME_EVENT_TYPES,
  AILA_SKILL_FILE,
  createInMemoryRuntimeStore,
  createInterruptedConversationRecoveryEvent,
  createRuntimeEvent,
  isRuntimeEventType,
  parseSkillDocument,
  type RuntimeAttachmentBlock,
  type RuntimePersistAttachmentInput,
  type RuntimeRecordAgentEventInput,
  replayConversationActivity,
  replayConversationRuntimeState,
  requestToolApprovalWithActivity,
  type Settings,
  SKILL_TOOL_NAME,
  type ToolApprovalRequest,
  type ToolFileSystem,
  type ToolPack,
  type ToolShellRequest,
  type ToolWebSearchRequest,
} from '@aila/agent'
import * as runtimePackageNodeSdk from '@aila/agent/node'
import * as runtimeInternalSdk from '../packages/agent/src/internal'
import {
  createDefaultToolRegistry,
  executeTool,
  getToolDefinitions,
  summarizeToolTarget,
} from '../packages/agent/src/internal'
import * as runtimeNodeSdk from '../src/main/agent-host'
import {
  AILA_TOOL_PACK_MANIFEST_FILE,
  AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION,
  configureDataDir,
  createPersistedRuntimeStore,
  getConversationsDir,
  getExtensionReport,
  getImagesDir,
  getSkillsDir,
  getToolPacksDir,
  loadSkillFromDir,
  loadSkillsFromDir,
  loadToolPacksFromDir,
} from '../src/main/agent-host'
import {
  AILA_AGENT_EVENT_SCHEMA_VERSION,
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  appendAgentEvent,
  appendAgentEventAndTouchConversation,
  appendMessage,
  type ConversationRecord,
  type ConversationSummary,
  createConversation,
  deleteConversation,
  getConversation,
  listAgentEvents,
  listConversations,
  type PersistedAgentEvent,
  recoverInterruptedConversationActivities,
  setConversationUsage,
  upsertMessage,
} from '../src/main/conversations'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

async function withTempDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'aila-runtime-contract-'))
  try {
    configureDataDir(dir)
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function testRuntimeEventContract(): Promise<void> {
  assertEqual(AILA_RUNTIME_EVENT_SCHEMA_VERSION, 1, 'runtime event schema version changed')
  assertEqual(
    new Set(AILA_RUNTIME_EVENT_TYPES).size,
    AILA_RUNTIME_EVENT_TYPES.length,
    'runtime event types must be unique',
  )
  for (const type of AILA_RUNTIME_EVENT_TYPES) {
    assert(isRuntimeEventType(type), `runtime event type should decode: ${type}`)
  }
  assert(!isRuntimeEventType('chat:unknown'), 'unknown runtime event type should be rejected')

  const event = createRuntimeEvent('chat:text-delta', {
    conversationId: 'conversation',
    messageId: 'message',
    delta: 'hello',
  })
  assertEqual(event.schemaVersion, AILA_RUNTIME_EVENT_SCHEMA_VERSION, 'event version')
  assertEqual(event.type, 'chat:text-delta', 'event type')
  assertEqual(event.data.delta, 'hello', 'event data')
}

async function testRuntimeEmitsVersionedEvents(): Promise<void> {
  await withTempDataDir(async () => {
    const events: AgentRuntimeEvent[] = []
    const runtime = new AgentRuntime({
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
    })
    const conversation = await runtime.createConversation()

    await runtime.send({
      conversationId: conversation.id,
      userText: 'runtime contract smoke',
      selection: { providerId: 'openrouter', modelId: 'minimax/minimax-m3' },
    })

    await waitFor(
      () => events.some((event) => event.type === 'chat:error'),
      'runtime did not emit expected hostless stream error event',
    )
    await runtime.abortAll()

    assert(events.length >= 2, 'runtime should emit persistence and error events')
    for (const event of events) {
      assertEqual(event.schemaVersion, AILA_RUNTIME_EVENT_SCHEMA_VERSION, 'runtime event version')
      assert(isRuntimeEventType(event.type), `runtime emitted unknown event type: ${event.type}`)
    }
  })
}

async function testRuntimeWithoutStreamHostFailsAtSetupBoundary(): Promise<void> {
  await withTempDataDir(async () => {
    const events: AgentRuntimeEvent[] = []
    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
    })
    const conversation = await createConversation()

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'stream host missing',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'hostless setup failure should settle',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.messages.length, 2, 'hostless runtime should persist user and assistant')
    assertEqual(record.messages[0]?.role, 'user', 'hostless setup user role')
    assertEqual(record.messages[1]?.id, result.assistantMessageId, 'hostless setup assistant id')
    assertEqual(record.messages[1]?.status, 'error', 'hostless setup assistant status')
    assertEqual(
      record.messages[1]?.error,
      'runtime host cannot stream chat',
      'hostless setup assistant error',
    )
    assert(
      events.some(
        (event) =>
          event.type === 'agent:event' &&
          event.data.type === 'turn.failed' &&
          event.data.data?.phase === 'setup' &&
          event.data.data.error === 'runtime host cannot stream chat',
      ),
      'hostless runtime should record a setup failure activity',
    )
    assert(
      events.some(
        (event) =>
          event.type === 'chat:error' &&
          event.data.messageId === result.assistantMessageId &&
          event.data.error === 'runtime host cannot stream chat',
      ),
      'hostless runtime should emit a setup chat:error',
    )
  })
}

async function testRuntimeHostBoundaryContract(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    let streamStarted = false
    let policyRequested = false
    let approvalRequested = false
    let approvalResult = false
    let abortConversationId: string | null = null
    let abortReason: string | null = null
    let workspaceRootPath: string | null = null
    let workspaceRootLabel: string | null = null
    let fileSystemPassed = false
    let shellCwdPath: string | null = null
    let shellRunnerPassed = false
    let settingsLoaded = false
    let streamSettingsKey: string | null = null
    let activeSelectionModelIdDuringStream: string | null = null
    let runtime: AgentRuntime | undefined
    const runShell: AgentRuntimeHost['runShell'] = async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
    const fileSystem: ToolFileSystem = {
      readTextFile: async () => '',
      writeTextFile: async () => {},
    }

    const host: AgentRuntimeHost = {
      onEvent: (event) => events.push(event),
      onToolPolicy: async (request) => {
        policyRequested = request.name === 'write_file'
        return { action: 'ask', reason: 'host policy fixture' }
      },
      onToolApproval: async (request) => {
        approvalRequested = request.name === 'write_file'
        return true
      },
      onConversationAbort: (conversationId, reason) => {
        abortConversationId = conversationId
        abortReason = reason
      },
      loadSettings: () => {
        settingsLoaded = true
        return { apiKeys: { openrouter: 'host-openrouter-key' }, defaultModel: null }
      },
      workspaceRoots: () => [{ path: '/host/workspace', label: 'host-root' }],
      fileSystem,
      shellCwd: () => '/host/shell',
      runShell,
      streamChat: async (req, handlers) => {
        fileSystemPassed = req.fileSystem === fileSystem
        shellCwdPath = req.shellCwd ?? null
        shellRunnerPassed = req.runShell === runShell
        streamSettingsKey = req.settings?.apiKeys.openrouter ?? null
        req.selection.modelId = 'host-mutated-model'
        activeSelectionModelIdDuringStream =
          runtime?.listActiveStreams()[0]?.selection.modelId ?? null
        const [root] = req.workspaceRoots ?? []
        if (root && typeof root !== 'string') {
          workspaceRootPath = root.path
          workspaceRootLabel = root.label ?? null
        }
        const policyDecision = await req.onToolPolicy?.({
          name: 'write_file',
          args: { path: '/host/workspace/file.md', content: 'approved' },
          metadata: {
            name: 'write_file',
            readOnly: false,
            destructive: true,
            requiresApproval: true,
            access: ['write'],
            scope: ['workspace'],
          },
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          toolCallId: 'host-tool-call',
        })
        approvalResult =
          policyDecision?.action === 'ask' &&
          (await req.onToolApproval?.({
            name: 'write_file',
            args: { path: '/host/workspace/file.md', content: 'approved' },
            metadata: {
              name: 'write_file',
              readOnly: false,
              destructive: true,
              requiresApproval: true,
              access: ['write'],
              scope: ['workspace'],
            },
            conversationId: req.conversationId,
            messageId: req.assistantMessageId,
            toolCallId: 'host-tool-call',
          })) === true
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: {},
        })
        streamStarted = true
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve()
            return
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
      },
      logger: { warn() {}, error() {} },
    }
    runtime = new AgentRuntime({ store: createPersistedRuntimeStore(), host })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'exercise host boundary',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await waitFor(() => streamStarted, 'host streamChat should start')
    await runtime.abort(conversation.id)

    assertEqual(settingsLoaded, true, 'host settings loader should be called')
    assertEqual(
      streamSettingsKey,
      'host-openrouter-key',
      'host settings should be passed to streamChat',
    )
    assertEqual(workspaceRootPath, '/host/workspace', 'host workspace root path')
    assertEqual(workspaceRootLabel, 'host-root', 'host workspace root label')
    assertEqual(fileSystemPassed, true, 'host filesystem should pass to streamChat')
    assertEqual(shellCwdPath, '/host/shell', 'host shell cwd should pass to streamChat')
    assertEqual(shellRunnerPassed, true, 'host shell runner should pass to streamChat')
    assertEqual(
      activeSelectionModelIdDuringStream,
      'contract/mock',
      'host stream request mutation should not affect active stream selection',
    )
    assertEqual(policyRequested, true, 'host tool policy should receive tool request')
    assertEqual(approvalRequested, true, 'host tool approval should receive tool request')
    assertEqual(approvalResult, true, 'host tool approval should resolve request')
    assertEqual(abortConversationId, conversation.id, 'host abort cleanup conversation id')
    assertEqual(abortReason, 'user', 'host abort cleanup reason')
    assert(
      events.some((event) => event.type === 'agent:event' && event.data.type === 'turn.cancelled'),
      'host onEvent should receive runtime events',
    )
    assert(
      events.some(
        (event) =>
          event.type === 'agent:event' &&
          event.data.type === 'turn.started' &&
          event.data.data?.modelId === 'contract/mock',
      ),
      'runtime should fill turn selection from its own snapshot',
    )
    assertEqual(runtime.listActiveStreams().length, 0, 'host aborted stream should settle')
  })
}

async function testRuntimeSettingsFallbackIsHostAgnostic(): Promise<void> {
  await withTempDataDir(async () => {
    const previousOpenRouterKey = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'env-key-must-not-leak-into-runtime'
    try {
      const conversation = await createConversation()
      let streamStarted = false
      let streamSettingsKey: string | null | undefined
      let streamDefaultModel: Settings['defaultModel'] | undefined
      const runtime = new AgentRuntime({
        store: createPersistedRuntimeStore(),
        streamChat: async (req, handlers) => {
          streamSettingsKey = req.settings?.apiKeys.openrouter
          streamDefaultModel = req.settings?.defaultModel
          streamStarted = true
          await handlers.onError({
            conversationId: req.conversationId,
            messageId: req.assistantMessageId,
            error: 'settings fallback contract',
            message: {
              schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
              id: req.assistantMessageId,
              role: 'assistant',
              blocks: [],
              status: 'error',
              error: 'settings fallback contract',
              model: req.selection,
            },
          })
        },
        logger: { warn() {}, error() {} },
      })

      await runtime.send({
        conversationId: conversation.id,
        userText: 'exercise runtime settings fallback',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      })
      await waitFor(() => streamStarted, 'runtime settings fallback stream should start')

      assertEqual(
        streamSettingsKey,
        undefined,
        'runtime without host settings must not read provider keys from env',
      )
      assertEqual(streamDefaultModel, null, 'runtime fallback settings should be empty')
    } finally {
      if (previousOpenRouterKey === undefined) {
        delete process.env.OPENROUTER_API_KEY
      } else {
        process.env.OPENROUTER_API_KEY = previousOpenRouterKey
      }
    }
  })
}

async function testRuntimeStreamAndModelInfoUseHostBoundary(): Promise<void> {
  const conversationId = 'stream-model-info-host-boundary'
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'stream model info host boundary',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let modelInfoSelectionModel: string | null = null
  let streamSelectionModel: string | null = null
  let streamReached = false

  const runtime = new AgentRuntime({
    store: {
      getConversation: async () => record,
      saveMessage: async (_id, message) => {
        const index = record.messages.findIndex((current) => current.id === message.id)
        record =
          index >= 0
            ? {
                ...record,
                messages: record.messages.map((current, currentIndex) =>
                  currentIndex === index ? message : current,
                ),
              }
            : { ...record, messages: [...record.messages, message] }
        return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
      },
      recordAgentEvent: async (_id, event) => ({
        event: {
          ...event,
          schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
        },
        summary: { ...summary, updatedAt: summary.updatedAt + record.messages.length + 1 },
      }),
      recordUsage: async () => {
        throw new Error('stream model-info host boundary should not persist usage')
      },
      deleteConversation: async () => {
        throw new Error('stream model-info host boundary should not delete conversation')
      },
    },
    getModelInfo: (selection) => {
      modelInfoSelectionModel = selection.modelId
      selection.modelId = 'host-mutated-model-info-selection'
      return { model: 'Host Model Fixture', contextLength: 8_000 }
    },
    streamChat: async (req, handlers) => {
      streamReached = true
      streamSelectionModel = req.selection.modelId
      req.selection.modelId = 'host-mutated-stream-selection'
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'streamed through injected host boundary' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
    logger: { warn() {}, error() {} },
  })

  const result = await runtime.send({
    conversationId,
    userText: 'use host stream and model info',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await waitFor(() => runtime.listActiveStreams().length === 0, 'host stream should settle')

  assertEqual(streamReached, true, 'runtime should use injected host streamChat')
  assertEqual(
    modelInfoSelectionModel,
    'contract/mock',
    'runtime should resolve model info through host',
  )
  assertEqual(
    streamSelectionModel,
    'contract/mock',
    'host model-info mutation must not affect stream selection',
  )
  assertEqual(
    runtime.listActiveStreams().length,
    0,
    'host stream mutation must not leave active streams behind',
  )
  const assistant = record.messages.find((message) => message.id === result.assistantMessageId)
  assertEqual(assistant?.status, 'done', 'host stream should persist assistant completion')
  assertEqual(
    result.userMessage.blocks[0]?.type === 'text' ? result.userMessage.blocks[0].content : '',
    'use host stream and model info',
    'runtime should return a user message snapshot',
  )
}

async function testRuntimeAttachmentPersistenceUsesHostBoundary(): Promise<void> {
  const conversationId = 'attachment-host-boundary'
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'attachment host boundary',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let streamedUserContent: unknown = null
  const persistedInputs: RuntimePersistAttachmentInput[] = []
  const attachments = [
    {
      kind: 'text' as const,
      name: 'notes.txt',
      mime: 'text/plain',
      data: 'hello from the text attachment',
    },
    {
      kind: 'image' as const,
      name: 'screen.png',
      mime: 'image/png',
      data: Buffer.from('host-boundary-image').toString('base64'),
    },
  ]

  const store: AgentRuntimeStore = {
    getConversation: async (id) => {
      if (id !== conversationId) throw new Error(`unexpected conversation: ${id}`)
      return record
    },
    saveMessage: async (_id, message) => {
      const index = record.messages.findIndex((current) => current.id === message.id)
      record =
        index >= 0
          ? {
              ...record,
              messages: record.messages.map((current, currentIndex) =>
                currentIndex === index ? message : current,
              ),
            }
          : { ...record, messages: [...record.messages, message] }
      return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
    },
    recordAgentEvent: async (_id, event) => ({
      event: {
        ...event,
        schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      },
      summary: { ...summary, updatedAt: summary.updatedAt + record.messages.length + 1 },
    }),
    recordUsage: async () => {
      throw new Error('attachment host boundary should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('attachment host boundary should not delete conversation')
    },
  }

  const runtime = new AgentRuntime({
    store,
    persistAttachment: async (input) => {
      persistedInputs.push({ ...input })
      input.name = 'host-mutated-name'
      if (input.kind === 'image') {
        return {
          type: 'image',
          url: `aila-image://i/host-${input.conversationId}.png`,
          mime: input.mime,
        }
      }
      return { type: 'file', name: 'host-notes.txt', content: `${input.data}\nfrom host` }
    },
    streamChat: async (req, handlers) => {
      for (const message of req.messages) {
        if (message.role === 'user') streamedUserContent = message.content
      }
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'attachment host boundary done' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
    logger: { warn() {}, error() {} },
  })

  await runtime.send({
    conversationId,
    userText: 'send attachments through host',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    attachments,
  })
  await waitFor(() => runtime.listActiveStreams().length === 0, 'attachment stream should settle')

  assertEqual(
    attachments[0]?.name,
    'notes.txt',
    'runtime should isolate caller attachments from host mutation',
  )
  assertEqual(persistedInputs.length, 2, 'host should receive every attachment')
  assertEqual(
    persistedInputs.map((input) => `${input.conversationId}:${input.kind}`).join(','),
    `${conversationId}:text,${conversationId}:image`,
    'host attachment inputs should include conversation id and preserve order',
  )

  const userMessage = record.messages.find((message) => message.role === 'user')
  assert(userMessage, 'runtime should persist the user message with attachments')
  assertEqual(userMessage.blocks.length, 3, 'persisted user should include text and attachments')
  assertEqual(userMessage.blocks[1]?.type, 'file', 'text attachment becomes file block')
  assertEqual(
    userMessage.blocks[1]?.type === 'file' ? userMessage.blocks[1].name : '',
    'host-notes.txt',
    'runtime should persist the host-returned file block',
  )
  assertEqual(userMessage.blocks[2]?.type, 'image', 'image attachment becomes image block')
  assertEqual(
    userMessage.blocks[2]?.type === 'image' ? userMessage.blocks[2].url : '',
    `aila-image://i/host-${conversationId}.png`,
    'runtime should persist the host-returned image block',
  )

  assert(Array.isArray(streamedUserContent), 'image attachments should produce multimodal content')
  const streamedJson = JSON.stringify(streamedUserContent)
  assert(
    streamedJson.includes('hello from the text attachment') &&
      streamedJson.includes(`aila-image://i/host-${conversationId}.png`),
    'streamed context should include host-persisted file text and image url',
  )
}

async function testRuntimeTextAttachmentFallbackIsHostAgnostic(): Promise<void> {
  const conversationId = 'text-attachment-fallback'
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'text attachment fallback',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let streamedUserContent = ''

  const store: AgentRuntimeStore = {
    getConversation: async () => record,
    saveMessage: async (_id, message) => {
      record = { ...record, messages: [...record.messages, message] }
      return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
    },
    recordAgentEvent: async (_id, event) => ({
      event: { ...event, schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION },
      summary,
    }),
    recordUsage: async () => {
      throw new Error('text attachment fallback should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('text attachment fallback should not delete conversation')
    },
  }

  const runtime = new AgentRuntime({
    store,
    streamChat: async (req, handlers) => {
      const user = req.messages.find(
        (message): message is { role: 'user'; content: string } =>
          message.role === 'user' && typeof message.content === 'string',
      )
      streamedUserContent = user?.content ?? ''
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'text fallback done' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
    logger: { warn() {}, error() {} },
  })

  await runtime.send({
    conversationId,
    userText: 'plain text with attachment',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    attachments: [
      { kind: 'text', name: 'plain.txt', mime: 'text/plain', data: 'fallback attachment content' },
    ],
  })
  await waitFor(
    () => runtime.listActiveStreams().length === 0,
    'text fallback attachment stream should settle',
  )

  const userMessage = record.messages.find((message) => message.role === 'user')
  assert(userMessage, 'runtime should persist text attachment fallback user message')
  assertEqual(userMessage.blocks[1]?.type, 'file', 'text attachments should not require a host')
  assertEqual(
    userMessage.blocks[1]?.type === 'file' ? userMessage.blocks[1].content : '',
    'fallback attachment content',
    'text attachment fallback should persist file content',
  )
  assert(
    streamedUserContent.includes('fallback attachment content'),
    'text attachment fallback should be present in streamed context',
  )
}

async function testRuntimeImageAttachmentRequiresHostBoundary(): Promise<void> {
  const conversationId = 'image-attachment-requires-host'
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'image attachment requires host',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let streamReached = false

  const runtime = new AgentRuntime({
    store: {
      getConversation: async () => record,
      saveMessage: async (_id, message) => {
        record = { ...record, messages: [...record.messages, message] }
        return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
      },
      recordAgentEvent: async (_id, event) => ({
        event: { ...event, schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION },
        summary,
      }),
      recordUsage: async () => {
        throw new Error('image attachment boundary should not persist usage')
      },
      deleteConversation: async () => {
        throw new Error('image attachment boundary should not delete conversation')
      },
    },
    streamChat: async () => {
      streamReached = true
    },
    logger: { warn() {}, error() {} },
  })

  try {
    await runtime.send({
      conversationId,
      userText: 'image without host',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      attachments: [
        {
          kind: 'image',
          name: 'missing-host.png',
          mime: 'image/png',
          data: Buffer.from('missing-host').toString('base64'),
        },
      ],
    })
    throw new Error('image attachment without host unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('runtime host cannot persist image'),
      'runtime should reject image attachments when no host persistence boundary exists',
    )
  }

  assertEqual(streamReached, false, 'image attachment rejection should not start streamChat')
  assertEqual(record.messages.length, 0, 'image attachment rejection should not persist user input')
}

async function testRuntimeRejectsInvalidHostAttachmentBlocks(): Promise<void> {
  const conversationId = 'invalid-host-attachment-block'
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'invalid host attachment block',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }

  const runtime = new AgentRuntime({
    store: {
      getConversation: async () => record,
      saveMessage: async (_id, message) => {
        record = { ...record, messages: [...record.messages, message] }
        return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
      },
      recordAgentEvent: async (_id, event) => ({
        event: { ...event, schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION },
        summary,
      }),
      recordUsage: async () => {
        throw new Error('invalid attachment block should not persist usage')
      },
      deleteConversation: async () => {
        throw new Error('invalid attachment block should not delete conversation')
      },
    },
    persistAttachment: async () =>
      ({ type: 'tool_call', id: 'bad-block' }) as unknown as RuntimeAttachmentBlock,
    logger: { warn() {}, error() {} },
  })

  try {
    await runtime.send({
      conversationId,
      userText: 'invalid host block',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      attachments: [{ kind: 'text', name: 'bad.txt', mime: 'text/plain', data: 'bad block' }],
    })
    throw new Error('invalid host attachment block unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('unsupported attachment block'),
      'runtime should reject unsupported host attachment block types',
    )
  }

  assertEqual(record.messages.length, 0, 'invalid host block should not persist user input')
}

async function testRuntimeHostStaticExtensionContract(): Promise<void> {
  const topLevelPack: ToolPack = {
    id: 'top-level-static-pack',
    name: 'Top Level Static Pack',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'top_level_static_tool',
            description: 'Top-level fixture tool.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          metadata: {
            name: 'top_level_static_tool',
            readOnly: true,
            destructive: false,
            requiresApproval: false,
            access: ['read'],
            scope: ['workspace'],
          },
        },
        async run() {
          return 'top-level'
        },
      },
    ],
  }
  const hostPack: ToolPack = {
    id: 'host-static-pack',
    name: 'Host Static Pack',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'host_static_tool',
            description: 'Host fixture tool.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          metadata: {
            name: 'host_static_tool',
            readOnly: true,
            destructive: false,
            requiresApproval: false,
            access: ['read'],
            scope: ['workspace'],
          },
        },
        async run() {
          return 'host'
        },
      },
    ],
  }
  const topLevelToolPacks = [topLevelPack]
  const hostToolPacks = [hostPack]

  const runtime = new AgentRuntime({
    toolPacks: topLevelToolPacks,
    host: {
      toolPacks: hostToolPacks,
    },
  })
  hostPack.tools[0] = {
    ...hostPack.tools[0],
    spec: {
      ...hostPack.tools[0].spec,
      metadata: {
        ...hostPack.tools[0].spec.metadata,
      },
    },
  }
  hostToolPacks.push(topLevelPack)

  const registry = await runtime.getToolRegistry()
  assert(
    registry.specsByName.has('host_static_tool'),
    'host static tool packs should be part of the runtime host boundary',
  )
  assert(
    getToolDefinitions(registry).some(
      (definition) => definition.function.name === 'host_static_tool',
    ),
    'host static tool packs should be snapped at runtime construction',
  )
  assert(
    !registry.specsByName.has('top_level_static_tool'),
    'host static tool packs should take precedence over top-level compatibility tool packs',
  )
  registry.specsByName.delete('host_static_tool')
  registry.specs.length = 0
  const registryAgain = await runtime.getToolRegistry()
  assert(
    getToolDefinitions(registryAgain).some(
      (definition) => definition.function.name === 'host_static_tool',
    ),
    'runtime should return tool registry snapshots to callers',
  )
}

async function testRuntimeDynamicExtensionLoaderSnapshots(): Promise<void> {
  const loadedPack: ToolPack = {
    id: 'dynamic-snapshot-pack',
    name: 'Dynamic Snapshot Pack',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'dynamic_snapshot_tool',
            description: 'Loaded tool snapshot fixture.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          metadata: {
            name: 'dynamic_snapshot_tool',
            readOnly: true,
            destructive: false,
            requiresApproval: false,
            access: ['read'],
            scope: ['workspace'],
          },
        },
        async run() {
          return 'dynamic'
        },
      },
    ],
  }
  const runtime = new AgentRuntime({
    loadToolPacks: async () => [loadedPack],
    logger: { warn() {}, error() {} },
  })

  const registry = await runtime.getToolRegistry()
  registry.specsByName.delete('dynamic_snapshot_tool')
  registry.specs.length = 0

  loadedPack.tools[0] = {
    ...loadedPack.tools[0],
    spec: {
      ...loadedPack.tools[0].spec,
      metadata: {
        ...loadedPack.tools[0].spec.metadata,
      },
    },
  }

  assert(
    getToolDefinitions(await runtime.getToolRegistry()).some(
      (definition) => definition.function.name === 'dynamic_snapshot_tool',
    ),
    'dynamic loaded tool packs should be snapped when loaded and returned as caller snapshots',
  )
}

async function testRuntimeInjectableStoreContract(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const calls: string[] = []
    const store: AgentRuntimeStore = {
      getConversation: async (conversationId) => {
        calls.push(`get:${conversationId}`)
        return getConversation(conversationId)
      },
      saveMessage: async (conversationId, message) => {
        calls.push(`upsert:${message.role}:${message.id}`)
        return upsertMessage(conversationId, message)
      },
      recordAgentEvent: async (conversationId, event) => {
        calls.push(`event:${event.type}`)
        return appendAgentEventAndTouchConversation(conversationId, event)
      },
      recordUsage: async (conversationId, usage) => {
        calls.push(`usage:${usage.totalTokens}`)
        return setConversationUsage(conversationId, usage)
      },
      deleteConversation: async (conversationId) => {
        calls.push(`delete:${conversationId}`)
        return deleteConversation(conversationId)
      },
    }
    const runtime = new AgentRuntime({
      store,
      logger: { warn() {}, error() {} },
      streamChat: async (req, handlers) => {
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
          data: { outputBlockCount: 1 },
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'stored through injected runtime store' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'use injectable store',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'injected store stream should settle',
    )

    assert(
      calls.some((call) => call.startsWith('upsert:user:')),
      'runtime should persist user through injected store',
    )
    assert(
      calls.some((call) => call.startsWith('upsert:assistant:')),
      'runtime should persist assistant through injected store',
    )
    assert(calls.includes('event:turn.started'), 'runtime should append start event through store')
    assert(
      calls.includes('event:turn.completed'),
      'runtime should append terminal event through store',
    )
    assertEqual(calls.includes('usage:8'), true, 'runtime should persist usage through store')

    const record = await getConversation(conversation.id)
    assertEqual(record.messages.length, 2, 'injected store should preserve persisted messages')
    assertEqual(record.meta.usage?.totalTokens, 8, 'injected store should preserve usage')

    await runtime.deleteConversation(conversation.id)
    assert(
      calls.includes(`delete:${conversation.id}`),
      'runtime should delete conversation through injected store',
    )
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'injected store delete should remove persisted conversation',
    )
  })
}

async function testRuntimeHostTransientContextUsesInjectedRecord(): Promise<void> {
  const conversationId = 'transient-context-contract'
  const calls: string[] = []
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'transient context',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let streamedContext: string | null = null
  let streamedUserMessages: string[] = []

  const store: AgentRuntimeStore = {
    getConversation: async (id) => {
      calls.push(`get:${id}`)
      if (id !== conversationId) throw new Error(`unexpected conversation: ${id}`)
      return record
    },
    saveMessage: async (_id, message) => {
      calls.push(`upsert:${message.role}`)
      record = { ...record, messages: [...record.messages, message] }
      return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
    },
    recordAgentEvent: async (_id, event) => {
      calls.push(`event:${event.type}`)
      return {
        event: {
          ...event,
          schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
        },
        summary: { ...summary, updatedAt: summary.updatedAt + record.messages.length + 1 },
      }
    },
    recordUsage: async () => {
      throw new Error('transient context contract should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('transient context contract should not delete conversation')
    },
  }

  const runtime = new AgentRuntime({
    store,
    loadTransientContext: ({ record: inputRecord, source }) => {
      const messageCount = inputRecord.messages.length
      calls.push(`context:${source}:${messageCount}`)
      inputRecord.messages.push({
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: 'host-mutated-record-message',
        role: 'user',
        blocks: [{ type: 'text', content: 'host mutated record' }],
        status: 'done',
      })
      return [
        {
          role: 'system',
          content: `host context for ${inputRecord.meta.id} with ${messageCount} messages`,
        },
      ]
    },
    streamChat: async (req, handlers) => {
      streamedContext =
        req.messages.find(
          (message): message is { role: 'system'; content: string } =>
            message.role === 'system' && message.content.includes('host context for'),
        )?.content ?? null
      streamedUserMessages = req.messages
        .filter((message): message is { role: 'user'; content: string } => message.role === 'user')
        .map((message) => message.content)
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'used host transient context' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
    logger: { warn() {}, error() {} },
  })

  await runtime.send({
    conversationId,
    userText: 'use host transient context',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await waitFor(
    () => runtime.listActiveStreams().length === 0,
    'transient context stream should settle',
  )

  assert(calls.includes(`get:${conversationId}`), 'runtime should load record through store')
  assert(
    calls.includes('context:send:1'),
    'host transient context should receive the post-user-message record',
  )
  assertEqual(
    streamedContext,
    `host context for ${conversationId} with 1 messages`,
    'host transient context should be passed to streamChat',
  )
  assert(
    !streamedUserMessages.includes('host mutated record'),
    'host transient context should not mutate streamed persisted messages through input record',
  )
  assertEqual(record.messages.length, 2, 'host transient context should not mutate store record')
}

async function testRuntimeHostStableInstructionsUsesInjectedRecord(): Promise<void> {
  const conversationId = 'stable-instructions-contract'
  const calls: string[] = []
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'stable instructions',
    createdAt: 1,
    updatedAt: 1,
  }
  let record: ConversationRecord = { meta: summary, messages: [] }
  let streamedMessages: ChatMessage[] = []
  let stableLoaderMessageCount = 0
  let transientLoaderMessageCount = 0

  const store: AgentRuntimeStore = {
    getConversation: async (id) => {
      calls.push(`get:${id}`)
      if (id !== conversationId) throw new Error(`unexpected conversation: ${id}`)
      return record
    },
    saveMessage: async (_id, message) => {
      calls.push(`upsert:${message.role}`)
      record = { ...record, messages: [...record.messages, message] }
      return { ...summary, updatedAt: summary.updatedAt + record.messages.length }
    },
    recordAgentEvent: async (_id, event) => {
      calls.push(`event:${event.type}`)
      return {
        event: {
          ...event,
          schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
        },
        summary: { ...summary, updatedAt: summary.updatedAt + record.messages.length + 1 },
      }
    },
    recordUsage: async () => {
      throw new Error('stable instructions contract should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('stable instructions contract should not delete conversation')
    },
  }

  const runtime = new AgentRuntime({
    store,
    loadStableInstructions: ({ record: inputRecord, source }) => {
      stableLoaderMessageCount = inputRecord.messages.length
      calls.push(`stable:${source}:${stableLoaderMessageCount}`)
      inputRecord.messages.push({
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: 'host-mutated-stable-record-message',
        role: 'user',
        blocks: [{ type: 'text', content: 'host mutated stable record' }],
        status: 'done',
      })
      return [
        {
          role: 'system',
          content: `stable instructions for ${inputRecord.meta.id}`,
        },
      ]
    },
    loadTransientContext: ({ record: inputRecord, source }) => {
      transientLoaderMessageCount = inputRecord.messages.length
      calls.push(`dynamic:${source}:${transientLoaderMessageCount}`)
      return [
        {
          role: 'system',
          content: `dynamic context for ${inputRecord.meta.id}`,
        },
      ]
    },
    streamChat: async (req, handlers) => {
      streamedMessages = req.messages
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'used stable instructions' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
    logger: { warn() {}, error() {} },
  })

  await runtime.send({
    conversationId,
    userText: 'use stable instructions',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await waitFor(
    () => runtime.listActiveStreams().length === 0,
    'stable instructions stream should settle',
  )

  assert(calls.includes(`get:${conversationId}`), 'runtime should load record through store')
  assert(
    calls.includes('stable:send:1'),
    'host stable instructions should receive the post-user-message record',
  )
  assert(
    calls.includes('dynamic:send:1'),
    'host transient context should receive a record isolated from stable instructions mutation',
  )
  assertEqual(
    stableLoaderMessageCount,
    1,
    'stable instructions loader should see the post-user-message record',
  )
  assertEqual(
    transientLoaderMessageCount,
    1,
    'transient context loader should not see stable instructions host mutations',
  )
  assertEqual(
    streamedMessages.map((message) => message.content).join('|'),
    `stable instructions for ${conversationId}|dynamic context for ${conversationId}|use stable instructions`,
    'runtime should place stable instructions before dynamic context and current user message',
  )
  assertEqual(record.messages.length, 2, 'host stable instructions should not mutate store record')
}

function testContextAssemblerSectionsContract(): void {
  assertEqual(
    typeof runtimeSdk.assembleAgentContext,
    'function',
    'runtime SDK should expose context assembler function',
  )
  assertEqual(
    typeof runtimeSdk.ContextAssembler,
    'function',
    'runtime SDK should expose context assembler class',
  )

  const baseMessages = [
    {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-user-old',
      role: 'user' as const,
      blocks: [{ type: 'text' as const, content: 'older request' }],
      status: 'done' as const,
    },
    {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-assistant-old',
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, content: 'older answer' }],
      status: 'done' as const,
    },
    {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-user-current',
      role: 'user' as const,
      blocks: [{ type: 'text' as const, content: 'current request' }],
      status: 'done' as const,
    },
  ]

  const assembled = runtimeSdk.assembleAgentContext({
    stableInstructions: [{ role: 'system', content: 'stable instructions' }],
    dynamicContext: [{ role: 'system', content: 'dynamic runtime context' }],
    messages: baseMessages,
    modelInfo: { model: 'contract', contextLength: 100_000 },
  })

  assertEqual(
    assembled.sections.map((section) => section.kind).join(','),
    'stable_instructions,dynamic_context,selected_history,current_user_message',
    'context assembler should expose ordered prompt sections',
  )
  assertEqual(
    assembled.messages.map((message) => message.role).join(','),
    'system,system,user,assistant,user',
    'context assembler should preserve flattened model message order',
  )
  assertEqual(
    assembled.sections.at(-1)?.messages[0]?.role,
    'user',
    'context assembler should isolate current user message as the final section',
  )

  const viaClass = new runtimeSdk.ContextAssembler().assemble({
    transientContext: [{ role: 'system', content: 'legacy dynamic context' }],
    messages: baseMessages,
    modelInfo: { model: 'contract', contextLength: 100_000 },
  })
  assertEqual(
    viaClass.sections[0]?.kind,
    'dynamic_context',
    'context assembler should map legacy transient context into dynamic context',
  )
  assertEqual(
    viaClass.messages[0]?.role,
    'system',
    'context assembler class should flatten assembled sections',
  )

  const largeHistory = Array.from({ length: 30 }, (_, index) => ({
    schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
    id: `context-large-user-${index}`,
    role: 'user' as const,
    blocks: [
      {
        type: 'text' as const,
        content: `large omitted request ${index} ${'x'.repeat(900)}`,
      },
    ],
    status: 'done' as const,
  }))
  const compacted = runtimeSdk.assembleAgentContext({
    messages: [
      ...largeHistory,
      {
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: 'context-large-current',
        role: 'user' as const,
        blocks: [{ type: 'text' as const, content: 'current request after large history' }],
        status: 'done' as const,
      },
    ],
    modelInfo: { model: 'contract', contextLength: 4_000 },
  })
  assert(
    compacted.sections.some((section) => section.kind === 'compaction_summary'),
    'context assembler should expose omitted history as a compaction summary section',
  )
  assert(
    compacted.stats.omittedRounds > 0,
    'context assembler should report omitted rounds when history exceeds budget',
  )
  assertEqual(
    compacted.sections.at(-1)?.kind,
    'current_user_message',
    'context assembler should keep current user message after compaction summary and selected history',
  )
}

async function testRuntimeStreamHandlerSnapshots(): Promise<void> {
  const conversationId = 'stream-handler-snapshot-contract'
  const emitted: AgentRuntimeEvent[] = []
  let storedUsageTotal: number | null = null
  let record: ConversationRecord = {
    meta: {
      schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
      id: conversationId,
      title: 'stream handler snapshot',
      createdAt: 1,
      updatedAt: 1,
    },
    messages: [],
  }

  const store: AgentRuntimeStore = {
    getConversation: async (id) => {
      if (id !== conversationId) throw new Error(`unexpected conversation: ${id}`)
      return record
    },
    saveMessage: async (_id, message) => {
      await Promise.resolve()
      const index = record.messages.findIndex((current) => current.id === message.id)
      record =
        index >= 0
          ? {
              ...record,
              messages: record.messages.map((current, currentIndex) =>
                currentIndex === index ? message : current,
              ),
            }
          : { ...record, messages: [...record.messages, message] }
      return { ...record.meta, updatedAt: record.meta.updatedAt + record.messages.length }
    },
    recordAgentEvent: async (_id, event) => ({
      event: {
        ...event,
        schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      },
      summary: { ...record.meta, updatedAt: record.meta.updatedAt + record.messages.length + 1 },
    }),
    recordUsage: async (_id, usage) => {
      storedUsageTotal = usage.totalTokens
      return {
        ...record.meta,
        updatedAt: record.meta.updatedAt + record.messages.length + 2,
        usage: { ...usage, updatedAt: 3 },
      }
    },
    deleteConversation: async () => {
      throw new Error('stream handler snapshot should not delete conversation')
    },
  }

  const runtime = new AgentRuntime({
    store,
    onEvent: (event) => emitted.push(event),
    streamChat: async (req, handlers) => {
      const doneEvent = {
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant' as const,
          blocks: [{ type: 'text' as const, content: 'original stream result' }],
          status: 'done' as const,
          model: req.selection,
        },
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      } satisfies Parameters<typeof handlers.onDone>[0]
      const done = handlers.onDone(doneEvent)
      const [block] = doneEvent.message.blocks
      if (block?.type === 'text') block.content = 'mutated stream result'
      doneEvent.usage.totalTokens = 999
      await done
    },
    logger: { warn() {}, error() {} },
  })

  await runtime.send({
    conversationId,
    userText: 'snapshot stream handler event',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await waitFor(
    () => runtime.listActiveStreams().length === 0,
    'stream handler snapshot should settle',
  )

  const doneEvent = emitted.find((event) => event.type === 'chat:done')
  const doneText =
    doneEvent?.type === 'chat:done' && doneEvent.data.message.blocks[0]?.type === 'text'
      ? doneEvent.data.message.blocks[0].content
      : null
  assertEqual(
    doneText,
    'original stream result',
    'runtime should snapshot stream handler done events before host mutation',
  )
  assertEqual(
    doneEvent?.type === 'chat:done' ? doneEvent.data.usage?.totalTokens : null,
    3,
    'runtime should snapshot stream handler usage before host mutation',
  )
  assertEqual(storedUsageTotal, 3, 'runtime should persist snapshotted stream usage')
}

async function testRuntimeConversationStoreFacadeContract(): Promise<void> {
  const calls: string[] = []
  const emitted: AgentRuntimeEvent[] = []
  const eventsByConversation = new Map<string, PersistedAgentEvent[]>()
  const summaries = new Map<string, ConversationSummary>()
  const records = new Map<string, ConversationRecord>()
  let nextId = 1

  const store: AgentRuntimeStore = {
    createConversation: async (docId) => {
      const id = `injected-conversation-${nextId++}`
      calls.push(`create:${docId ?? 'chat'}`)
      const summary: ConversationSummary = {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id,
        title: 'injected conversation',
        createdAt: nextId,
        updatedAt: nextId,
        ...(docId ? { docId } : {}),
      }
      summaries.set(id, summary)
      records.set(id, { meta: summary, messages: [] })
      eventsByConversation.set(id, [
        {
          schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
          timestamp: 1,
          conversationId: id,
          messageId: 'assistant-injected-facade',
          type: 'turn.started',
          data: { providerId: 'openrouter', modelId: 'contract/mock' },
        },
      ])
      return summary
    },
    getConversation: async (conversationId) => {
      calls.push(`get:${conversationId}`)
      const record = records.get(conversationId)
      if (!record) throw new Error(`missing record: ${conversationId}`)
      return record
    },
    saveMessage: async () => {
      throw new Error('conversation facade should not upsert messages')
    },
    recordAgentEvent: async () => {
      throw new Error('conversation facade should not append events')
    },
    listConversations: async () => {
      calls.push('list')
      return Array.from(summaries.values())
    },
    listAgentEvents: async (conversationId) => {
      calls.push(`events:${conversationId}`)
      return eventsByConversation.get(conversationId) ?? []
    },
    renameConversation: async (conversationId, title) => {
      calls.push(`rename:${conversationId}:${title}`)
      const current = summaries.get(conversationId)
      if (!current) throw new Error(`missing summary: ${conversationId}`)
      const renamed = { ...current, title, updatedAt: current.updatedAt + 1 }
      summaries.set(conversationId, renamed)
      const record = records.get(conversationId)
      if (record) records.set(conversationId, { ...record, meta: renamed })
      return renamed
    },
    recordUsage: async () => {
      throw new Error('conversation facade should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('conversation facade should not delete conversations')
    },
  }

  const runtime = new AgentRuntime({
    store,
    onEvent: (event) => {
      if (event.type === 'conversations:updated') {
        event.data.title = `event-mutated:${event.data.title}`
      }
      if (event.type === 'agent:event' && event.data.data) {
        event.data.data.modelId = 'event-mutated'
      }
      emitted.push(event)
    },
    logger: { warn() {}, error() {} },
  })

  const chat = await runtime.createConversation()
  const doc = await runtime.createConversation({ docId: 'docs/facade.md' })
  assertEqual(
    chat.title,
    'injected conversation',
    'runtime create should isolate returned summary from onEvent mutation',
  )
  chat.title = 'caller-mutated-chat'
  assertEqual(
    summaries.get(chat.id)?.title,
    'injected conversation',
    'runtime create should isolate store summary from caller mutation',
  )
  assertEqual(chat.docId, undefined, 'runtime create chat conversation')
  assertEqual(doc.docId, 'docs/facade.md', 'runtime create doc-bound conversation')

  const listedConversations = await runtime.listConversations()
  assertEqual(listedConversations.length, 2, 'runtime should list all conversations')
  assertEqual(
    listedConversations.map((summary) => summary.id).join(','),
    `${doc.id},${chat.id}`,
    'runtime should sort injected store conversations by updatedAt desc',
  )
  const listedChat = listedConversations.find((summary) => summary.id === chat.id)
  if (listedChat) listedChat.title = 'caller-mutated-list'
  assertEqual(
    summaries.get(chat.id)?.title,
    'injected conversation',
    'runtime list should isolate store summaries from caller mutation',
  )
  assertEqual(
    (await runtime.listConversations({ docId: null })).map((summary) => summary.id).join(','),
    chat.id,
    'runtime should filter chat conversations',
  )
  assertEqual(
    (await runtime.listConversations({ docId: 'docs/facade.md' }))[0]?.id,
    doc.id,
    'runtime should filter doc-bound conversations by metadata',
  )

  const fetchedChat = await runtime.getConversation(chat.id)
  assertEqual(fetchedChat.meta.id, chat.id, 'runtime get conversation should delegate to store')
  fetchedChat.meta.title = 'caller-mutated-record'
  assertEqual(
    records.get(chat.id)?.meta.title,
    'injected conversation',
    'runtime get should isolate store records from caller mutation',
  )
  assertEqual(
    (await runtime.resolveConversation({ conversationId: doc.id })).summary.id,
    doc.id,
    'runtime resolve should validate and return explicit conversations',
  )
  assertEqual(
    (await runtime.resolveConversation({ resumeLatest: true, docId: 'docs/facade.md' }))
      .conversationId,
    doc.id,
    'runtime resolve should resume within a conversation scope',
  )
  assertEqual(
    (await runtime.resolveConversation({ resumeLatest: true })).conversationId,
    doc.id,
    'runtime resolve latest should not depend on injected store ordering',
  )
  const resolvedNew = await runtime.resolveConversation({ docId: 'docs/resolved.md' })
  assertEqual(resolvedNew.isExisting, false, 'runtime resolve should create missing input')
  assertEqual(
    resolvedNew.summary.docId,
    'docs/resolved.md',
    'runtime resolve should pass create metadata through the store',
  )
  try {
    await runtime.resolveConversation({ conversationId: chat.id, resumeLatest: true })
    throw new Error('combined resolve options unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('cannot be combined'),
      'runtime resolve should reject ambiguous conversation options',
    )
  }
  const listedEvents = await runtime.listAgentEvents(chat.id)
  assertEqual(listedEvents[0]?.type, 'turn.started', 'runtime list events should delegate to store')
  if (listedEvents[0]?.data) listedEvents[0].data.modelId = 'caller-mutated-event'
  assertEqual(
    eventsByConversation.get(chat.id)?.[0]?.data?.modelId,
    'contract/mock',
    'runtime list events should isolate store events from caller mutation',
  )
  const renamed = await runtime.renameConversation(chat.id, 'renamed via runtime')
  assertEqual(renamed.title, 'renamed via runtime', 'runtime rename should delegate to store')
  assertEqual(
    summaries.get(chat.id)?.title,
    'renamed via runtime',
    'runtime rename should isolate store summary from onEvent mutation',
  )
  renamed.title = 'caller-mutated-rename'
  assertEqual(
    summaries.get(chat.id)?.title,
    'renamed via runtime',
    'runtime rename should isolate store summary from caller mutation',
  )
  assert(
    emitted.filter((event) => event.type === 'conversations:updated').length >= 3,
    'runtime create and rename should emit conversation updates',
  )
  assert(
    calls.some((call) => call === `rename:${chat.id}:renamed via runtime`),
    'runtime should call injected rename',
  )
}

async function testRuntimeConversationRuntimeStateApiUsesEventReplay(): Promise<void> {
  const runtime = new AgentRuntime({
    store: createInMemoryRuntimeStore(),
    logger: { warn() {}, error() {} },
  })
  const chat = await runtime.createConversation()
  const docChat = await runtime.createConversation({ docId: 'docs@aila/agent-state.md' })

  await runtime.recordAgentEvent({
    timestamp: 10,
    conversationId: chat.id,
    messageId: 'assistant-runtime-state',
    type: 'turn.started',
    data: {
      providerId: 'openrouter',
      modelId: 'contract/mock',
      inputMessageCount: 1,
    },
  })
  await runtime.recordAgentEvent({
    timestamp: 20,
    conversationId: chat.id,
    messageId: 'assistant-runtime-state',
    type: 'tool.approval.requested',
    data: {
      requestId: 'approval-runtime-state',
      toolCallId: 'tool-call-runtime-state',
      toolName: 'write',
    },
  })
  await runtime.recordAgentEvent({
    timestamp: 20,
    conversationId: chat.id,
    messageId: 'assistant-runtime-state',
    type: 'tool.approval.requested',
    data: {
      requestId: 'approval-runtime-state',
      toolCallId: 'tool-call-runtime-state',
      toolName: 'write',
    },
  })
  await runtime.recordAgentEvent({
    timestamp: 30,
    conversationId: docChat.id,
    messageId: 'assistant-doc-runtime-state',
    type: 'turn.completed',
    data: { outputBlockCount: 1 },
  })

  const state = await runtime.getConversationRuntimeState(chat.id)
  assertEqual(state.phase, 'approval', 'runtime state API should replay pending approval phase')
  assertEqual(state.active, true, 'runtime state API should report active replay state')
  assertEqual(
    state.turn?.assistantMessageId,
    'assistant-runtime-state',
    'runtime state API should expose assistant turn id',
  )
  assertEqual(
    state.turn?.selection?.modelId,
    'contract/mock',
    'runtime state API should preserve replayed model selection',
  )
  assertEqual(
    state.turn?.pendingApproval?.requestId,
    'approval-runtime-state',
    'runtime state API should preserve pending approval details',
  )

  if (state.turn?.pendingApproval) state.turn.pendingApproval.requestId = 'caller-mutated'
  const stateAgain = await runtime.getConversationRuntimeState(chat.id)
  assertEqual(
    stateAgain.turn?.pendingApproval?.requestId,
    'approval-runtime-state',
    'runtime state API should isolate replay state from caller mutation',
  )

  const hydration = await runtime.hydrateConversation(chat.id)
  assertEqual(
    hydration.record.meta.id,
    chat.id,
    'runtime hydrate should include the conversation record',
  )
  assertEqual(hydration.events.length, 2, 'runtime hydrate should include replay events')
  assertEqual(
    hydration.runtimeState.phase,
    'approval',
    'runtime hydrate should include replayed lifecycle state',
  )
  assertEqual(hydration.activeTurn, null, 'runtime hydrate should report no live active turn')
  hydration.record.meta.title = 'caller-mutated-hydration'
  const firstHydrationEvent = hydration.events[0]
  assert(firstHydrationEvent, 'runtime hydrate should include first event')
  firstHydrationEvent.data = { providerId: 'mutated', modelId: 'mutated' }
  const pendingApproval = hydration.runtimeState.turn?.pendingApproval
  assert(pendingApproval, 'runtime hydrate should include pending approval')
  pendingApproval.requestId = 'mutated-hydration'
  const hydratedAgain = await runtime.hydrateConversation(chat.id)
  assertEqual(
    hydratedAgain.record.meta.title,
    '新对话',
    'runtime hydrate should isolate records from caller mutation',
  )
  assertEqual(
    hydratedAgain.events[0]?.data?.modelId,
    'contract/mock',
    'runtime hydrate should isolate events from caller mutation',
  )
  assertEqual(
    hydratedAgain.runtimeState.turn?.pendingApproval?.requestId,
    'approval-runtime-state',
    'runtime hydrate should isolate replay state from caller mutation',
  )

  const chatStates = await runtime.listConversationRuntimeStates({ docId: null })
  assertEqual(chatStates.length, 1, 'runtime state list should respect chat conversation filter')
  assertEqual(
    chatStates[0]?.conversationId,
    chat.id,
    'runtime state list should include the filtered chat conversation',
  )
  assertEqual(
    chatStates[0]?.state.phase,
    'approval',
    'runtime state list should include replay state snapshots',
  )

  const docStates = await runtime.listConversationRuntimeStates({
    docId: 'docs@aila/agent-state.md',
  })
  assertEqual(docStates.length, 1, 'runtime state list should respect doc conversation filter')
  assertEqual(
    docStates[0]?.conversationId,
    docChat.id,
    'runtime state list should include the filtered doc conversation',
  )
  assertEqual(
    docStates[0]?.state.phase,
    'completed',
    'runtime state list should replay terminal doc conversation state',
  )
}

async function testRuntimeOptionalStoreCapabilitiesFailClosed(): Promise<void> {
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: 'minimal-store-conversation',
    title: 'minimal store',
    createdAt: 1,
    updatedAt: 1,
  }
  const record: ConversationRecord = { meta: summary, messages: [] }
  const store: AgentRuntimeStore = {
    getConversation: async () => record,
    saveMessage: async () => summary,
    recordAgentEvent: async (_conversationId, event) => ({
      event: { ...event, schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION },
    }),
    recordUsage: async () => summary,
    deleteConversation: async () => {},
  }
  const runtime = new AgentRuntime({ store, logger: { warn() {}, error() {} } })

  async function expectCapabilityError(
    label: string,
    operation: () => Promise<unknown>,
    expectedMessage: string,
  ): Promise<void> {
    try {
      await operation()
      throw new Error(`${label} unexpectedly succeeded`)
    } catch (error) {
      assert(
        error instanceof Error && error.message.includes(expectedMessage),
        `${label} should fail closed with: ${expectedMessage}`,
      )
    }
  }

  await expectCapabilityError(
    'create without store capability',
    () => runtime.createConversation(),
    'runtime store cannot create conversations',
  )
  await expectCapabilityError(
    'list without store capability',
    () => runtime.listConversations(),
    'runtime store cannot list conversations',
  )
  await expectCapabilityError(
    'event list without store capability',
    () => runtime.listAgentEvents(summary.id),
    'runtime store cannot list agent events',
  )
  await expectCapabilityError(
    'runtime state without event store capability',
    () => runtime.getConversationRuntimeState(summary.id),
    'runtime store cannot list agent events',
  )
  const listOnlyRuntime = new AgentRuntime({
    store: { ...store, listConversations: async () => [summary] },
    logger: { warn() {}, error() {} },
  })
  await expectCapabilityError(
    'runtime state list without event store capability',
    () => listOnlyRuntime.listConversationRuntimeStates(),
    'runtime store cannot list agent events',
  )
  await expectCapabilityError(
    'rename without store capability',
    () => runtime.renameConversation(summary.id, 'renamed'),
    'runtime store cannot rename conversations',
  )
  const recovered = await runtime.recoverInterruptedActivities('minimal store restart')
  assertEqual(
    recovered.length,
    0,
    'recovery without list/replay store capabilities should be a no-op',
  )
}

async function testInMemoryRuntimeStoreEventListContract(): Promise<void> {
  const store = createInMemoryRuntimeStore()
  const summary = await store.createConversation?.()
  assert(summary, 'in-memory runtime store should create conversations')

  const laterEvent: PersistedAgentEvent = {
    schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
    timestamp: 20,
    conversationId: summary.id,
    messageId: 'assistant-memory-events',
    type: 'tool.requested',
    data: { toolName: 'read' },
  }
  const earlierEvent: PersistedAgentEvent = {
    schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
    timestamp: 10,
    conversationId: summary.id,
    messageId: 'assistant-memory-events',
    type: 'turn.started',
    data: { providerId: 'openrouter', modelId: 'contract/mock' },
  }

  await store.recordAgentEvent(summary.id, laterEvent)
  await store.recordAgentEvent(summary.id, earlierEvent)
  await store.recordAgentEvent(summary.id, earlierEvent)

  const listed = [...((await store.listAgentEvents?.(summary.id)) ?? [])]
  assertEqual(listed.length, 2, 'in-memory event list should deduplicate replay events')
  assertEqual(listed[0]?.timestamp, 10, 'in-memory event list should be replay ordered')
  assertEqual(listed[1]?.timestamp, 20, 'in-memory event list should keep later events')

  if (listed[0]?.data) listed[0].data.modelId = 'mutated'
  const relisted = [...((await store.listAgentEvents?.(summary.id)) ?? [])]
  assertEqual(
    relisted[0]?.data?.modelId,
    'contract/mock',
    'in-memory event list should return snapshots',
  )

  await store.deleteConversation(summary.id)
  assertEqual(
    ((await store.listAgentEvents?.(summary.id)) ?? []).length,
    0,
    'in-memory event list should match persisted store after delete',
  )
}

async function testRuntimeEnvironmentContract(): Promise<void> {
  const ids = ['conversation-env-id', 'user-env-id', 'assistant-env-id']
  const timestamps = [100, 200, 300, 400]
  const emitted: AgentRuntimeEvent[] = []
  const runtime = new AgentRuntime({
    createId: () => {
      const id = ids.shift()
      if (!id) throw new Error('runtime requested an unexpected id')
      return id
    },
    now: () => {
      const timestamp = timestamps.shift()
      if (timestamp === undefined) throw new Error('runtime requested an unexpected timestamp')
      return timestamp
    },
    onEvent: (event) => emitted.push(event),
    logger: { warn() {}, error() {} },
  })

  const conversation = await runtime.createConversation()
  assertEqual(conversation.id, 'conversation-env-id', 'runtime should use injected id for create')
  assertEqual(conversation.createdAt, 100, 'runtime should use injected clock for createdAt')
  assertEqual(conversation.updatedAt, 100, 'runtime should use injected clock for updatedAt')

  const result = await runtime.send({
    conversationId: conversation.id,
    userText: 'deterministic environment',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  assertEqual(result.userMessage.id, 'user-env-id', 'runtime should use injected id for user')
  assertEqual(
    result.assistantMessageId,
    'assistant-env-id',
    'runtime should use injected id for assistant',
  )

  const record = await runtime.getConversation(conversation.id)
  assertEqual(record.meta.updatedAt, 400, 'runtime should use injected event time for activity')
  assertEqual(record.messages[0]?.id, 'user-env-id', 'recorded user id')
  assertEqual(record.messages[1]?.id, 'assistant-env-id', 'recorded assistant id')
  assertEqual(record.messages[1]?.status, 'error', 'hostless assistant status')

  const failedEvent = emitted.find(
    (event) => event.type === 'agent:event' && event.data.type === 'turn.failed',
  )
  assert(failedEvent?.type === 'agent:event', 'runtime should emit setup failure event')
  assertEqual(
    failedEvent.data.timestamp,
    400,
    'runtime should timestamp events from injected clock',
  )
  assertEqual(ids.length, 0, 'runtime should consume expected injected ids')
  assertEqual(timestamps.length, 0, 'runtime should consume expected injected timestamps')
}

async function testRuntimeAppendUserMessageUsesInjectedStore(): Promise<void> {
  const conversationId = 'append-user-message-contract'
  const calls: string[] = []
  const emitted: AgentRuntimeEvent[] = []
  const store: AgentRuntimeStore = {
    getConversation: async () => {
      throw new Error('append user message should not read conversation')
    },
    saveMessage: async (id, message) => {
      calls.push(`upsert:${id}:${message.role}`)
      const [block] = message.blocks
      if (block?.type === 'text') block.content = 'store-mutated-message'
      const summary: ConversationSummary = {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id,
        title: 'append user message',
        createdAt: 1,
        updatedAt: 2,
      }
      return summary
    },
    recordAgentEvent: async () => {
      throw new Error('append user message should not append agent events')
    },
    recordUsage: async () => {
      throw new Error('append user message should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('append user message should not delete conversation')
    },
  }

  const runtime = new AgentRuntime({
    store,
    onEvent: (event) => emitted.push(event),
    logger: { warn() {}, error() {} },
  })
  const message = await runtime.appendUserMessage({
    conversationId,
    text: '[local command]\nresult',
  })

  assertEqual(message.role, 'user', 'runtime append user message role')
  assertEqual(
    message.blocks[0]?.type === 'text' ? message.blocks[0].content : '',
    '[local command]\nresult',
    'runtime append user message content',
  )
  assertEqual(
    calls.join(','),
    `upsert:${conversationId}:user`,
    'runtime append user message should use injected store',
  )
  assert(
    emitted.some(
      (event) => event.type === 'conversations:updated' && event.data.id === conversationId,
    ),
    'runtime append user message should emit conversation update',
  )
}

async function testRuntimeRecordAgentEventUsesInjectedStore(): Promise<void> {
  const conversationId = 'record-agent-event-contract'
  const calls: string[] = []
  const emitted: AgentRuntimeEvent[] = []
  let persistedFromStore: PersistedAgentEvent | undefined
  let summaryFromStore: ConversationSummary | undefined
  const store: AgentRuntimeStore = {
    getConversation: async () => {
      throw new Error('record agent event should not read conversation')
    },
    saveMessage: async () => {
      throw new Error('record agent event should not upsert messages')
    },
    recordAgentEvent: async (id, event) => {
      calls.push(`event:${id}:${event.type}`)
      if (event.data) event.data.requestId = 'store-mutated-request'
      persistedFromStore = {
        ...event,
        schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      }
      summaryFromStore = {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id,
        title: 'record agent event',
        createdAt: 1,
        updatedAt: 3,
      }
      return {
        event: persistedFromStore,
        summary: summaryFromStore,
      }
    },
    recordUsage: async () => {
      throw new Error('record agent event should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('record agent event should not delete conversation')
    },
  }

  const runtime = new AgentRuntime({
    store,
    onEvent: (event) => {
      if (event.type === 'agent:event' && event.data.data) {
        event.data.data.requestId = 'event-mutated-request'
      }
      if (event.type === 'conversations:updated') {
        event.data.title = 'event-mutated-summary'
      }
      emitted.push(event)
    },
    logger: { warn() {}, error() {} },
  })
  const inputEvent: RuntimeRecordAgentEventInput = {
    timestamp: 2,
    conversationId,
    messageId: 'assistant-message',
    type: 'tool.approval.requested',
    data: { requestId: 'approval-request', toolName: 'write_file' },
  }
  const recorded = await runtime.recordAgentEvent(inputEvent)

  assertEqual(recorded, true, 'runtime record agent event result')
  assertEqual(
    inputEvent.data?.requestId,
    'approval-request',
    'runtime record should isolate caller event from store mutation',
  )
  assertEqual(
    persistedFromStore?.data?.requestId,
    'store-mutated-request',
    'runtime record should isolate persisted event from onEvent mutation',
  )
  assertEqual(
    summaryFromStore?.title,
    'record agent event',
    'runtime record should isolate persisted summary from onEvent mutation',
  )
  assertEqual(
    calls.join(','),
    `event:${conversationId}:tool.approval.requested`,
    'runtime record agent event should use injected store',
  )
  assert(
    emitted.some(
      (event) =>
        event.type === 'agent:event' &&
        event.data.conversationId === conversationId &&
        event.data.type === 'tool.approval.requested',
    ),
    'runtime record agent event should emit persisted agent event',
  )
  assert(
    emitted.some(
      (event) => event.type === 'conversations:updated' && event.data.id === conversationId,
    ),
    'runtime record agent event should emit conversation update',
  )
}

async function testRuntimeRecoveryDelegatesToInjectedStore(): Promise<void> {
  const summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: 'delegated-recovery',
    title: 'delegated recovery',
    createdAt: 1,
    updatedAt: 2,
  }
  const recoveredEvent: PersistedAgentEvent = {
    schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
    timestamp: 2,
    conversationId: summary.id,
    messageId: 'delegated-assistant',
    type: 'turn.interrupted',
    data: { reason: 'delegated' },
  }
  let delegatedReason: string | undefined
  const events: AgentRuntimeEvent[] = []
  const store: AgentRuntimeStore = {
    getConversation: async () => {
      throw new Error('delegated recovery should not read conversations directly')
    },
    saveMessage: async () => {
      throw new Error('delegated recovery should not upsert messages')
    },
    recordAgentEvent: async () => {
      throw new Error('delegated recovery should not append directly')
    },
    recoverInterruptedActivities: async (reason) => {
      delegatedReason = reason
      return [{ event: recoveredEvent, summary }]
    },
    recordUsage: async () => {
      throw new Error('delegated recovery should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('delegated recovery should not delete conversations')
    },
  }

  const runtime = new AgentRuntime({
    store,
    onEvent: (event) => {
      if (event.type === 'conversations:updated') event.data.title = 'event-mutated recovery'
      events.push(event)
    },
    logger: { warn() {}, error() {} },
  })
  const recovered = await runtime.recoverInterruptedActivities('delegated host restart')

  assertEqual(delegatedReason, 'delegated host restart', 'runtime should pass recovery reason')
  assertEqual(recovered[0]?.id, 'delegated-recovery', 'runtime should return delegated recovery')
  assertEqual(
    summary.title,
    'delegated recovery',
    'delegated recovery should isolate store summary from onEvent mutation',
  )
  if (recovered[0]) recovered[0].title = 'caller-mutated recovery'
  assertEqual(
    summary.title,
    'delegated recovery',
    'delegated recovery should isolate store summary from caller mutation',
  )
  assert(
    events.some(
      (event) => event.type === 'conversations:updated' && event.data.id === 'delegated-recovery',
    ),
    'delegated recovery should emit conversation update',
  )
  assert(
    events.some(
      (event) => event.type === 'agent:event' && event.data.conversationId === 'delegated-recovery',
    ),
    'delegated recovery should emit recovered agent event',
  )
}

async function testRuntimeRecoveryUsesInjectedStoreReplay(): Promise<void> {
  const conversationId = 'injected-replay-recovery'
  let summary: ConversationSummary = {
    schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
    id: conversationId,
    title: 'injected replay recovery',
    createdAt: 1,
    updatedAt: 10,
    activity: {
      state: 'running',
      title: 'Model streaming',
      updatedAt: 10,
      eventType: 'turn.started',
      messageId: 'assistant-injected-recovery',
      detail: 'contract/mock',
    },
  }
  const storedEvents: PersistedAgentEvent[] = [
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 10,
      conversationId,
      messageId: 'assistant-injected-recovery',
      type: 'turn.started',
      data: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
  ]
  const calls: string[] = []
  const emitted: AgentRuntimeEvent[] = []
  let appendedEvent: PersistedAgentEvent | undefined
  const store: AgentRuntimeStore = {
    getConversation: async () => {
      throw new Error('injected replay recovery should not read a conversation record')
    },
    saveMessage: async () => {
      throw new Error('injected replay recovery should not upsert messages')
    },
    listConversations: async () => {
      calls.push('list-conversations')
      return [summary]
    },
    listAgentEvents: async (id) => {
      calls.push(`list-events:${id}`)
      return storedEvents
    },
    recordAgentEvent: async (id, event) => {
      calls.push(`append:${event.type}:${id}`)
      appendedEvent = {
        schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
        ...event,
      }
      storedEvents.push(appendedEvent)
      summary = {
        ...summary,
        updatedAt: event.timestamp,
        activity: replayConversationActivity(storedEvents),
      }
      return { event: appendedEvent, summary }
    },
    recordUsage: async () => {
      throw new Error('injected replay recovery should not persist usage')
    },
    deleteConversation: async () => {
      throw new Error('injected replay recovery should not delete conversations')
    },
  }

  const runtime = new AgentRuntime({
    store,
    onEvent: (event) => emitted.push(event),
    logger: { warn() {}, error() {} },
  })
  const recovered = await runtime.recoverInterruptedActivities('injected host restart')

  assertEqual(
    calls.join(','),
    `list-conversations,list-events:${conversationId},append:turn.interrupted:${conversationId}`,
    'runtime should recover through injected store methods',
  )
  assertEqual(appendedEvent?.type, 'turn.interrupted', 'injected replay should append interrupted')
  assertEqual(
    appendedEvent?.data?.previousEventType,
    'turn.started',
    'injected replay should preserve previous event',
  )
  assertEqual(
    appendedEvent?.data?.modelId,
    'contract/mock',
    'injected replay should preserve model id',
  )
  assertEqual(recovered[0]?.activity?.state, 'interrupted', 'injected replay recovered state')
  assert(
    emitted.some((event) => event.type === 'agent:event' && event.data.type === 'turn.interrupted'),
    'injected replay recovery should emit agent event',
  )
  assert(
    emitted.some(
      (event) =>
        event.type === 'conversations:updated' && event.data.activity?.state === 'interrupted',
    ),
    'injected replay recovery should emit conversation update',
  )
}

async function testRuntimeDeleteAssetCleanupHostBoundary(): Promise<void> {
  await withTempDataDir(async () => {
    let getCalledWithoutHook = false
    let deleteCalledWithoutHook = false
    const withoutCleanupStore: AgentRuntimeStore = {
      getConversation: async () => {
        getCalledWithoutHook = true
        throw new Error('delete without cleanup hook should not read conversation')
      },
      saveMessage: async () => {
        throw new Error('not used')
      },
      recordAgentEvent: async () => {
        throw new Error('not used')
      },
      recordUsage: async () => {
        throw new Error('not used')
      },
      deleteConversation: async () => {
        deleteCalledWithoutHook = true
      },
    }
    const runtimeWithoutCleanup = new AgentRuntime({
      store: withoutCleanupStore,
      logger: { warn() {}, error() {} },
    })

    await runtimeWithoutCleanup.deleteConversation('delete-without-cleanup-hook')
    assertEqual(
      getCalledWithoutHook,
      false,
      'runtime delete should not read conversation when no asset cleanup host exists',
    )
    assertEqual(
      deleteCalledWithoutHook,
      true,
      'runtime delete should still delete through store without asset cleanup host',
    )

    const order: string[] = []
    const record: ConversationRecord = {
      meta: {
        schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
        id: 'delete-with-cleanup-hook',
        title: 'cleanup',
        createdAt: 1,
        updatedAt: 2,
      },
      messages: [
        {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: 'assistant-image',
          role: 'assistant',
          blocks: [{ type: 'image', url: 'aila-image://i/contract.png', mime: 'image/png' }],
          status: 'done',
        },
      ],
    }
    const withCleanupStore: AgentRuntimeStore = {
      getConversation: async (conversationId) => {
        order.push(`get:${conversationId}`)
        return record
      },
      saveMessage: async () => {
        throw new Error('not used')
      },
      recordAgentEvent: async () => {
        throw new Error('not used')
      },
      recordUsage: async () => {
        throw new Error('not used')
      },
      deleteConversation: async (conversationId) => {
        order.push(`delete:${conversationId}`)
      },
    }
    const runtimeWithCleanup = new AgentRuntime({
      store: withCleanupStore,
      host: {
        cleanupConversationAssets: (cleanupRecord) => {
          order.push(`cleanup:${cleanupRecord.meta.id}`)
          cleanupRecord.meta.title = 'cleanup-mutated-title'
          cleanupRecord.messages.push({
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: 'cleanup-mutated-message',
            role: 'assistant',
            blocks: [{ type: 'text', content: 'cleanup mutated message' }],
            status: 'done',
          })
        },
      },
      logger: { warn() {}, error() {} },
    })

    await runtimeWithCleanup.deleteConversation('delete-with-cleanup-hook')
    assertEqual(
      order.join(','),
      'get:delete-with-cleanup-hook,cleanup:delete-with-cleanup-hook,delete:delete-with-cleanup-hook',
      'runtime delete should delegate asset cleanup to host before store delete',
    )
    assertEqual(
      record.meta.title,
      'cleanup',
      'runtime delete should isolate store record from cleanup host mutation',
    )
    assertEqual(
      record.messages.length,
      1,
      'runtime delete should isolate store messages from cleanup host mutation',
    )
  })
}

async function testRuntimeRetriesDanglingUserTurn(): Promise<void> {
  await withTempDataDir(async () => {
    const previousOpenRouterKey = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = ''
    try {
      const conversation = await createConversation()
      await appendMessage(conversation.id, {
        schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
        id: 'dangling-user',
        role: 'user',
        blocks: [{ type: 'text', content: 'recover this interrupted turn' }],
        status: 'done',
      })

      const events: AgentRuntimeEvent[] = []
      const runtime = new AgentRuntime({
        store: createPersistedRuntimeStore(),
        onEvent: (event) => events.push(event),
        logger: { warn() {}, error() {} },
      })

      const result = await runtime.retryLastUserMessage({
        conversationId: conversation.id,
        selection: { providerId: 'openrouter', modelId: 'minimax/minimax-m3' },
      })

      assertEqual(
        result.userMessage.id,
        'dangling-user',
        'retry should reuse dangling user message',
      )
      await waitFor(
        () => events.some((event) => event.type === 'chat:error'),
        'retry did not emit expected no-key error event',
      )
      await runtime.abortAll()

      const record = await getConversation(conversation.id)
      assertEqual(
        record.messages.filter((message) => message.role === 'user').length,
        1,
        'retry must not append a duplicate user message',
      )
      assertEqual(record.messages.length, 2, 'retry should append exactly one assistant message')
      assertEqual(record.messages[1]?.role, 'assistant', 'retry assistant response persisted')
    } finally {
      if (previousOpenRouterKey === undefined) {
        delete process.env.OPENROUTER_API_KEY
      } else {
        process.env.OPENROUTER_API_KEY = previousOpenRouterKey
      }
    }
  })
}

async function testRuntimeRetriesFailedAssistantTurn(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'failed-turn-user',
      role: 'user',
      blocks: [{ type: 'text', content: 'retry the failed assistant turn' }],
      status: 'done',
    })
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'failed-assistant',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'partial failed output should not be retried' }],
      status: 'error',
      error: 'Aborted',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    const events: AgentRuntimeEvent[] = []
    let modelInput = ''
    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      streamChat: async (req, handlers) => {
        modelInput = JSON.stringify(req.messages)
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
          data: { outputBlockCount: 1 },
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'retried successfully' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    const result = await runtime.retryLastUserMessage({
      conversationId: conversation.id,
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    assertEqual(
      result.userMessage.id,
      'failed-turn-user',
      'retry should reuse the user before the failed assistant turn',
    )
    await waitFor(
      () => events.some((event) => event.type === 'chat:done'),
      'retry should complete the replacement assistant turn',
    )

    assert(
      modelInput.includes('retry the failed assistant turn'),
      'retry context should include the original user request',
    )
    assert(
      !modelInput.includes('partial failed output should not be retried'),
      'retry context should exclude the failed assistant output',
    )

    const record = await getConversation(conversation.id)
    assertEqual(
      record.messages.filter((message) => message.role === 'user').length,
      1,
      'retrying failed assistant must not duplicate the user message',
    )
    assertEqual(
      record.messages.filter((message) => message.role === 'assistant').length,
      2,
      'retrying failed assistant should append one replacement assistant message',
    )
    assertEqual(
      record.messages[1]?.status,
      'error',
      'failed assistant should remain in persisted history',
    )
    assertEqual(record.messages[2]?.status, 'done', 'replacement assistant should be persisted')
  })
}

async function testRuntimeContextSkipsNonDoneAssistantHistory(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-user-before-error',
      role: 'user',
      blocks: [{ type: 'text', content: 'request before failed assistant' }],
      status: 'done',
    })
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-failed-assistant',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'failed partial output should be excluded' }],
      status: 'error',
      error: 'provider failed',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'context-streaming-assistant',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'legacy streaming output should be excluded' }],
      status: 'streaming',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    let modelInput = ''
    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      streamChat: async (req, handlers) => {
        modelInput = JSON.stringify(req.messages)
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
          data: { outputBlockCount: 1 },
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'continued after failed history' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'continue after failed assistant',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    assert(
      modelInput.includes('request before failed assistant'),
      'context should keep user history before failed assistant',
    )
    assert(
      modelInput.includes('continue after failed assistant'),
      'context should include current user request',
    )
    assert(
      !modelInput.includes('failed partial output should be excluded'),
      'context should exclude failed assistant output',
    )
    assert(
      !modelInput.includes('legacy streaming output should be excluded'),
      'context should exclude legacy streaming assistant output',
    )
  })
}

async function testRuntimeSerializesConcurrentTurnStarts(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveFirstSetupStarted: () => void = () => {}
    let releaseFirstSetup: () => void = () => {}
    let resolveSecondSetupStarted: () => void = () => {}
    const firstSetupStarted = new Promise<void>((resolve) => {
      resolveFirstSetupStarted = resolve
    })
    const firstSetupRelease = new Promise<void>((resolve) => {
      releaseFirstSetup = resolve
    })
    const secondSetupStarted = new Promise<void>((resolve) => {
      resolveSecondSetupStarted = resolve
    })
    let transientContextCalls = 0
    let streamCount = 0
    let secondModelInput = ''

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      loadTransientContext: async () => {
        transientContextCalls += 1
        if (transientContextCalls === 1) {
          resolveFirstSetupStarted()
          await firstSetupRelease
        } else if (transientContextCalls === 2) {
          resolveSecondSetupStarted()
        }
        return undefined
      },
      streamChat: async (req, handlers) => {
        streamCount += 1
        const callIndex = streamCount
        if (callIndex === 2) secondModelInput = JSON.stringify(req.messages)
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
          data: { outputBlockCount: 1 },
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                content: callIndex === 1 ? 'first serialized answer' : 'second serialized answer',
              },
            ],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    const firstSend = runtime.send({
      conversationId: conversation.id,
      userText: 'first concurrent turn',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await firstSetupStarted

    const secondSend = runtime.send({
      conversationId: conversation.id,
      userText: 'second concurrent turn',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    const setupRace = await Promise.race([
      secondSetupStarted.then(() => 'second-started'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 30)),
    ])
    assertEqual(setupRace, 'blocked', 'second turn setup should wait for first turn registration')

    const duringFirstSetup = await getConversation(conversation.id)
    assertEqual(
      duringFirstSetup.messages.filter((message) => message.role === 'user').length,
      1,
      'concurrent second send must not append a user message before the first turn is registered',
    )
    assert(
      !JSON.stringify(duringFirstSetup.messages).includes('second concurrent turn'),
      'concurrent second send should not leak into first turn history',
    )

    releaseFirstSetup()
    await firstSend
    await secondSetupStarted
    await secondSend
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'serialized concurrent turns should both finish',
    )

    const record = await getConversation(conversation.id)
    assertEqual(streamCount, 2, 'runtime should still run both serialized turns')
    assertEqual(record.messages.length, 4, 'serialized sends should persist two full turns')
    assertEqual(record.messages[0]?.role, 'user', 'first serialized message role')
    assertEqual(record.messages[1]?.role, 'assistant', 'first serialized answer role')
    assertEqual(record.messages[2]?.role, 'user', 'second serialized message role')
    assertEqual(record.messages[3]?.role, 'assistant', 'second serialized answer role')
    assert(
      secondModelInput.includes('first serialized answer'),
      'second turn context should include the completed first assistant turn',
    )
    assert(
      secondModelInput.includes('second concurrent turn'),
      'second turn context should include the second user request',
    )
  })
}

async function testRuntimeAbortCancelsTurnSetupBeforeStreamStarts(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    let resolveSetupStarted: () => void = () => {}
    let releaseSetup: () => void = () => {}
    const setupStarted = new Promise<void>((resolve) => {
      resolveSetupStarted = resolve
    })
    const setupRelease = new Promise<void>((resolve) => {
      releaseSetup = resolve
    })
    let streamStarted = false
    let cleanupReason: string | null = null

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      onConversationAbort: (_conversationId, reason) => {
        cleanupReason = reason
      },
      loadTransientContext: async () => {
        resolveSetupStarted()
        await setupRelease
        return undefined
      },
      streamChat: async () => {
        streamStarted = true
      },
    })

    const sending = runtime.send({
      conversationId: conversation.id,
      userText: 'abort while setup is loading',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await setupStarted

    const [active] = runtime.listActiveStreams()
    assert(active, 'setup-stage turn should be visible as active')
    assertEqual(active.conversationId, conversation.id, 'setup-stage active conversation id')
    assertEqual(active.selection.modelId, 'contract/mock', 'setup-stage active model')

    const aborting = runtime.abort(conversation.id)
    await waitFor(() => cleanupReason === 'user', 'setup abort should notify host cleanup')
    releaseSetup()
    const result = await sending
    await aborting

    assertEqual(streamStarted, false, 'aborted setup should not start provider stream')
    assertEqual(runtime.listActiveStreams().length, 0, 'aborted setup should clear active turn')
    assertEqual(
      result.assistantMessageId,
      active.assistantMessageId,
      'send result should match setup-stage active assistant id',
    )

    const agentEvents = await listAgentEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'requested' &&
          event.data.reason === 'user',
      ),
      'setup abort should persist cancellation request',
    )
    assert(
      agentEvents.some(
        (event) =>
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'completed' &&
          event.messageId === active.assistantMessageId,
      ),
      'setup abort should persist completed cancellation',
    )
    assert(
      !agentEvents.some((event) => event.type === 'turn.failed'),
      'setup abort should not be recorded as a setup failure',
    )
    assert(
      events.some(
        (event) =>
          event.type === 'chat:error' &&
          event.data.messageId === active.assistantMessageId &&
          event.data.error === 'Aborted',
      ),
      'setup abort should emit chat:error for the assistant placeholder',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.messages.length, 2, 'setup abort should persist user and assistant')
    assertEqual(record.messages[1]?.id, active.assistantMessageId, 'setup abort assistant id')
    assertEqual(record.messages[1]?.status, 'error', 'setup abort assistant status')
    assertEqual(record.messages[1]?.error, 'Aborted', 'setup abort assistant error')
    assertEqual(record.meta.activity?.state, 'cancelled', 'setup abort activity state')
  })
}

async function testRuntimeSendRecoversTimedOutTurnSetupLock(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveFirstSetupStarted: () => void = () => {}
    const firstSetupStarted = new Promise<void>((resolve) => {
      resolveFirstSetupStarted = resolve
    })
    let cleanupReason: string | null = null
    let transientContextCalls = 0
    let streamCount = 0
    let firstSendSettled = false

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      logger: { warn() {}, error() {} },
      onConversationAbort: (_conversationId, reason) => {
        cleanupReason = reason
      },
      loadTransientContext: async () => {
        transientContextCalls += 1
        if (transientContextCalls === 1) {
          resolveFirstSetupStarted()
          await new Promise<void>(() => {})
        }
        return undefined
      },
      streamChat: async (req, handlers) => {
        streamCount += 1
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'replacement after setup timeout' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    void runtime
      .send({
        conversationId: conversation.id,
        userText: 'setup will not finish',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      })
      .then(
        () => {
          firstSendSettled = true
        },
        () => {
          firstSendSettled = true
        },
      )
    await firstSetupStarted

    const [active] = runtime.listActiveStreams()
    assert(active, 'stuck setup-stage turn should be visible as active')
    assertEqual(active.conversationId, conversation.id, 'stuck setup active conversation id')

    await withTimeout(runtime.abort(conversation.id), 'abort should time out setup cleanup', 500)
    assertEqual(cleanupReason, 'user', 'stuck setup abort cleanup reason')
    assertEqual(runtime.listActiveStreams().length, 0, 'stuck setup abort should clear active turn')

    const replacement = await withTimeout(
      runtime.send({
        conversationId: conversation.id,
        userText: 'replacement should start',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      }),
      'send should recover after a timed-out setup turn',
      500,
    )
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'replacement after stuck setup should finish',
    )

    assertEqual(firstSendSettled, false, 'stuck setup send should remain abandoned')
    assertEqual(transientContextCalls, 2, 'replacement should run a fresh setup phase')
    assertEqual(streamCount, 1, 'only replacement turn should reach provider stream')

    const agentEvents = await listAgentEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.messageId === active.assistantMessageId &&
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'requested' &&
          event.data.reason === 'user',
      ),
      'stuck setup abort should persist cancellation request',
    )
    assert(
      agentEvents.some(
        (event) =>
          event.messageId === active.assistantMessageId &&
          event.type === 'turn.interrupted' &&
          event.data?.reason === 'user cleanup timed out',
      ),
      'stuck setup abort should mark the abandoned turn interrupted',
    )
    assert(
      agentEvents.some(
        (event) =>
          event.messageId === replacement.assistantMessageId && event.type === 'turn.completed',
      ),
      'replacement turn after stuck setup should complete',
    )

    const record = await getConversation(conversation.id)
    assert(
      !record.messages.some((message) => message.id === active.assistantMessageId),
      'abandoned setup turn must not persist an assistant message',
    )
    assert(
      record.messages.some(
        (message) =>
          message.id === replacement.assistantMessageId &&
          message.role === 'assistant' &&
          message.status === 'done',
      ),
      'replacement assistant message should be persisted',
    )
  })
}

async function testRuntimeAbortPersistsCancellationActivity(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      streamChat: async (req, handlers) => {
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve()
            return
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
      },
    })

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'cancel this turn',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started
    await runtime.abort(conversation.id)

    await waitFor(
      () => events.some((event) => event.type === 'chat:error'),
      'abort should complete the active stream with an error message',
    )
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'agent:event' &&
            event.data.type === 'turn.cancelled' &&
            event.data.data?.phase === 'completed',
        ),
      'abort should persist completed cancellation activity',
    )

    const agentEvents = await listAgentEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) => event.type === 'turn.cancelled' && event.data?.phase === 'requested',
      ),
      'abort should persist user cancellation request',
    )
    assert(
      agentEvents.some(
        (event) => event.type === 'turn.cancelled' && event.data?.phase === 'completed',
      ),
      'abort should persist completed cancellation',
    )
    assert(
      !agentEvents.some((event) => event.type === 'turn.failed'),
      'abort should not be classified as a failed turn',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'cancelled', 'aborted activity state')
    assertEqual(record.meta.activity?.title, 'Stopped', 'aborted activity title')
    assertEqual(
      record.meta.activity?.messageId,
      result.assistantMessageId,
      'aborted activity should point at the assistant turn',
    )
    assertEqual(record.messages.length, 2, 'abort should persist user and assistant messages')
    assertEqual(record.messages[1]?.status, 'error', 'aborted assistant message status')
    assertEqual(record.messages[1]?.error, 'Aborted', 'aborted assistant message error')
  })
}

async function testRuntimeAbortTimesOutStuckStreamCleanup(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let cleanupReason: string | null = null

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      onConversationAbort: (_conversationId, reason) => {
        cleanupReason = reason
      },
      streamChat: async (req) => {
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>(() => {})
      },
    })

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'abort a stuck stream',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    await withTimeout(runtime.abort(conversation.id), 'abort should time out stuck cleanup', 500)
    assertEqual(cleanupReason, 'user', 'stuck abort cleanup reason')
    assertEqual(runtime.listActiveStreams().length, 0, 'stuck abort should clear active stream')

    const agentEvents = await listAgentEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.messageId === result.assistantMessageId &&
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'requested' &&
          event.data.reason === 'user',
      ),
      'stuck abort should persist user cancellation request',
    )
    assertEqual(
      agentEvents.at(-1)?.type,
      'turn.interrupted',
      'stuck abort should end with interrupted event',
    )
    assertEqual(
      agentEvents.at(-1)?.data?.reason,
      'user cleanup timed out',
      'stuck abort interrupted reason',
    )
    assertEqual(
      agentEvents.at(-1)?.data?.modelId,
      'contract/mock',
      'stuck abort interrupted event should preserve model id',
    )
    assertEqual(
      replayConversationRuntimeState(agentEvents).turn?.selection?.modelId,
      'contract/mock',
      'stuck abort replay should preserve model selection',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'interrupted', 'stuck abort activity state')
    assertEqual(
      record.meta.activity?.messageId,
      result.assistantMessageId,
      'stuck abort activity message id',
    )
    assert(
      events.some(
        (event) => event.type === 'agent:event' && event.data.type === 'turn.interrupted',
      ),
      'stuck abort should emit interrupted runtime event',
    )
  })
}

async function testRuntimeRepeatedAbortWaitsForSameCleanup(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let cleanupCalls = 0

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 50,
      logger: { warn() {}, error() {} },
      onConversationAbort: () => {
        cleanupCalls += 1
      },
      streamChat: async (req) => {
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>(() => {})
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'repeated abort stuck stream',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    const firstAbort = runtime.abort(conversation.id)
    await waitFor(() => cleanupCalls === 1, 'first repeated abort should notify cleanup')

    let secondAbortSettled = false
    const secondAbort = runtime.abort(conversation.id).then(
      () => {
        secondAbortSettled = true
      },
      () => {
        secondAbortSettled = true
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    assertEqual(
      secondAbortSettled,
      false,
      'repeated abort should wait for the already-aborted stream cleanup',
    )

    await withTimeout(firstAbort, 'first repeated abort should time out cleanup', 500)
    await withTimeout(secondAbort, 'second repeated abort should share cleanup timeout', 500)
    assertEqual(runtime.listActiveStreams().length, 0, 'repeated abort should clear active stream')

    const agentEvents = await listAgentEvents(conversation.id)
    const requestedCancellations = agentEvents.filter(
      (event) =>
        event.type === 'turn.cancelled' &&
        event.data?.phase === 'requested' &&
        event.data.reason === 'user',
    )
    const interrupted = agentEvents.filter(
      (event) =>
        event.type === 'turn.interrupted' && event.data?.reason === 'user cleanup timed out',
    )
    assertEqual(
      requestedCancellations.length,
      1,
      'repeated abort should persist one cancellation request',
    )
    assertEqual(
      interrupted.length,
      1,
      'repeated abort should persist one interrupted cleanup event',
    )
  })
}

async function testRuntimeUnexpectedStreamErrorPersistsFailureActivity(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      streamChat: async (req) => {
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        throw new Error('provider socket closed')
      },
    })

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'surface provider crash',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'chat:error' && event.data.messageId === result.assistantMessageId,
        ),
      'unexpected stream error should emit chat:error',
    )
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'agent:event' &&
            event.data.type === 'turn.failed' &&
            event.data.messageId === result.assistantMessageId,
        ),
      'unexpected stream error should persist failed activity',
    )

    const agentEvents = await listAgentEvents(conversation.id)
    assertEqual(agentEvents.at(-1)?.type, 'turn.failed', 'unexpected error final activity event')
    assertEqual(
      agentEvents.at(-1)?.data?.error,
      'provider socket closed',
      'unexpected error activity detail',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'failed', 'unexpected error activity state')
    assertEqual(record.meta.activity?.title, 'Error', 'unexpected error activity title')
    assertEqual(
      record.meta.activity?.messageId,
      result.assistantMessageId,
      'unexpected error activity message id',
    )
    assertEqual(record.messages.length, 2, 'unexpected error should persist user and assistant')
    assertEqual(record.messages[1]?.status, 'error', 'unexpected error assistant status')
    assertEqual(
      record.messages[1]?.error,
      'provider socket closed',
      'unexpected error assistant detail',
    )
  })
}

async function testRuntimeSetupFailurePersistsAssistantError(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      workspaceRoots: () => {
        throw new Error('workspace roots unavailable')
      },
      streamChat: async () => {
        throw new Error('stream should not start after setup failure')
      },
    })

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'fail before stream starts',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    assertEqual(runtime.listActiveStreams().length, 0, 'setup failure should not stay active')
    assert(
      events.some(
        (event) =>
          event.type === 'chat:error' && event.data.messageId === result.assistantMessageId,
      ),
      'setup failure should emit chat:error',
    )
    assert(
      events.some(
        (event) =>
          event.type === 'agent:event' &&
          event.data.type === 'turn.failed' &&
          event.data.messageId === result.assistantMessageId,
      ),
      'setup failure should emit persisted turn.failed event',
    )

    const agentEvents = await listAgentEvents(conversation.id)
    assertEqual(agentEvents.at(-1)?.type, 'turn.failed', 'setup failure final activity event')
    assertEqual(agentEvents.at(-1)?.data?.phase, 'setup', 'setup failure activity phase')
    assertEqual(
      agentEvents.at(-1)?.data?.providerId,
      'openrouter',
      'setup failure event should preserve provider id',
    )
    assertEqual(
      agentEvents.at(-1)?.data?.modelId,
      'contract/mock',
      'setup failure event should preserve model id',
    )
    assertEqual(
      agentEvents.at(-1)?.data?.error,
      'workspace roots unavailable',
      'setup failure activity detail',
    )
    const replayState = replayConversationRuntimeState(agentEvents)
    assertEqual(replayState.phase, 'failed', 'setup failure replay state')
    assertEqual(
      replayState.turn?.selection?.modelId,
      'contract/mock',
      'setup failure replay should preserve model selection',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'failed', 'setup failure activity state')
    assertEqual(
      record.meta.activity?.messageId,
      result.assistantMessageId,
      'setup failure activity message id',
    )
    assertEqual(record.messages.length, 2, 'setup failure should persist user and assistant')
    assertEqual(record.messages[1]?.status, 'error', 'setup failure assistant status')
    assertEqual(
      record.messages[1]?.error,
      'workspace roots unavailable',
      'setup failure assistant detail',
    )
  })
}

async function testRuntimeSetupFailureRejectsWhenConversationDeleted(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    let deleteStarted: Promise<void> | null = null
    let streamStarted = false
    let runtime: AgentRuntime

    runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      workspaceRoots: () => {
        deleteStarted = runtime.deleteConversation(conversation.id)
        throw new Error('workspace roots unavailable after delete')
      },
      streamChat: async () => {
        streamStarted = true
      },
    })

    let rejected = false
    try {
      await runtime.send({
        conversationId: conversation.id,
        userText: 'delete during setup failure',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      })
    } catch (error) {
      rejected = error instanceof Error && error.message.includes('deleted')
    }

    assert(rejected, 'setup failure after delete should reject the send')
    assertEqual(streamStarted, false, 'deleted setup failure should not start stream')
    assertEqual(runtime.listActiveStreams().length, 0, 'deleted setup failure should not be active')
    assert(
      !events.some((event) => event.type === 'chat:error'),
      'deleted setup failure should not emit chat:error',
    )

    if (deleteStarted) await deleteStarted
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'setup failure delete should remove conversation',
    )
    assertEqual(
      (await listAgentEvents(conversation.id)).length,
      0,
      'deleted setup failure should not recreate event log',
    )
  })
}

async function testRuntimeSetupFailureSuppressesChatErrorAfterDelete(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    let deleteStarted: Promise<void> | null = null
    let runtime: AgentRuntime

    runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      onEvent: (event) => {
        events.push(event)
        if (
          event.type === 'agent:event' &&
          event.data.type === 'turn.failed' &&
          event.data.messageId
        ) {
          deleteStarted = runtime.deleteConversation(conversation.id)
        }
      },
      logger: { warn() {}, error() {} },
      workspaceRoots: () => {
        throw new Error('workspace roots unavailable before delete')
      },
      streamChat: async () => {
        throw new Error('stream should not start after setup failure')
      },
    })

    let rejected = false
    try {
      await runtime.send({
        conversationId: conversation.id,
        userText: 'delete after setup activity',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      })
    } catch (error) {
      rejected = error instanceof Error && error.message.includes('deleted')
    }

    assert(rejected, 'setup failure after activity delete should reject the send')
    assert(
      events.some((event) => event.type === 'agent:event' && event.data.type === 'turn.failed'),
      'setup failure should emit activity before deletion',
    )
    assert(
      !events.some((event) => event.type === 'chat:error'),
      'setup failure should suppress chat:error after deletion',
    )

    if (deleteStarted) await deleteStarted
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'setup failure activity delete should remove conversation',
    )
    assertEqual(
      (await listAgentEvents(conversation.id)).length,
      0,
      'setup failure activity delete should remove event log',
    )
  })
}

async function testRuntimeListsActiveAssistantTurns(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    let resolveStream: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const release = new Promise<void>((resolve) => {
      resolveStream = resolve
    })
    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      streamChat: async (req, handlers) => {
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await release
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'listed active turn finished' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    const result = await runtime.send({
      conversationId: conversation.id,
      userText: 'list active turn',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    const [active] = runtime.listActiveStreams()
    assert(active, 'runtime should list active assistant turn')
    assertEqual(active.conversationId, conversation.id, 'active turn conversation id')
    assertEqual(
      active.assistantMessageId,
      result.assistantMessageId,
      'active turn assistant message id',
    )
    assertEqual(active.selection.modelId, 'contract/mock', 'active turn model id')

    let hydration = await runtime.hydrateConversation(conversation.id)
    assertEqual(
      hydration.activeTurn?.assistantMessageId,
      result.assistantMessageId,
      'runtime hydrate should include the live active assistant turn',
    )
    await waitFor(async () => {
      hydration = await runtime.hydrateConversation(conversation.id)
      return hydration.runtimeState.phase === 'running'
    }, 'runtime hydrate should replay active turn state')
    assertEqual(
      hydration.runtimeState.phase,
      'running',
      'runtime hydrate should include replay state while the turn is active',
    )

    resolveStream()
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'completed stream should leave active turn list',
    )
  })
}

async function testRuntimeDeleteRunsAbortCleanupBeforeWaitingForStream(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    let resolveStream: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const released = new Promise<void>((resolve) => {
      resolveStream = resolve
    })
    let cleanupConversationId: string | null = null
    let cleanupReason: string | null = null

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      onConversationAbort: (conversationId, reason) => {
        cleanupConversationId = conversationId
        cleanupReason = reason
        resolveStream()
      },
      streamChat: async (req, handlers) => {
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await released
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'delete while host approval is pending',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    await withTimeout(
      runtime.deleteConversation(conversation.id),
      'delete should run abort cleanup before waiting for stream cleanup',
    )
    assertEqual(cleanupConversationId, conversation.id, 'delete abort cleanup conversation id')
    assertEqual(cleanupReason, 'delete', 'delete abort cleanup reason')
    assertEqual(runtime.listActiveStreams().length, 0, 'delete should clear active stream')
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'delete should remove conversation after cleanup',
    )
  })
}

async function testRuntimeDeleteTimesOutStuckStreamAndSuppressesLateEvents(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    let resolveStarted: () => void = () => {}
    let resolveLateStream: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const lateRelease = new Promise<void>((resolve) => {
      resolveLateStream = resolve
    })
    let cleanupReason: string | null = null
    let lateStreamFinished = false

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      onConversationAbort: (_conversationId, reason) => {
        cleanupReason = reason
      },
      streamChat: async (req, handlers) => {
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await lateRelease
        handlers.onTextDelta({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          delta: 'late text after delete',
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'late done after delete' }],
            status: 'done',
            model: req.selection,
          },
        })
        lateStreamFinished = true
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'delete stuck stream',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    await withTimeout(
      runtime.deleteConversation(conversation.id),
      'delete should time out stuck stream cleanup',
      500,
    )
    assertEqual(cleanupReason, 'delete', 'stuck delete cleanup reason')
    assertEqual(runtime.listActiveStreams().length, 0, 'stuck delete should clear active stream')
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'stuck delete should remove conversation',
    )

    resolveLateStream()
    await waitFor(() => lateStreamFinished, 'late stream should be allowed to finish')
    assert(
      !(await listConversations()).some((record) => record.id === conversation.id),
      'late stream should not recreate deleted conversation',
    )
    assertEqual(
      (await listAgentEvents(conversation.id)).length,
      0,
      'late stream should not recreate deleted event log',
    )
    assert(
      !events.some((event) => event.type === 'chat:text-delta' || event.type === 'chat:done'),
      'late stream should not emit chat events after delete',
    )
  })
}

async function testRuntimeRejectsNewTurnsAfterDeleteStarts(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let streamCount = 0
    let streamFinished = false
    let resolveStarted: () => void = () => {}
    let resolveStream: () => void = () => {}
    let resolveAbortNotified: () => void = () => {}
    let resolveAbortCleanup: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const streamRelease = new Promise<void>((resolve) => {
      resolveStream = resolve
    })
    const abortNotified = new Promise<void>((resolve) => {
      resolveAbortNotified = resolve
    })
    const abortCleanup = new Promise<void>((resolve) => {
      resolveAbortCleanup = resolve
    })

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      logger: { warn() {}, error() {} },
      onConversationAbort: () => {
        resolveAbortNotified()
        return abortCleanup
      },
      streamChat: async () => {
        streamCount += 1
        resolveStarted()
        await streamRelease
        streamFinished = true
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'first turn before delete',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    const deleting = runtime.deleteConversation(conversation.id)
    await abortNotified

    for (const operation of ['send', 'retry'] as const) {
      let rejected = false
      try {
        if (operation === 'send') {
          await runtime.send({
            conversationId: conversation.id,
            userText: 'send after delete starts',
            selection: { providerId: 'openrouter', modelId: 'contract/mock' },
          })
        } else {
          await runtime.retryLastUserMessage({
            conversationId: conversation.id,
            selection: { providerId: 'openrouter', modelId: 'contract/mock' },
          })
        }
      } catch (error) {
        rejected = error instanceof Error && error.message.includes('deleted')
      }
      assert(rejected, `${operation} should reject after delete starts`)
    }

    assertEqual(streamCount, 1, 'deleted conversation should not start a replacement stream')
    resolveAbortCleanup()
    await withTimeout(deleting, 'delete should finish after rejecting new turns', 500)
    assertEqual(runtime.listActiveStreams().length, 0, 'delete should clear original stream')

    resolveStream()
    await waitFor(() => streamFinished, 'original stream should be released')
    assertEqual(streamCount, 1, 'late stream release should not start another stream')
  })
}

async function testRuntimeDeleteFailureReopensConversation(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const conversationsDir = getConversationsDir()
    let streamCount = 0
    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      streamChat: async (req, handlers) => {
        streamCount += 1
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'send after failed delete works' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    let deleteFailed = false
    await chmod(conversationsDir, 0o500)
    try {
      await runtime.deleteConversation(conversation.id)
    } catch {
      deleteFailed = true
    } finally {
      await chmod(conversationsDir, 0o700)
    }
    assert(deleteFailed, 'delete should fail while conversations dir is not writable')

    await runtime.send({
      conversationId: conversation.id,
      userText: 'continue after failed delete',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'send after failed delete should finish',
    )

    const record = await getConversation(conversation.id)
    assertEqual(streamCount, 1, 'failed delete should not permanently tombstone conversation')
    assert(
      record.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.blocks.some(
            (block) => block.type === 'text' && block.content === 'send after failed delete works',
          ),
      ),
      'failed delete should allow later assistant persistence',
    )
  })
}

async function testRuntimeDeleteFailureRecordsCancellationForReopenedTurn(): Promise<void> {
  const baseStore = createInMemoryRuntimeStore()
  const conversation = await baseStore.createConversation?.()
  assert(conversation, 'in-memory store should create conversation for delete failure contract')
  const store: AgentRuntimeStore = {
    ...baseStore,
    deleteConversation: async () => {
      throw new Error('contract delete failed')
    },
  }
  let streamCount = 0
  let resolveStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const runtime = new AgentRuntime({
    store,
    logger: { warn() {}, error() {} },
    streamChat: async (req, handlers) => {
      streamCount += 1
      req.onAgentEvent?.({
        timestamp: Date.now(),
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        type: 'turn.started',
        data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
      })
      if (streamCount === 1) {
        resolveStarted()
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve()
            return
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
        return
      }

      req.onAgentEvent?.({
        timestamp: Date.now(),
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        type: 'turn.completed',
      })
      await handlers.onDone({
        conversationId: req.conversationId,
        messageId: req.assistantMessageId,
        message: {
          schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: req.assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'text', content: 'continued after failed active delete' }],
          status: 'done',
          model: req.selection,
        },
      })
    },
  })

  await runtime.send({
    conversationId: conversation.id,
    userText: 'delete active stream but fail',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await started

  let deleteFailed = false
  try {
    await runtime.deleteConversation(conversation.id)
  } catch (error) {
    deleteFailed = error instanceof Error && error.message.includes('contract delete failed')
  }
  assert(deleteFailed, 'active delete failure should reject')
  assertEqual(runtime.listActiveStreams().length, 0, 'failed active delete should clear stream')

  const events = [...((await store.listAgentEvents?.(conversation.id)) ?? [])]
  assert(
    events.some(
      (event) =>
        event.type === 'turn.cancelled' &&
        event.data?.phase === 'requested' &&
        event.data.reason === 'delete',
    ),
    'failed active delete should persist delete cancellation before reopening conversation',
  )

  await runtime.send({
    conversationId: conversation.id,
    userText: 'continue after failed active delete',
    selection: { providerId: 'openrouter', modelId: 'contract/mock' },
  })
  await waitFor(
    () => runtime.listActiveStreams().length === 0,
    'send after failed active delete should finish',
  )
  const record = await store.getConversation(conversation.id)
  assert(
    record.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.blocks.some(
          (block) =>
            block.type === 'text' && block.content === 'continued after failed active delete',
        ),
    ),
    'failed active delete should reopen conversation for later persistence',
  )
}

async function testRuntimeSendRecoversAbortedStuckPreviousStream(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    let resolveFirstStarted: () => void = () => {}
    let resolveFirstLateStream: () => void = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve
    })
    const firstLateRelease = new Promise<void>((resolve) => {
      resolveFirstLateStream = resolve
    })
    let streamCount = 0
    let firstLateStreamFinished = false

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      onEvent: (event) => events.push(event),
      logger: { warn() {}, error() {} },
      streamChat: async (req, handlers) => {
        streamCount += 1
        const callIndex = streamCount
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })

        if (callIndex === 1) {
          resolveFirstStarted()
          await firstLateRelease
          req.onAgentEvent?.({
            timestamp: Date.now(),
            conversationId: req.conversationId,
            messageId: req.assistantMessageId,
            type: 'turn.completed',
          })
          await handlers.onDone({
            conversationId: req.conversationId,
            messageId: req.assistantMessageId,
            message: {
              schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
              id: req.assistantMessageId,
              role: 'assistant',
              blocks: [{ type: 'text', content: 'late abandoned answer' }],
              status: 'done',
              model: req.selection,
            },
          })
          firstLateStreamFinished = true
          return
        }

        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.completed',
        })
        await handlers.onDone({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'text', content: 'second answer after recovery' }],
            status: 'done',
            model: req.selection,
          },
        })
      },
    })

    const first = await runtime.send({
      conversationId: conversation.id,
      userText: 'first turn will ignore abort',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await firstStarted
    await runtime.abort(conversation.id)
    assertEqual(
      runtime.listActiveStreams().length,
      0,
      'abort should recover the stuck first stream',
    )

    const second = await withTimeout(
      runtime.send({
        conversationId: conversation.id,
        userText: 'second turn should recover',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      }),
      'send should recover an aborted stuck previous stream',
      500,
    )
    assertEqual(streamCount, 2, 'send should start a replacement stream after recovery')
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'replacement stream should finish',
    )

    const agentEvents = await listAgentEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.messageId === first.assistantMessageId &&
          event.type === 'turn.interrupted' &&
          event.data?.reason === 'user cleanup timed out',
      ),
      'abort should mark the abandoned first turn interrupted',
    )
    assert(
      agentEvents.some(
        (event) => event.messageId === second.assistantMessageId && event.type === 'turn.completed',
      ),
      'replacement turn should complete',
    )

    resolveFirstLateStream()
    await waitFor(() => firstLateStreamFinished, 'abandoned stream should be allowed to unwind')

    const record = await getConversation(conversation.id)
    assert(
      !record.messages.some((message) => message.id === first.assistantMessageId),
      'late abandoned stream must not persist its assistant message',
    )
    assert(
      !record.messages.some((message) =>
        JSON.stringify(message.blocks).includes('late abandoned answer'),
      ),
      'late abandoned stream must not write stale assistant content',
    )
    assert(
      !events.some(
        (event) => event.type === 'chat:done' && event.data.messageId === first.assistantMessageId,
      ),
      'late abandoned stream must not emit chat:done',
    )
  })
}

async function testRuntimeAbortAllWaitsForShutdownCleanup(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let cleanupConversationId: string | null = null
    let cleanupReason: string | null = null
    let streamFinished = false

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      onConversationAbort: (conversationId, reason) => {
        cleanupConversationId = conversationId
        cleanupReason = reason
      },
      streamChat: async (req, handlers) => {
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve()
            return
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
        streamFinished = true
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'shutdown while streaming',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    await withTimeout(runtime.abortAll('shutdown'), 'abortAll should wait for shutdown cleanup')
    assertEqual(cleanupConversationId, conversation.id, 'abortAll cleanup conversation id')
    assertEqual(cleanupReason, 'shutdown', 'abortAll cleanup reason')
    assertEqual(streamFinished, true, 'abortAll should wait for stream cleanup')
    assertEqual(runtime.listActiveStreams().length, 0, 'abortAll should clear active stream')

    const agentEvents = await listAgentEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'requested' &&
          event.data.reason === 'shutdown',
      ),
      'abortAll should persist shutdown cancellation request',
    )
    assert(
      agentEvents.some(
        (event) => event.type === 'turn.cancelled' && event.data?.phase === 'completed',
      ),
      'abortAll should persist completed cancellation',
    )
  })
}

async function testRuntimeAbortAllTimesOutStuckStreamCleanup(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let cleanupReason: string | null = null

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      abortAllCleanupTimeoutMs: 10,
      logger: { warn() {}, error() {} },
      onConversationAbort: (_conversationId, reason) => {
        cleanupReason = reason
      },
      streamChat: async (req) => {
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>(() => {})
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'shutdown stuck stream',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    await withTimeout(runtime.abortAll('shutdown'), 'abortAll should time out stuck cleanup', 500)
    assertEqual(cleanupReason, 'shutdown', 'stuck abortAll cleanup reason')
    assertEqual(runtime.listActiveStreams().length, 0, 'stuck cleanup should clear active stream')

    const agentEvents = await listAgentEvents(conversation.id)
    assert(
      agentEvents.some(
        (event) =>
          event.type === 'turn.cancelled' &&
          event.data?.phase === 'requested' &&
          event.data.reason === 'shutdown',
      ),
      'stuck cleanup should persist shutdown cancellation request',
    )
    assertEqual(
      agentEvents.at(-1)?.type,
      'turn.interrupted',
      'stuck cleanup should end with interrupted event',
    )
    assertEqual(
      agentEvents.at(-1)?.data?.reason,
      'shutdown cleanup timed out',
      'stuck cleanup interrupted reason',
    )

    const record = await getConversation(conversation.id)
    assertEqual(record.meta.activity?.state, 'interrupted', 'stuck cleanup activity state')
    assertEqual(record.meta.activity?.title, 'Interrupted', 'stuck cleanup activity title')
  })
}

async function testRuntimeShutdownRejectsNewTurns(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let streamCount = 0
    let streamFinished = false

    const runtime = new AgentRuntime({
      store: createPersistedRuntimeStore(),
      logger: { warn() {}, error() {} },
      streamChat: async (req, handlers) => {
        streamCount += 1
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.started',
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
        })
        resolveStarted()
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve()
            return
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        req.onAgentEvent?.({
          timestamp: Date.now(),
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          type: 'turn.cancelled',
          data: { phase: 'completed', reason: 'abort_signal' },
        })
        await handlers.onError({
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          error: 'Aborted',
          message: {
            schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
            id: req.assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: 'Aborted',
            model: req.selection,
          },
        })
        streamFinished = true
      },
    })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'start before shutdown',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await started

    const firstShutdown = runtime.shutdown()
    const secondShutdown = runtime.shutdown()
    assertEqual(firstShutdown, secondShutdown, 'shutdown should be idempotent')

    for (const operation of ['send', 'retry'] as const) {
      let rejected = false
      try {
        if (operation === 'send') {
          await runtime.send({
            conversationId: conversation.id,
            userText: 'send after shutdown starts',
            selection: { providerId: 'openrouter', modelId: 'contract/mock' },
          })
        } else {
          await runtime.retryLastUserMessage({
            conversationId: conversation.id,
            selection: { providerId: 'openrouter', modelId: 'contract/mock' },
          })
        }
      } catch (error) {
        rejected = error instanceof Error && error.message.includes('shut down')
      }
      assert(rejected, `${operation} should reject after shutdown starts`)
    }

    await withTimeout(firstShutdown, 'shutdown should settle active stream')
    assertEqual(streamFinished, true, 'shutdown should wait for active stream cleanup')
    assertEqual(runtime.listActiveStreams().length, 0, 'shutdown should clear active streams')
    assertEqual(streamCount, 1, 'shutdown should not start replacement streams')

    let rejectedAfterShutdown = false
    try {
      await runtime.send({
        conversationId: conversation.id,
        userText: 'send after shutdown finishes',
        selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      })
    } catch (error) {
      rejectedAfterShutdown = error instanceof Error && error.message.includes('shut down')
    }
    assert(rejectedAfterShutdown, 'send should reject after shutdown finishes')
  })
}

async function testPersistenceContract(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation('docs@aila/agent-contract')
    assertEqual(
      conversation.schemaVersion,
      AILA_CONVERSATION_META_SCHEMA_VERSION,
      'new conversation meta version',
    )

    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'message-1',
      role: 'user',
      blocks: [{ type: 'text', content: 'hello contract' }],
      status: 'done',
    })

    const record = await getConversation(conversation.id)
    assertEqual(
      record.meta.schemaVersion,
      AILA_CONVERSATION_META_SCHEMA_VERSION,
      'read conversation meta version',
    )
    assertEqual(
      record.messages[0]?.schemaVersion,
      AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      'read persisted message version',
    )

    const dir = getConversationsDir()
    const rawMeta = JSON.parse(
      await readFile(join(dir, `${conversation.id}.meta.json`), 'utf-8'),
    ) as { schemaVersion?: number }
    const rawMessage = JSON.parse(
      (await readFile(join(dir, `${conversation.id}.jsonl`), 'utf-8')).trim(),
    ) as { schemaVersion?: number }
    assertEqual(
      rawMeta.schemaVersion,
      AILA_CONVERSATION_META_SCHEMA_VERSION,
      'written meta version',
    )
    assertEqual(
      rawMessage.schemaVersion,
      AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      'written message version',
    )

    await appendAgentEvent(conversation.id, {
      timestamp: 1,
      conversationId: conversation.id,
      messageId: 'message-1',
      type: 'tool.approval.requested',
      data: { toolName: 'write', requestId: 'approval-1', risk: 'destructive write' },
    })
    const events = await listAgentEvents(conversation.id)
    assertEqual(events.length, 1, 'agent events should be readable')
    const [event] = events
    assert(event, 'listed agent event should exist')
    assertEqual(event.schemaVersion, AILA_AGENT_EVENT_SCHEMA_VERSION, 'listed event version')
    assertEqual(event.type, 'tool.approval.requested', 'listed event type')
    const rawAgentEvent = JSON.parse(
      (await readFile(join(dir, `${conversation.id}.events.jsonl`), 'utf-8')).trim(),
    ) as { schemaVersion?: number }
    assertEqual(
      rawAgentEvent.schemaVersion,
      AILA_AGENT_EVENT_SCHEMA_VERSION,
      'written agent event version',
    )

    const runtimeEvent = createRuntimeEvent('agent:event', event)
    assertEqual(runtimeEvent.type, 'agent:event', 'agent event runtime wrapper type')
  })
}

async function testMessageUpsertPreventsDuplicatePersistedMessages(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'assistant-message',
      role: 'assistant',
      blocks: [{ type: 'text', content: 'first answer' }],
      status: 'done',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await upsertMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'assistant-message',
      role: 'assistant',
      blocks: [],
      status: 'error',
      error: 'replacement error',
      model: { providerId: 'openrouter', modelId: 'contract/mock' },
    })

    const record = await getConversation(conversation.id)
    assertEqual(record.messages.length, 1, 'upsert should not duplicate message ids')
    assertEqual(record.messages[0]?.id, 'assistant-message', 'upserted message id')
    assertEqual(record.messages[0]?.status, 'error', 'upserted message status')
    assertEqual(record.messages[0]?.error, 'replacement error', 'upserted message error')

    const rawMessages = (
      await readFile(join(getConversationsDir(), `${conversation.id}.jsonl`), 'utf-8')
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    assertEqual(rawMessages.length, 1, 'upsert should rewrite duplicate jsonl lines')
  })
}

async function testAgentEventReplayDeduplicatesExactDuplicates(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const event = {
      timestamp: 42,
      conversationId: conversation.id,
      messageId: 'assistant-message',
      type: 'tool.execution.started' as const,
      data: { toolCallId: 'tool-call', toolName: 'read_file' },
    }

    await appendAgentEvent(conversation.id, event)
    await appendAgentEvent(conversation.id, event)

    const events = await listAgentEvents(conversation.id)
    assertEqual(events.length, 1, 'duplicate agent events should collapse during replay')
    assertEqual(events[0]?.type, 'tool.execution.started', 'deduped event type')
    assertEqual(events[0]?.data?.toolName, 'read_file', 'deduped event data')

    const rawEvents = (
      await readFile(join(getConversationsDir(), `${conversation.id}.events.jsonl`), 'utf-8')
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    assertEqual(rawEvents.length, 2, 'event log should remain append-only on disk')
  })
}

async function testAgentEventReplayPreservesAppendOrderForSameTimestamp(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const timestamp = 100
    const events: AgentEvent[] = [
      {
        timestamp,
        conversationId: conversation.id,
        messageId: 'assistant-same-timestamp',
        type: 'turn.started',
        data: { providerId: 'openrouter', modelId: 'contract/mock' },
      },
      {
        timestamp,
        conversationId: conversation.id,
        messageId: 'assistant-same-timestamp',
        type: 'tool.approval.requested',
        data: {
          requestId: 'approval-same-timestamp',
          toolCallId: 'tool-call',
          toolName: 'write',
        },
      },
      {
        timestamp,
        conversationId: conversation.id,
        messageId: 'assistant-same-timestamp',
        type: 'tool.approval.requested',
        data: {
          requestId: 'approval-same-timestamp',
          toolCallId: 'tool-call',
          toolName: 'write',
        },
      },
      {
        timestamp,
        conversationId: conversation.id,
        messageId: 'assistant-same-timestamp',
        type: 'tool.approval.resolved',
        data: { requestId: 'approval-same-timestamp', approved: true, reason: 'user' },
      },
      {
        timestamp,
        conversationId: conversation.id,
        messageId: 'assistant-same-timestamp',
        type: 'turn.completed',
        data: { outputBlockCount: 1 },
      },
    ]

    for (const event of events) await appendAgentEvent(conversation.id, event)

    const listed = await listAgentEvents(conversation.id)
    assertEqual(listed.length, 4, 'same-timestamp replay should deduplicate exact duplicates')
    assertEqual(
      listed.map((event) => event.type).join(','),
      'turn.started,tool.approval.requested,tool.approval.resolved,turn.completed',
      'same-timestamp replay should preserve append order after sorting',
    )

    const runtimeState = replayConversationRuntimeState(listed)
    assertEqual(runtimeState.phase, 'completed', 'same-timestamp replay terminal phase')
    assertEqual(runtimeState.active, false, 'same-timestamp terminal replay should be inactive')
    assertEqual(
      runtimeState.turn?.pendingApproval,
      undefined,
      'same-timestamp approval resolution should clear pending approval before terminal replay',
    )
    assertEqual(
      replayConversationActivity(listed)?.eventType,
      'turn.completed',
      'same-timestamp activity should use the last replay event',
    )

    const recovered = await recoverInterruptedConversationActivities('same timestamp restart')
    assert(
      !recovered.some((summary) => summary.id === conversation.id),
      'same-timestamp completed replay should not recover as interrupted',
    )
    assert(
      !(await listAgentEvents(conversation.id)).some((event) => event.type === 'turn.interrupted'),
      'same-timestamp completed replay should not append interrupted recovery',
    )
  })
}

function testAgentEventReplayDerivesLatestActivity(): void {
  const events: PersistedAgentEvent[] = [
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 30,
      conversationId: 'conversation-replay',
      messageId: 'assistant-replay',
      type: 'turn.completed' as const,
    },
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 10,
      conversationId: 'conversation-replay',
      messageId: 'assistant-replay',
      type: 'turn.started' as const,
      data: { modelId: 'contract/mock' },
    },
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 20,
      conversationId: 'conversation-replay',
      messageId: 'assistant-replay',
      type: 'tool.input.delta' as const,
      data: { deltaSize: 20 },
    },
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 30,
      conversationId: 'conversation-replay',
      messageId: 'assistant-replay',
      type: 'turn.completed' as const,
    },
  ]

  const activity = replayConversationActivity(events)
  assert(activity, 'event replay should derive an activity')
  assertEqual(activity.state, 'completed', 'event replay should use latest non-delta activity')
  assertEqual(activity.eventType, 'turn.completed', 'event replay activity event type')
  assertEqual(activity.updatedAt, 30, 'event replay activity timestamp')
}

function testAgentEventReplayDerivesRuntimeState(): void {
  const baseEvents: PersistedAgentEvent[] = [
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 10,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'turn.started',
      data: {
        providerId: 'openrouter',
        modelId: 'contract/mock',
        inputMessageCount: 2,
      },
    },
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 20,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'tool.approval.requested',
      data: {
        requestId: 'approval-request',
        toolCallId: 'tool-call',
        toolName: 'write',
      },
    },
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 20,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'tool.approval.requested',
      data: {
        requestId: 'approval-request',
        toolCallId: 'tool-call',
        toolName: 'write',
      },
    },
  ]

  const approvalState = replayConversationRuntimeState(baseEvents)
  assertEqual(approvalState.phase, 'approval', 'approval request should be active runtime state')
  assertEqual(approvalState.active, true, 'approval request should be active')
  assertEqual(
    approvalState.turn?.assistantMessageId,
    'assistant-runtime-replay',
    'runtime replay assistant message id',
  )
  assertEqual(
    approvalState.turn?.selection?.modelId,
    'contract/mock',
    'runtime replay should preserve model selection',
  )
  assertEqual(
    approvalState.turn?.pendingApproval?.requestId,
    'approval-request',
    'runtime replay should preserve pending approval',
  )

  const resolvedState = replayConversationRuntimeState([
    ...baseEvents,
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 30,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'tool.approval.resolved',
      data: { requestId: 'approval-request', approved: false, reason: 'user' },
    },
  ])
  assertEqual(
    resolvedState.phase,
    'running',
    'approval resolution should not be treated as a turn terminal',
  )
  assertEqual(resolvedState.active, true, 'resolved approval should remain active')
  assertEqual(
    resolvedState.turn?.pendingApproval,
    undefined,
    'resolved approval should clear pending approval',
  )

  const cancellingState = replayConversationRuntimeState([
    ...baseEvents,
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 40,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'turn.cancelled',
      data: { phase: 'requested', reason: 'user' },
    },
  ])
  assertEqual(cancellingState.phase, 'cancelling', 'requested cancellation should not be terminal')
  assertEqual(cancellingState.active, true, 'requested cancellation should remain active')

  const cancelledState = replayConversationRuntimeState([
    ...baseEvents,
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 40,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'turn.cancelled',
      data: { phase: 'requested', reason: 'user' },
    },
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 50,
      conversationId: 'conversation-runtime-replay',
      messageId: 'assistant-runtime-replay',
      type: 'turn.cancelled',
      data: { phase: 'completed', reason: 'abort_signal' },
    },
  ])
  assertEqual(cancelledState.phase, 'cancelled', 'completed cancellation should be terminal')
  assertEqual(cancelledState.active, false, 'completed cancellation should not be active')
}

function testAgentEventReplayKeepsToolFailureActive(): void {
  const events: PersistedAgentEvent[] = [
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 10,
      conversationId: 'conversation-tool-failure-replay',
      messageId: 'assistant-tool-failure-replay',
      type: 'turn.started',
      data: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 20,
      conversationId: 'conversation-tool-failure-replay',
      messageId: 'assistant-tool-failure-replay',
      type: 'tool.execution.failed',
      data: {
        toolCallId: 'tool-call',
        toolName: 'write',
        error: 'contract tool failure',
      },
    },
  ]

  const activity = replayConversationActivity(events)
  const runtimeState = replayConversationRuntimeState(events)
  assertEqual(activity?.state, 'failed', 'tool failure should remain visible in activity')
  assertEqual(
    runtimeState.phase,
    'running',
    'tool failure should not be treated as a turn terminal',
  )
  assertEqual(runtimeState.active, true, 'tool failure should remain active until a turn terminal')
}

function testInterruptedRecoveryEventHelper(): void {
  const activeEvents: PersistedAgentEvent[] = [
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 10,
      conversationId: 'conversation-recovery-helper',
      messageId: 'assistant-recovery-helper',
      type: 'turn.started',
      data: { providerId: 'openrouter', modelId: 'contract/mock' },
    },
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 20,
      conversationId: 'conversation-recovery-helper',
      messageId: 'assistant-recovery-helper',
      type: 'tool.execution.failed',
      data: {
        toolCallId: 'tool-call',
        toolName: 'write',
        error: 'contract tool failure',
      },
    },
  ]

  const recoveryEvent = createInterruptedConversationRecoveryEvent(activeEvents, {
    reason: 'contract restart',
    timestamp: 30,
    activity: {
      state: 'failed',
      title: 'Tool failed: write',
      updatedAt: 20,
      eventType: 'tool.execution.failed',
      messageId: 'assistant-recovery-helper',
      toolName: 'write',
    },
  })

  assert(recoveryEvent, 'active runtime state should create interrupted recovery event')
  assertEqual(recoveryEvent.timestamp, 30, 'recovery helper timestamp')
  assertEqual(recoveryEvent.conversationId, 'conversation-recovery-helper', 'recovery conversation')
  assertEqual(recoveryEvent.messageId, 'assistant-recovery-helper', 'recovery assistant message')
  assertEqual(recoveryEvent.type, 'turn.interrupted', 'recovery event type')
  assertEqual(recoveryEvent.data?.previousState, 'running', 'recovery previous state')
  assertEqual(recoveryEvent.data?.providerId, 'openrouter', 'recovery provider id')
  assertEqual(recoveryEvent.data?.modelId, 'contract/mock', 'recovery model id')
  assertEqual(
    recoveryEvent.data?.previousEventType,
    'tool.execution.failed',
    'recovery previous event type',
  )
  assertEqual(recoveryEvent.data?.previousTitle, 'Tool failed: write', 'recovery previous title')

  const terminalEvent = createInterruptedConversationRecoveryEvent([
    ...activeEvents,
    {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 40,
      conversationId: 'conversation-recovery-helper',
      messageId: 'assistant-recovery-helper',
      type: 'turn.completed',
    },
  ])
  assertEqual(terminalEvent, null, 'terminal runtime state should not create recovery event')
}

async function testInterruptedRecoveryUsesEventReplayOverStaleMeta(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendAgentEventAndTouchConversation(conversation.id, {
      timestamp: 10,
      conversationId: conversation.id,
      messageId: 'assistant-stale-meta',
      type: 'turn.started',
      data: { modelId: 'contract/mock' },
    })
    await appendAgentEvent(conversation.id, {
      timestamp: 20,
      conversationId: conversation.id,
      messageId: 'assistant-stale-meta',
      type: 'turn.completed',
    })

    const before = await getConversation(conversation.id)
    assertEqual(before.meta.activity?.state, 'running', 'fixture should start with stale meta')

    const recovered = await recoverInterruptedConversationActivities('contract restart')
    assertEqual(
      recovered.some((summary) => summary.id === conversation.id),
      false,
      'completed replay should not be recovered as interrupted',
    )

    const events = await listAgentEvents(conversation.id)
    assert(
      !events.some((event) => event.type === 'turn.interrupted'),
      'completed replay should not append interrupted event',
    )
    const after = await getConversation(conversation.id)
    assertEqual(after.meta.activity?.state, 'completed', 'recovery should repair stale activity')
    assertEqual(
      after.meta.activity?.eventType,
      'turn.completed',
      'recovery should repair activity event type from replay',
    )
  })
}

async function testInterruptedRecoveryFallsBackToLegacyMetaActivity(): Promise<void> {
  await withTempDataDir(async () => {
    const dir = getConversationsDir()
    await mkdir(dir, { recursive: true })
    const id = 'legacy-running-activity'
    await writeFile(
      join(dir, `${id}.meta.json`),
      `${JSON.stringify(
        {
          schemaVersion: AILA_CONVERSATION_META_SCHEMA_VERSION,
          id,
          title: 'legacy activity',
          createdAt: 1,
          updatedAt: 2,
          activity: {
            state: 'running',
            title: 'Model streaming',
            updatedAt: 2,
            eventType: 'turn.started',
            messageId: 'legacy-assistant',
          },
        },
        null,
        2,
      )}\n`,
      'utf-8',
    )

    const recovered = await recoverInterruptedConversationActivities('contract restart')
    assert(
      recovered.some((summary) => summary.id === id),
      'legacy running meta activity should recover as interrupted',
    )

    const events = await listAgentEvents(id)
    const interrupted = events.find((event) => event.type === 'turn.interrupted')
    assert(interrupted, 'legacy meta fallback should append interrupted event')
    assertEqual(
      interrupted.data?.previousState,
      'running',
      'legacy recovery should preserve previous state',
    )
    assertEqual(
      interrupted.data?.previousEventType,
      'turn.started',
      'legacy recovery should preserve previous event type',
    )
  })
}

async function testInterruptedRecoveryUsesRuntimeReplayForNonTerminalToolFailure(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    await appendAgentEventAndTouchConversation(conversation.id, {
      timestamp: 10,
      conversationId: conversation.id,
      messageId: 'assistant-tool-failure-recovery',
      type: 'turn.started',
      data: { providerId: 'openrouter', modelId: 'contract/mock' },
    })
    await appendAgentEventAndTouchConversation(conversation.id, {
      timestamp: 20,
      conversationId: conversation.id,
      messageId: 'assistant-tool-failure-recovery',
      type: 'tool.execution.failed',
      data: {
        toolCallId: 'tool-call',
        toolName: 'write',
        error: 'contract tool failure',
      },
    })

    const before = await getConversation(conversation.id)
    assertEqual(before.meta.activity?.state, 'failed', 'fixture should have failed activity')

    const recovered = await recoverInterruptedConversationActivities('contract restart')
    assert(
      recovered.some((summary) => summary.id === conversation.id),
      'non-terminal tool failure should be recovered as interrupted',
    )

    const events = await listAgentEvents(conversation.id)
    const interrupted = events.find((event) => event.type === 'turn.interrupted')
    assert(interrupted, 'runtime replay recovery should append interrupted event')
    assertEqual(
      interrupted.data?.previousEventType,
      'tool.execution.failed',
      'interrupted event should preserve previous runtime event',
    )
    assertEqual(
      interrupted.data?.previousState,
      'running',
      'interrupted event should use runtime lifecycle state',
    )
    assertEqual(
      interrupted.data?.modelId,
      'contract/mock',
      'runtime replay recovery should preserve model id',
    )
  })
}

async function testLegacyPersistenceNormalization(): Promise<void> {
  await withTempDataDir(async () => {
    const dir = getConversationsDir()
    await mkdir(dir, { recursive: true })
    const id = 'legacy-conversation'
    await writeFile(
      join(dir, `${id}.meta.json`),
      JSON.stringify({ id, title: 'legacy', createdAt: 1, updatedAt: 2 }),
      'utf-8',
    )
    await writeFile(
      join(dir, `${id}.jsonl`),
      `${JSON.stringify({
        id: 'legacy-message',
        role: 'user',
        blocks: [{ type: 'text', content: 'old format' }],
        status: 'done',
      })}\n${JSON.stringify({
        id: 'legacy-message',
        role: 'user',
        blocks: [{ type: 'text', content: 'old format updated' }],
        status: 'done',
      })}\n`,
      'utf-8',
    )

    const record = await getConversation(id)
    const [summary] = await listConversations()
    assertEqual(
      record.meta.schemaVersion,
      AILA_CONVERSATION_META_SCHEMA_VERSION,
      'legacy meta normalized',
    )
    assertEqual(
      summary?.schemaVersion,
      AILA_CONVERSATION_META_SCHEMA_VERSION,
      'legacy summary normalized',
    )
    assertEqual(
      record.messages[0]?.schemaVersion,
      AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      'legacy message normalized',
    )
    assertEqual(record.messages.length, 1, 'duplicate legacy message ids should be collapsed')
    assertEqual(
      record.messages[0]?.blocks[0]?.type === 'text' ? record.messages[0].blocks[0].content : '',
      'old format updated',
      'duplicate legacy message should keep latest content',
    )
  })
}

async function testImmediateToolApprovalActivityHelper(): Promise<void> {
  const recorded: AgentEvent[] = []
  const request: ToolApprovalRequest = {
    name: 'write',
    args: {
      path: '/workspace/contract.md',
      content: 'approval helper',
      nested: { value: 'original' },
    },
    metadata: {
      name: 'write',
      readOnly: false,
      destructive: true,
      requiresApproval: true,
      access: ['write'],
      scope: ['workspace'],
    },
    conversationId: 'conversation-approval-helper',
    messageId: 'assistant-approval-helper',
    toolCallId: 'tool-call-approval-helper',
  }

  let approveSawOriginal = false
  const approved = await requestToolApprovalWithActivity({
    request,
    createId: () => 'approval-contract-id',
    approve: async (approvalRequest) => {
      approveSawOriginal =
        approvalRequest.args.path === '/workspace/contract.md' &&
        (approvalRequest.args.nested as { value?: unknown }).value === 'original' &&
        approvalRequest.metadata.access.includes('write')
      approvalRequest.args.path = '/workspace/approval-mutated.md'
      const nested = approvalRequest.args.nested as { value?: string }
      nested.value = 'approval-mutated'
      approvalRequest.metadata.access.push('shell')
      return true
    },
    recordAgentEvent: async (_conversationId, event) => {
      recorded.push(event)
    },
  })

  assertEqual(approved, true, 'approval helper should return host approval result')
  assertEqual(approveSawOriginal, true, 'approval helper should pass an approval snapshot')
  assertEqual(request.args.path, '/workspace/contract.md', 'approval helper should isolate args')
  assertEqual(
    (request.args.nested as { value?: unknown }).value,
    'original',
    'approval helper should isolate nested args',
  )
  assertEqual(
    request.metadata.access.includes('shell'),
    false,
    'approval helper should isolate metadata',
  )
  assertEqual(recorded.length, 2, 'approval helper should record requested and resolved events')
  assertEqual(recorded[0]?.type, 'tool.approval.requested', 'approval helper requested event')
  assertEqual(recorded[1]?.type, 'tool.approval.resolved', 'approval helper resolved event')
  assertEqual(
    recorded[0]?.conversationId,
    'conversation-approval-helper',
    'approval helper requested conversation',
  )
  assertEqual(recorded[0]?.messageId, 'assistant-approval-helper', 'approval helper message id')
  assertEqual(recorded[0]?.data?.toolCallId, 'tool-call-approval-helper', 'approval helper call id')
  assertEqual(recorded[0]?.data?.toolName, 'write', 'approval helper tool name')
  assertEqual(recorded[0]?.data?.requestId, 'approval-contract-id', 'approval helper request id')
  assertEqual(recorded[0]?.data?.risk, 'destructive write', 'approval helper risk')
  assertEqual(
    (recorded[0]?.data?.target as { preview?: unknown } | undefined)?.preview,
    '/workspace/contract.md',
    'approval helper target snapshot',
  )
  assertEqual(recorded[1]?.data?.approved, true, 'approval helper resolved approved flag')
  assertEqual(recorded[1]?.data?.reason, 'user', 'approval helper resolved reason')

  const failedRecorded: AgentEvent[] = []
  try {
    await requestToolApprovalWithActivity({
      request,
      createId: () => 'approval-failed-contract-id',
      approve: async () => {
        throw new Error('approval prompt failed')
      },
      recordAgentEvent: async (_conversationId, event) => {
        failedRecorded.push(event)
      },
    })
    throw new Error('failed approval unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('approval prompt failed'),
      'approval helper should rethrow prompt failures',
    )
  }
  assertEqual(
    failedRecorded[0]?.type,
    'tool.approval.requested',
    'failed approval helper requested event',
  )
  assertEqual(
    failedRecorded[1]?.type,
    'tool.approval.resolved',
    'failed approval helper resolved event',
  )
  assertEqual(
    failedRecorded[1]?.data?.approved,
    false,
    'failed approval helper resolved should deny',
  )
  assertEqual(
    failedRecorded[1]?.data?.reason,
    'cancelled',
    'failed approval helper resolved reason',
  )
}

async function testToolRegistryContract(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }
  let ran = false
  const projectToolPack: ToolPack = {
    id: 'contract',
    name: 'Contract',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'contract_echo',
            description: 'Echo contract smoke input.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
          metadata: {
            name: 'contract_echo',
            readOnly: true,
            destructive: false,
            requiresApproval: false,
            access: ['read'],
            scope: ['workspace'],
          },
        },
        async run(args) {
          ran = true
          return JSON.stringify({ ok: true, value: args.value })
        },
      },
    ],
  }

  const registry = createDefaultToolRegistry([projectToolPack])
  assert(registry.specsByName.has('contract_echo'), 'custom tool should be registered')
  assert(
    getToolDefinitions(registry).some((definition) => definition.function.name === 'contract_echo'),
    'custom tool should be exposed in tool definitions',
  )
  const callerDefinitions = getToolDefinitions(registry)
  const callerDefinition = callerDefinitions.find(
    (definition) => definition.function.name === 'contract_echo',
  )
  assert(callerDefinition, 'custom tool definition should be listed')
  callerDefinition.function.description = 'caller-mutated definition'
  assertEqual(
    getToolDefinitions(registry).find((definition) => definition.function.name === 'contract_echo')
      ?.function.description,
    'Echo contract smoke input.',
    'tool definitions should be isolated from caller mutation',
  )
  const sourceEntry = projectToolPack.tools[0]
  assert(sourceEntry, 'custom tool source entry should exist')
  sourceEntry.spec.metadata.requiresApproval = true
  sourceEntry.spec.function.description = 'source-mutated definition'
  assertEqual(
    registry.specsByName.get('contract_echo')?.metadata.requiresApproval,
    false,
    'tool registry should snapshot source metadata at registration',
  )
  assertEqual(
    getToolDefinitions(registry).find((definition) => definition.function.name === 'contract_echo')
      ?.function.description,
    'Echo contract smoke input.',
    'tool registry should snapshot source definitions at registration',
  )
  const result = await executeTool('contract_echo', { value: 'hello' }, { settings }, registry)
  assert(ran, 'custom tool runner should execute')
  assertEqual(JSON.parse(result).value, 'hello', 'custom tool result')

  const approvalPack: ToolPack = {
    id: 'approval-contract',
    name: 'Approval Contract',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'contract_destructive',
            description: 'Exercise approval flow.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          metadata: {
            name: 'contract_destructive',
            readOnly: false,
            destructive: true,
            requiresApproval: true,
            access: ['write'],
            scope: ['workspace'],
          },
        },
        async run() {
          throw new Error('approval rejected tool should not run')
        },
      },
    ],
  }
  const approvalRegistry = createDefaultToolRegistry([approvalPack])
  let approvalRequested = false
  try {
    await executeTool(
      'contract_destructive',
      {},
      {
        settings,
        conversationId: 'conversation-approval',
        messageId: 'assistant-approval',
        toolCallId: 'tool-call-approval',
        async onToolApproval(request) {
          approvalRequested = true
          assertEqual(
            request.conversationId,
            'conversation-approval',
            'approval request conversation id',
          )
          assertEqual(request.messageId, 'assistant-approval', 'approval request message id')
          assertEqual(request.toolCallId, 'tool-call-approval', 'approval request tool call id')
          return false
        },
      },
      approvalRegistry,
    )
    throw new Error('rejected tool unexpectedly succeeded')
  } catch (error) {
    assert(approvalRequested, 'approval hook should be called')
    assert(
      error instanceof Error && error.message.includes('rejected by user'),
      'rejected approval should return policy error',
    )
  }

  let policyAllowedRunnerCalled = false
  let policyRunnerMode: unknown = null
  let policyRunnerNestedValue: unknown = null
  const policyPack: ToolPack = {
    id: 'policy-contract',
    name: 'Policy Contract',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'contract_policy_tool',
            description: 'Exercise policy flow.',
            parameters: {
              type: 'object',
              properties: { mode: { type: 'string' } },
              required: ['mode'],
              additionalProperties: false,
            },
          },
          metadata: {
            name: 'contract_policy_tool',
            readOnly: false,
            destructive: true,
            requiresApproval: true,
            access: ['write'],
            scope: ['workspace'],
          },
        },
        async run(args, ctx) {
          policyAllowedRunnerCalled = true
          policyRunnerMode = args.mode
          const nested = args.nested as { value?: unknown } | undefined
          policyRunnerNestedValue = nested?.value ?? null
          args.mode = 'runner-mutated'
          if (nested) nested.value = 'runner-mutated'
          ctx.settings.apiKeys.openrouter = 'runner-mutated'
          const root = ctx.workspaceRoots?.[0]
          if (root && typeof root !== 'string') root.label = 'runner-mutated'
          return 'policy ok'
        },
      },
    ],
  }
  const policyRegistry = createDefaultToolRegistry([policyPack])

  policyAllowedRunnerCalled = false
  try {
    await executeTool(
      'contract_policy_tool',
      { mode: 'missing-approval-host' },
      { settings },
      policyRegistry,
    )
    throw new Error('approval-required tool unexpectedly succeeded without approval host')
  } catch (error) {
    assertEqual(policyAllowedRunnerCalled, false, 'missing approval host should not run handler')
    assert(
      error instanceof Error && error.message.includes('requires approval but no approval host'),
      'approval-required tool should fail closed without approval host',
    )
  }

  const allowed = await executeTool(
    'contract_policy_tool',
    { mode: 'allow' },
    {
      settings,
      onToolPolicy: () => ({ action: 'allow' }),
      onToolApproval: async () => {
        throw new Error('allow policy should not ask approval')
      },
    },
    policyRegistry,
  )
  assertEqual(allowed, 'policy ok', 'allow policy should execute tool')
  assertEqual(policyAllowedRunnerCalled, true, 'allow policy should run handler')

  let askApprovalRequested = false
  await executeTool(
    'contract_policy_tool',
    { mode: 'ask' },
    {
      settings,
      onToolPolicy: (request) => {
        assertEqual(request.metadata.destructive, true, 'policy request metadata')
        return { action: 'ask', reason: 'contract asks' }
      },
      onToolApproval: async (request) => {
        askApprovalRequested = request.name === 'contract_policy_tool'
        return true
      },
    },
    policyRegistry,
  )
  assertEqual(askApprovalRequested, true, 'ask policy should call approval hook')

  policyAllowedRunnerCalled = false
  policyRunnerMode = null
  policyRunnerNestedValue = null
  let immutableApprovalRequested = false
  const immutableArgs: Record<string, unknown> = {
    mode: 'immutable-boundary',
    nested: { value: 'original-nested' },
  }
  const immutableWorkspaceRoots = [{ path: '/contract/tool-root', label: 'contract-root' }]
  const immutableContext = {
    settings,
    workspaceRoots: immutableWorkspaceRoots,
    onToolPolicy: (request) => {
      request.args.mode = 'policy-mutated'
      const nested = request.args.nested as { value?: unknown } | undefined
      if (nested) nested.value = 'policy-mutated'
      request.metadata.requiresApproval = false
      return undefined
    },
    onToolApproval: async (request) => {
      immutableApprovalRequested = true
      request.args.mode = 'approval-mutated'
      const nested = request.args.nested as { value?: unknown } | undefined
      if (nested) nested.value = 'approval-mutated'
      return true
    },
  }
  await executeTool('contract_policy_tool', immutableArgs, immutableContext, policyRegistry)
  assertEqual(
    immutableApprovalRequested,
    true,
    'policy request mutation should not bypass approval',
  )
  assertEqual(policyAllowedRunnerCalled, true, 'immutable boundary should still run handler')
  assertEqual(
    policyRunnerMode,
    'immutable-boundary',
    'policy and approval request mutation should not change runner args',
  )
  assertEqual(
    policyRunnerNestedValue,
    'original-nested',
    'policy and approval request mutation should not change nested runner args',
  )
  assertEqual(
    immutableArgs.mode,
    'immutable-boundary',
    'runner mutation should not change caller tool args',
  )
  assertEqual(
    (immutableArgs.nested as { value?: unknown }).value,
    'original-nested',
    'runner mutation should not change caller nested tool args',
  )
  assertEqual(
    settings.apiKeys.openrouter,
    undefined,
    'runner mutation should not change caller tool settings context',
  )
  assertEqual(
    immutableWorkspaceRoots[0]?.label,
    'contract-root',
    'runner mutation should not change caller workspace roots context',
  )

  policyAllowedRunnerCalled = false
  try {
    await executeTool(
      'contract_policy_tool',
      { mode: 'deny' },
      {
        settings,
        onToolPolicy: () => ({ action: 'deny', reason: 'contract denied' }),
        onToolApproval: async () => {
          throw new Error('deny policy should not ask approval')
        },
      },
      policyRegistry,
    )
    throw new Error('denied tool unexpectedly succeeded')
  } catch (error) {
    assertEqual(policyAllowedRunnerCalled, false, 'deny policy should not run handler')
    assert(
      error instanceof Error && error.message.includes('contract denied'),
      'deny policy should expose reason',
    )
  }

  policyAllowedRunnerCalled = false
  try {
    await executeTool(
      'contract_policy_tool',
      { mode: 'invalid-policy' },
      {
        settings,
        onToolPolicy: () => ({ action: 'bypass' }) as never,
        onToolApproval: async () => true,
      },
      policyRegistry,
    )
    throw new Error('invalid policy unexpectedly succeeded')
  } catch (error) {
    assertEqual(policyAllowedRunnerCalled, false, 'invalid policy should not run handler')
    assert(
      error instanceof Error && error.message.includes('invalid tool policy decision'),
      'invalid policy should fail closed',
    )
  }

  policyAllowedRunnerCalled = false
  try {
    await executeTool(
      'contract_policy_tool',
      { mode: 'non-boolean-approval' },
      {
        settings,
        onToolPolicy: () => ({ action: 'ask' }),
        onToolApproval: async () => 'yes' as never,
      },
      policyRegistry,
    )
    throw new Error('non-boolean approval unexpectedly succeeded')
  } catch (error) {
    assertEqual(policyAllowedRunnerCalled, false, 'non-boolean approval should not run handler')
    assert(
      error instanceof Error && error.message.includes('rejected by user'),
      'non-boolean approval should fail closed',
    )
  }
}

async function testRuntimeExecuteToolUsesHostBoundary(): Promise<void> {
  const settings: Settings = { apiKeys: { openrouter: 'runtime-key' }, defaultModel: null }
  const workspaceRoots = [{ path: '/contract@aila/agent-root', label: 'contract' }]
  let loadSettingsCalled = false
  let policySawRuntimeRequest = false
  let approvalSawRuntimeRequest = false
  let runnerSawRuntimeContext = false

  const toolPack: ToolPack = {
    id: 'runtime-execute-contract',
    name: 'Runtime Execute Contract',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'contract_runtime_execute',
            description: 'Exercise runtime-managed tool execution.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
          metadata: {
            name: 'contract_runtime_execute',
            readOnly: false,
            destructive: true,
            requiresApproval: true,
            access: ['write'],
            scope: ['workspace'],
          },
        },
        async run(args, ctx) {
          const root = ctx.workspaceRoots?.[0]
          const nested = args.nested as { value?: unknown } | undefined
          const originalValue = args.value
          runnerSawRuntimeContext =
            args.value === 'runtime' &&
            nested?.value === 'caller-nested' &&
            ctx.settings !== settings &&
            ctx.settings.apiKeys.openrouter === 'runtime-key' &&
            ctx.conversationId === 'conversation-runtime-tool' &&
            ctx.messageId === 'assistant-runtime-tool' &&
            ctx.toolCallId === 'tool-call-runtime-tool' &&
            ctx.workspaceRoots !== workspaceRoots &&
            typeof root === 'object' &&
            root.path === '/contract@aila/agent-root' &&
            root.label === 'contract' &&
            root !== workspaceRoots[0]
          args.value = 'runner-mutated'
          if (nested) nested.value = 'runner-mutated'
          ctx.settings.apiKeys.openrouter = 'mutated'
          if (root && typeof root !== 'string') root.label = 'mutated'
          return JSON.stringify({ ok: true, value: originalValue })
        },
      },
    ],
  }

  const runtime = new AgentRuntime({
    loadSettings: () => {
      loadSettingsCalled = true
      return settings
    },
    loadToolPacks: async () => [toolPack],
    workspaceRoots: () => workspaceRoots,
    onToolPolicy: (request) => {
      const nested = request.args.nested as { value?: unknown } | undefined
      policySawRuntimeRequest =
        request.name === 'contract_runtime_execute' &&
        request.args.value === 'runtime' &&
        nested?.value === 'caller-nested' &&
        request.conversationId === 'conversation-runtime-tool' &&
        request.messageId === 'assistant-runtime-tool' &&
        request.toolCallId === 'tool-call-runtime-tool' &&
        request.metadata.requiresApproval
      request.args.value = 'policy-mutated'
      if (nested) nested.value = 'policy-mutated'
      request.metadata.requiresApproval = false
      return { action: 'ask' }
    },
    onToolApproval: async (request) => {
      const nested = request.args.nested as { value?: unknown } | undefined
      approvalSawRuntimeRequest =
        request.name === 'contract_runtime_execute' &&
        request.args.value === 'runtime' &&
        nested?.value === 'caller-nested' &&
        request.metadata.destructive
      request.args.value = 'approval-mutated'
      if (nested) nested.value = 'approval-mutated'
      return true
    },
  })

  const runtimeArgs: Record<string, unknown> = {
    value: 'runtime',
    nested: { value: 'caller-nested' },
  }
  const result = await runtime.executeTool({
    name: 'contract_runtime_execute',
    args: runtimeArgs,
    conversationId: 'conversation-runtime-tool',
    messageId: 'assistant-runtime-tool',
    toolCallId: 'tool-call-runtime-tool',
  })

  assertEqual(JSON.parse(result).value, 'runtime', 'runtime execute tool result')
  assertEqual(loadSettingsCalled, true, 'runtime execute should load host settings')
  assertEqual(policySawRuntimeRequest, true, 'runtime execute should use host tool policy')
  assertEqual(approvalSawRuntimeRequest, true, 'runtime execute should use host tool approval')
  assertEqual(runnerSawRuntimeContext, true, 'runtime execute should pass runtime tool context')
  assertEqual(
    runtimeArgs.value,
    'runtime',
    'runtime execute should isolate caller args from policy and runner mutation',
  )
  assertEqual(
    (runtimeArgs.nested as { value?: unknown }).value,
    'caller-nested',
    'runtime execute should isolate caller nested args from policy and runner mutation',
  )
  assertEqual(
    settings.apiKeys.openrouter,
    'runtime-key',
    'runtime execute should isolate host settings from tool mutation',
  )
  assertEqual(
    workspaceRoots[0]?.label,
    'contract',
    'runtime execute should isolate host workspace roots from tool mutation',
  )
}

async function testGenerateImageToolUsesInjectedImageDependencies(): Promise<void> {
  const imageBlocks: Array<{ url: string; mime: string; prompt: string }> = []
  let generatedPrompt: string | null = null
  let savedFilename: string | null = null
  let savedBytesLength = 0

  const result = await executeTool(
    'generate_image',
    { prompt: 'contract image' },
    {
      settings: {
        apiKeys: {},
        defaultModel: null,
        defaultImageModel: { providerId: 'openrouter', modelId: 'openai/gpt-image-1' },
      },
      generateImage: async (request) => {
        generatedPrompt = request.prompt
        return { bytes: Buffer.from([1, 2, 3, 4]), mime: 'image/webp' }
      },
      saveImage: async (bytes, filename) => {
        savedFilename = filename
        savedBytesLength = bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteLength
        return { url: 'aila-image://i/contract.webp' }
      },
      onImage: (block) => imageBlocks.push(block),
    },
  )

  const parsed = JSON.parse(result) as { ok?: unknown; model?: unknown }
  assertEqual(parsed.ok, true, 'generate_image injected dependency result ok')
  assertEqual(
    parsed.model,
    'openrouter:openai/gpt-image-1',
    'generate_image injected dependency model',
  )
  assertEqual(generatedPrompt, 'contract image', 'injected image generator prompt')
  assertEqual(savedFilename, 'image.webp', 'injected image saver filename')
  assertEqual(savedBytesLength, 4, 'injected image saver bytes')
  assertEqual(imageBlocks.length, 1, 'generate_image should emit image side channel')
  assertEqual(imageBlocks[0]?.url, 'aila-image://i/contract.webp', 'image side channel url')
  assertEqual(imageBlocks[0]?.mime, 'image/webp', 'image side channel mime')
  assertEqual(imageBlocks[0]?.prompt, 'contract image', 'image side channel prompt')
}

async function testGenerateImageToolRequiresHostImageDependencies(): Promise<void> {
  const settings: Settings = {
    apiKeys: {},
    defaultModel: null,
    defaultImageModel: { providerId: 'openrouter', modelId: 'openai/gpt-image-1' },
  }

  try {
    await executeTool('generate_image', { prompt: 'missing image host' }, { settings })
    throw new Error('generate_image unexpectedly succeeded without image host')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('image generation host is not available'),
      'generate_image should fail closed without an injected image generator',
    )
  }

  try {
    await executeTool(
      'generate_image',
      { prompt: 'missing image storage host' },
      {
        settings,
        generateImage: async () => ({ bytes: Buffer.from([1, 2, 3]), mime: 'image/png' }),
      },
    )
    throw new Error('generate_image unexpectedly succeeded without image storage host')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('image storage host is not available'),
      'generate_image should fail closed without an injected image saver',
    )
  }
}

async function testWebSearchToolUsesInjectedHostDependency(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }
  const abortController = new AbortController()
  const requestSeen: { current?: ToolWebSearchRequest } = {}

  const result = await executeTool(
    'web_search',
    {
      query: 'Aila runtime',
      search_depth: 'advanced',
      topic: 'news',
      time_range: 'week',
      max_results: 99,
    },
    {
      settings,
      signal: abortController.signal,
      webSearch: async (request) => {
        requestSeen.current = { ...request }
        return {
          answer: 'Injected search answer',
          results: [
            {
              title: 'Injected result',
              url: 'https://example.com@aila/agent',
              content: 'Injected snippet',
            },
          ],
        }
      },
    },
  )

  const parsed = JSON.parse(result) as {
    answer?: unknown
    results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>
  }
  const firstResult = parsed.results?.[0]
  assertEqual(parsed.answer, 'Injected search answer', 'web_search injected dependency answer')
  assert(firstResult, 'web_search injected dependency should return a result')
  assertEqual(firstResult.title, 'Injected result', 'web_search injected dependency result title')
  assertEqual(
    firstResult.url,
    'https://example.com@aila/agent',
    'web_search injected dependency url',
  )
  assertEqual(firstResult.content, 'Injected snippet', 'web_search injected dependency content')

  const seenRequest = requestSeen.current
  assert(seenRequest, 'web_search should call the injected host dependency')
  assertEqual(seenRequest.query, 'Aila runtime', 'web_search request query')
  assertEqual(seenRequest.searchDepth, 'advanced', 'web_search request search depth')
  assertEqual(seenRequest.topic, 'news', 'web_search request topic')
  assertEqual(seenRequest.timeRange, 'week', 'web_search request time range')
  assertEqual(seenRequest.maxResults, 10, 'web_search request max results should be clamped')
  assertEqual(seenRequest.signal, abortController.signal, 'web_search request abort signal')
}

async function testWebSearchToolRequiresHostDependency(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }

  try {
    await executeTool('web_search', { query: 'Aila runtime' }, { settings })
    throw new Error('web_search unexpectedly succeeded without a host dependency')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('web search host is not available'),
      'web_search should fail closed without an injected host dependency',
    )
  }
}

async function testNodeWebSearchRegistryFallbacksAndMerge(): Promise<void> {
  const fallbackCalls: string[] = []
  const fallbackSearch = runtimePackageNodeSdk.createDefaultWebSearch({
    providers: {
      tavily: { apiKey: '' },
      duckduckgo: {},
      wikimedia: {},
    },
    order: ['tavily', 'duckduckgo', 'wikimedia'],
    fetch: async (url) => {
      const href = String(url)
      fallbackCalls.push(href)
      if (href.includes('api.duckduckgo.com')) {
        return new Response(JSON.stringify({ RelatedTopics: [] }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          pages: [
            {
              key: 'Aila',
              title: 'Aila',
              excerpt: 'Aila runtime search result',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    },
  })
  const fallback = await fallbackSearch({
    query: 'Aila',
    searchDepth: 'basic',
    topic: 'general',
    maxResults: 3,
  })
  assert(
    fallbackCalls.some((url) => url.includes('api.duckduckgo.com')) &&
      fallbackCalls.some((url) => url.includes('api.wikimedia.org')),
    'node web search should fallback from empty DuckDuckGo result to Wikimedia without Tavily key',
  )
  assertEqual(fallback.results?.[0]?.source, 'wikimedia', 'fallback result source')

  let searxngSignal: AbortSignal | undefined
  const controller = new AbortController()
  const searxngSearch = runtimePackageNodeSdk.createDefaultWebSearch({
    providers: {
      searxng: { baseUrl: 'https://searx.example' },
      duckduckgo: {},
    },
    order: ['searxng', 'duckduckgo'],
    fetch: async (url, init) => {
      assert(String(url).startsWith('https://searx.example/search?'), 'SearXNG should be first')
      searxngSignal = init?.signal ?? undefined
      return new Response(
        JSON.stringify({
          results: [{ title: 'SearXNG result', url: 'https://example.com/a', content: 'Snippet' }],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    },
  })
  const searxng = await searxngSearch({
    query: 'Aila runtime',
    searchDepth: 'basic',
    topic: 'general',
    maxResults: 5,
    signal: controller.signal,
  })
  assertEqual(searxng.results?.[0]?.source, 'searxng', 'SearXNG result source')
  assertEqual(searxngSignal, controller.signal, 'SearXNG provider receives abort signal')

  const tavilyCalls: string[] = []
  const tavilyFallbackSearch = runtimePackageNodeSdk.createDefaultWebSearch({
    providers: {
      tavily: { apiKey: 'contract-key' },
      duckduckgo: {},
    },
    order: ['tavily', 'duckduckgo'],
    fetch: async (url) => {
      const href = String(url)
      tavilyCalls.push(href)
      if (href.includes('api.tavily.com')) return new Response('boom', { status: 500 })
      return new Response(
        JSON.stringify({
          RelatedTopics: [
            {
              Text: 'Fallback result - from DuckDuckGo',
              FirstURL: 'https://example.com/fallback',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    },
  })
  const tavilyFallback = await tavilyFallbackSearch({
    query: 'Aila runtime',
    searchDepth: 'basic',
    topic: 'general',
    maxResults: 5,
  })
  assert(
    tavilyCalls.some((url) => url.includes('api.tavily.com')) &&
      tavilyCalls.some((url) => url.includes('api.duckduckgo.com')),
    'node web search should fallback when Tavily provider fails',
  )
  assertEqual(tavilyFallback.results?.[0]?.source, 'duckduckgo', 'Tavily fallback source')

  const mergeRegistry = runtimePackageNodeSdk.createWebSearchRegistry({
    adapters: [
      {
        id: 'one',
        search: async () => ({
          results: [
            { title: 'One', url: 'https://example.com/shared#fragment', source: 'one' },
            { title: 'Only one', url: 'https://example.com/one', source: 'one' },
          ],
        }),
      },
      {
        id: 'two',
        search: async () => ({
          results: [
            { title: 'Two', url: 'https://example.com/shared', source: 'two' },
            { title: 'Only two', url: 'https://example.com/two', source: 'two' },
          ],
        }),
      },
    ],
    order: ['one', 'two'],
    advancedMode: 'merge',
  })
  const merged = await mergeRegistry.search({
    query: 'Aila runtime',
    searchDepth: 'advanced',
    topic: 'general',
    maxResults: 2,
  })
  assertEqual(merged.results?.length, 2, 'advanced merge should respect maxResults')
  assertEqual(
    merged.results?.filter((result) => result.url?.includes('/shared')).length,
    1,
    'advanced merge should dedupe URLs',
  )
}

function testToolActivityTargetContract(): void {
  assertEqual(
    summarizeToolTarget('read', { path: '/workspace/src/app.ts' })?.preview,
    '/workspace/src/app.ts',
    'read target path',
  )
  assertEqual(
    summarizeToolTarget('write', { path: '/workspace/src/app.ts', content: 'next' })?.kind,
    'file',
    'write target kind',
  )
  assertEqual(
    summarizeToolTarget('edit', { path: '/workspace/src/app.ts', oldText: 'a', newText: 'b' })
      ?.preview,
    '/workspace/src/app.ts',
    'edit target path',
  )
  assertEqual(
    summarizeToolTarget('bash', { command: 'bun run test' })?.preview,
    'bun run test',
    'bash target command',
  )
  assertEqual(
    summarizeToolTarget('web_search', { query: 'Aila runtime' })?.kind,
    'query',
    'web search target kind',
  )
  assertEqual(
    summarizeToolTarget('generate_image', { prompt: 'quiet desktop workbench' })?.kind,
    'prompt',
    'image target kind',
  )
  assertEqual(
    summarizeToolTarget('contract_echo', { value: 'hello' }),
    null,
    'unknown custom tool should not invent target metadata',
  )
}

async function testFilesystemToolWorkspaceRootsContract(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }
  const dir = join(tmpdir(), 'aila-tool-workspace-contract')
  const sourcePath = join(dir, 'source.md')
  const writePath = join(dir, 'created.md')
  const files = new Map<string, string>([[sourcePath, 'hello workspace roots']])
  const fileSystem: ToolFileSystem = {
    readTextFile: async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`missing test file: ${path}`)
      return content
    },
    writeTextFile: async (path, content) => {
      files.set(path, content)
    },
  }

  try {
    await executeTool('read', { path: sourcePath }, { settings, fileSystem })
    throw new Error('read without workspace roots unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('no workspace roots configured'),
      'read without configured roots should be denied',
    )
  }

  try {
    await executeTool('read', { path: sourcePath }, { settings, workspaceRoots: [dir] })
    throw new Error('read without filesystem host unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('filesystem host is not available'),
      'read inside roots should fail closed without an injected filesystem host',
    )
  }

  const readResult = await executeTool(
    'read',
    { path: sourcePath },
    { settings, workspaceRoots: [{ path: dir, label: 'contract' }], fileSystem },
  )
  assertEqual(readResult, 'hello workspace roots', 'read should allow configured workspace root')

  await executeTool(
    'write',
    { path: writePath, content: 'draft' },
    { settings, workspaceRoots: [dir], fileSystem, onToolApproval: async () => true },
  )
  assertEqual(files.get(writePath), 'draft', 'write should target extra root')

  await executeTool(
    'edit',
    { path: writePath, oldText: 'draft', newText: 'final' },
    { settings, workspaceRoots: [dir], fileSystem, onToolApproval: async () => true },
  )
  assertEqual(files.get(writePath), 'final', 'edit should target extra root')
}

async function testDefaultRuntimeHostOwnsFilesystemTools(): Promise<void> {
  await withTempDataDir(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aila-default-host-filesystem-'))
    try {
      const sourcePath = join(dir, 'source.md')
      const writePath = join(dir, 'created.md')
      await writeFile(sourcePath, 'default host filesystem', 'utf-8')

      const runtime = runtimeNodeSdk.createPersistedAgentRuntime({
        host: {
          workspaceRoots: () => [dir],
          onToolApproval: async () => true,
        },
      })

      assertEqual(
        await runtime.executeTool({ name: 'read', args: { path: sourcePath } }),
        'default host filesystem',
        'default host should read through its filesystem adapter',
      )
      await runtime.executeTool({ name: 'write', args: { path: writePath, content: 'draft' } })
      assertEqual(await readFile(writePath, 'utf-8'), 'draft', 'default host should write files')
      await runtime.executeTool({
        name: 'edit',
        args: { path: writePath, oldText: 'draft', newText: 'final' },
      })
      assertEqual(await readFile(writePath, 'utf-8'), 'final', 'default host should edit files')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

async function testBashToolShellCwdContract(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }
  const abortController = new AbortController()
  const dir = join(tmpdir(), 'aila-tool-shell-contract')
  const requestSeen: { current?: ToolShellRequest } = {}

  const result = await executeTool(
    'bash',
    { command: 'printf shell-cwd' },
    {
      settings,
      shellCwd: dir,
      signal: abortController.signal,
      onToolApproval: async () => true,
      runShell: async (request) => {
        requestSeen.current = { ...request }
        return { exitCode: 0, stdout: 'shell-cwd', stderr: '' }
      },
    },
  )

  const parsed = JSON.parse(result) as { exit_code?: unknown; stdout?: unknown; stderr?: unknown }
  assertEqual(parsed.exit_code, 0, 'bash shell cwd command should succeed')
  assertEqual(parsed.stdout, 'shell-cwd', 'bash tool should return injected shell stdout')
  assertEqual(parsed.stderr, '', 'bash tool should return injected shell stderr')

  const seenRequest = requestSeen.current
  assert(seenRequest, 'bash should call the injected shell host dependency')
  assertEqual(seenRequest.command, 'printf shell-cwd', 'bash shell request command')
  assertEqual(seenRequest.cwd, dir, 'bash shell request cwd')
  assertEqual(seenRequest.timeoutMs, 30_000, 'bash shell request timeout')
  assertEqual(seenRequest.maxBufferBytes, 128 * 1024, 'bash shell request max buffer')
  assertEqual(seenRequest.signal, abortController.signal, 'bash shell request abort signal')
}

async function testBashToolRequiresHostDependency(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }

  try {
    await executeTool(
      'bash',
      { command: 'printf should-not-run' },
      { settings, onToolApproval: async () => true },
    )
    throw new Error('bash unexpectedly succeeded without a host dependency')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('shell host is not available'),
      'bash should fail closed without an injected shell host dependency',
    )
  }
}

async function testRuntimeCoreHasNoDocToolContract(): Promise<void> {
  const registry = createDefaultToolRegistry()
  assert(!registry.specsByName.has('edit_doc'), 'runtime core must not register edit_doc')

  for (const spec of registry.specs) {
    assert(
      !(spec.metadata.access as readonly string[]).includes('doc'),
      `tool ${spec.metadata.name} must not use doc access`,
    )
    assert(
      !(spec.metadata.scope as readonly string[]).includes('current_doc'),
      `tool ${spec.metadata.name} must not use current_doc scope`,
    )
  }

  try {
    await executeTool('edit_doc', {}, { settings: { apiKeys: {}, defaultModel: null } }, registry)
    throw new Error('edit_doc unexpectedly executed')
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('unknown tool'),
      'edit_doc should be unknown in runtime core',
    )
  }
}

async function testRuntimeSdkDoesNotExportDocsContract(): Promise<void> {
  const sdk = runtimeSdk as Record<string, unknown>
  for (const name of [
    'createDoc',
    'getDoc',
    'updateDoc',
    'deleteDoc',
    'listAll',
    'createFolder',
    'deleteFolder',
    'moveFolder',
    'renameFolder',
    'listDocConversations',
    'rewriteDocRefs',
  ]) {
    assert(!(name in sdk), `runtime SDK must not export Desktop docs API: ${name}`)
  }

  for (const name of [
    'appendAgentEvent',
    'appendAgentEventAndTouchConversation',
    'appendMessage',
    'createConversation',
    'deleteConversation',
    'getConversation',
    'listAgentEvents',
    'listChatConversations',
    'listConversations',
    'recoverInterruptedConversationActivities',
    'recoverInterruptedConversationActivityResults',
    'renameConversation',
    'setConversationUsage',
    'upsertMessage',
  ]) {
    assert(!(name in sdk), `runtime SDK must not export raw persistence helper: ${name}`)
  }
  for (const name of [
    'BUILTIN_TOOL_PACKS',
    'TOOL_DEFINITIONS',
    'TOOL_SPECS',
    'applyFindReplace',
    'createDefaultToolRegistry',
    'createToolRegistry',
    'evaluateToolPolicy',
    'executeTool',
    'formatFindReplaceErrors',
    'getToolDefinitions',
    'summarizeToolTarget',
  ]) {
    assert(!(name in sdk), `runtime SDK must not export internal helper: ${name}`)
  }

  assertEqual(
    typeof runtimeNodeSdk.createPersistedRuntimeStore,
    'function',
    'runtime SDK should expose the persisted store adapter factory',
  )
  assertEqual(
    typeof runtimeNodeSdk.createDefaultRuntimeHost,
    'function',
    'runtime SDK should expose the default runtime host factory',
  )
  assertEqual(
    typeof runtimeNodeSdk.createPersistedAgentRuntime,
    'function',
    'runtime SDK should expose the persisted AgentRuntime factory',
  )
  const store = runtimeNodeSdk.createPersistedRuntimeStore()
  assertEqual(typeof store.getConversation, 'function', 'persisted store should read records')
  assertEqual(typeof store.saveMessage, 'function', 'persisted store should persist messages')
  assert(
    !('upsertMessage' in store),
    'persisted runtime store adapter should not expose raw persisted message helper names',
  )
  assertEqual(
    typeof store.recordAgentEvent,
    'function',
    'persisted store should persist agent events',
  )
  assert(
    !('appendAgentEventAndTouchConversation' in store),
    'persisted runtime store adapter should not expose raw persisted event helper names',
  )
  assertEqual(
    typeof store.recoverInterruptedActivities,
    'function',
    'persisted store should expose runtime-facing interrupted recovery',
  )
  assert(
    !('recoverInterruptedConversationActivities' in store),
    'persisted runtime store adapter should not expose raw persisted recovery helper names',
  )
  assertEqual(typeof store.recordUsage, 'function', 'persisted store should persist usage')
  assert(
    !('setConversationUsage' in store),
    'persisted runtime store adapter should not expose raw persisted usage helper names',
  )

  assertEqual(
    typeof runtimeSdk.createInMemoryRuntimeStore,
    'function',
    'runtime SDK should expose the in-memory store factory',
  )
  const memoryStore = runtimeSdk.createInMemoryRuntimeStore()
  const memoryConversation = await memoryStore.createConversation?.()
  assert(memoryConversation, 'in-memory store should create conversations')
  assertEqual(
    (await memoryStore.getConversation(memoryConversation.id)).meta.id,
    memoryConversation.id,
    'in-memory store should keep records without a host adapter',
  )

  const coreSdk = runtimeCoreSdk as Record<string, unknown>
  for (const name of [
    'configureDataDir',
    'getDataDir',
    'getImagesDir',
    'getSettingsPath',
    'loadSettings',
    'saveSettings',
    'configuredProviders',
    'createPersistedRuntimeStore',
    'createDefaultRuntimeHost',
    'createPersistedAgentRuntime',
    'loadSkillsFromDir',
    'loadToolPacksFromDir',
    'getExtensionReport',
    'getModelInfo',
  ]) {
    assert(!(name in coreSdk), `runtime core SDK must not export node adapter API: ${name}`)
  }
  assertEqual(typeof coreSdk.AgentRuntime, 'function', 'runtime core SDK should export runtime')
  assertEqual(
    typeof coreSdk.createInMemoryRuntimeStore,
    'function',
    'runtime core SDK should export in-memory store',
  )
  for (const name of [
    'BUILTIN_TOOL_PACKS',
    'TOOL_DEFINITIONS',
    'TOOL_SPECS',
    'applyFindReplace',
    'createDefaultToolRegistry',
    'createToolRegistry',
    'evaluateToolPolicy',
    'executeTool',
    'formatFindReplaceErrors',
    'getToolDefinitions',
    'summarizeToolTarget',
  ]) {
    assert(!(name in coreSdk), `runtime core SDK must not export internal helper: ${name}`)
  }
  const internalSdk = runtimeInternalSdk as Record<string, unknown>
  for (const name of [
    'applyFindReplace',
    'createDefaultToolRegistry',
    'createToolRegistry',
    'evaluateToolPolicy',
    'executeTool',
    'formatFindReplaceErrors',
    'getToolDefinitions',
    'summarizeToolTarget',
  ]) {
    assert(name in internalSdk, `runtime internal SDK should export helper: ${name}`)
  }
  assertEqual(
    typeof coreSdk.requestToolApprovalWithActivity,
    'function',
    'runtime core SDK should export host-agnostic approval activity helper',
  )
  assertEqual(
    typeof coreSdk.ToolApprovalStore,
    'function',
    'runtime core SDK should export the host-agnostic approval store',
  )
  assertEqual(
    typeof coreSdk.createToolPolicy,
    'function',
    'runtime core SDK should export tool approval mode policy helper',
  )
  const writePolicyRequest = {
    name: 'write',
    args: { path: '/workspace/file.txt' },
    metadata: {
      name: 'write',
      readOnly: false,
      destructive: true,
      requiresApproval: true,
      access: ['write'],
      scope: ['workspace'],
    },
  } satisfies runtimeSdk.ToolPolicyRequest
  assertEqual(
    (await runtimeSdk.createToolPolicy('safe')(writePolicyRequest))?.action,
    'ask',
    'safe tool policy should ask before destructive writes',
  )
  assertEqual(
    (await runtimeSdk.createToolPolicy('yolo')(writePolicyRequest))?.action,
    'allow',
    'yolo tool policy should allow destructive writes without approval',
  )
  const runtimeCoreSurfaceSource = await readFile(
    join(process.cwd(), 'scripts/runtime-core-surface-contract.ts'),
    'utf-8',
  )
  for (const name of [
    'AgentRuntimeApi',
    'AgentRuntimeHost',
    'AgentRuntimeStore',
    'RuntimeStreamChat',
    'RuntimeModelInfoResolver',
    'RuntimeStableInstructionsInput',
    'Settings',
    'ToolPack',
    'ToolApprovalMode',
    'ToolApprovalRequest',
    'ToolApprovalRequestPayload',
    'ConversationRecord',
    'ConversationSummary',
    'ConversationUsage',
    'AgentEvent',
    'AgentRuntimeEvent',
  ]) {
    assert(
      runtimeCoreSurfaceSource.includes(`type ${name}`) &&
        runtimeCoreSurfaceSource.includes("from '@aila/agent'"),
      `runtime core SDK should export public type: ${name}`,
    )
  }

  const nodeSdk = runtimeNodeSdk as Record<string, unknown>
  for (const name of [
    'configureDataDir',
    'getDataDir',
    'loadSettings',
    'createPersistedRuntimeStore',
    'createDefaultRuntimeHost',
    'createPersistedAgentRuntime',
    'loadSkillsFromDir',
    'loadToolPacksFromDir',
    'getExtensionReport',
  ]) {
    assert(name in nodeSdk, `runtime node SDK should export node adapter API: ${name}`)
  }

  const packageNodeSdk = runtimePackageNodeSdk as Record<string, unknown>
  for (const name of [
    'createDefaultNodeRuntimeHost',
    'createNodeAgentRuntime',
    'createProviderStreamChat',
    'createModelRegistry',
    'createProtocolRegistry',
    'createFileRuntimeStore',
    'loadNodeSettings',
    'createDefaultWebSearch',
    'createWebSearchRegistry',
    'WebSearchRegistry',
    'registerBuiltInWebSearchProviders',
  ]) {
    assert(name in packageNodeSdk, `@aila/agent/node should export node adapter API: ${name}`)
  }
}

async function testRuntimeCoreHostBoundarySourceContract(): Promise<void> {
  const runtimeSource = await readFile(
    join(process.cwd(), 'packages/agent/src/runtime.ts'),
    'utf-8',
  )
  assert(
    !runtimeSource.includes("from './image-store'") && !runtimeSource.includes('saveImage('),
    'AgentRuntime core must not import or call the Desktop image store',
  )
  assert(
    !runtimeSource.includes("from './agent'") && !runtimeSource.includes('defaultStreamChat'),
    'AgentRuntime core must not import the provider-backed agent loop',
  )
  assert(
    !runtimeSource.includes("from 'node:crypto'") &&
      runtimeSource.includes('createId?:') &&
      runtimeSource.includes('now?:') &&
      runtimeSource.includes('this.createId()') &&
      runtimeSource.includes('this.now()'),
    'AgentRuntime core should expose injectable ids and clocks instead of Node crypto wiring',
  )
  assert(
    !runtimeSource.includes('DocRefRewrite') && !runtimeSource.includes('rewriteDocRefs'),
    'AgentRuntime core must not own Desktop document ref rewrites',
  )
  assert(
    !runtimeSource.includes("from './conversations'") &&
      runtimeSource.includes("from './conversation-core'"),
    'AgentRuntime core should import pure conversation contracts instead of persisted conversation IO',
  )
  assert(
    runtimeSource.includes('recordAgentEvent:') &&
      runtimeSource.includes('this.store.recordAgentEvent') &&
      !runtimeSource.includes('appendAgentEventAndTouchConversation'),
    'AgentRuntime store contract should use host-agnostic agent event recording, not persisted helper names',
  )
  assert(
    runtimeSource.includes('recoverInterruptedActivities?:') &&
      runtimeSource.includes('this.store.recoverInterruptedActivities') &&
      !runtimeSource.includes('recoverInterruptedConversationActivities'),
    'AgentRuntime store contract should use host-agnostic recovery naming, not persisted helper names',
  )
  assert(
    runtimeSource.includes('saveMessage:') &&
      runtimeSource.includes('this.store.saveMessage') &&
      !runtimeSource.includes('this.store.upsertMessage'),
    'AgentRuntime store contract should use host-agnostic message persistence naming',
  )
  assert(
    runtimeSource.includes('recordUsage:') &&
      runtimeSource.includes('this.store.recordUsage') &&
      !runtimeSource.includes('this.store.setConversationUsage'),
    'AgentRuntime store contract should use host-agnostic usage persistence naming',
  )
  assert(
    runtimeSource.includes("from './agent-protocol'"),
    'AgentRuntime core should depend on the host-agnostic agent protocol types',
  )
  assert(
    runtimeSource.includes('persistAttachment?:'),
    'AgentRuntime host boundary should expose attachment persistence',
  )
  assert(
    runtimeSource.includes('getModelInfo?:') &&
      runtimeSource.includes('runtime host cannot stream chat'),
    'AgentRuntime host boundary should expose model metadata and stream ownership',
  )
  assert(
    runtimeSource.includes('export interface AgentRuntimeApi') &&
      runtimeSource.includes('export interface AgentRuntimeConversationApi') &&
      runtimeSource.includes('export interface AgentRuntimeTurnApi') &&
      runtimeSource.includes('export interface AgentRuntimeExtensionApi') &&
      runtimeSource.includes('export class AgentRuntime implements AgentRuntimeApi'),
    'AgentRuntime core should expose a typed host-facing API surface',
  )
  assert(
    runtimeSource.includes('listActiveTurns(): ActiveAssistantTurn[]') &&
      runtimeSource.includes('return this.listActiveStreams()'),
    'AgentRuntime should expose active turns through the host-facing API while keeping stream alias compatibility',
  )

  const hostSource = await readFile(join(process.cwd(), 'src/main/runtime-host.ts'), 'utf-8')
  assert(
    hostSource.includes("from './image-store'") &&
      hostSource.includes('persistAttachment: persistRuntimeAttachment'),
    'default runtime host should own image attachment persistence',
  )
  assert(
    hostSource.includes("from '@aila/agent/node'") &&
      hostSource.includes('createDefaultNodeRuntimeHost') &&
      hostSource.includes('saveImage'),
    'default runtime host should compose node image generation/storage dependencies from @aila/agent/node',
  )
  assert(
    hostSource.includes("from './web-search'") && hostSource.includes('webSearch'),
    'default runtime host should own web search provider wiring',
  )
  assert(
    hostSource.includes("from '@aila/agent/node'") &&
      hostSource.includes('createDefaultNodeRuntimeHost'),
    'default runtime host should compose shell execution wiring from @aila/agent/node',
  )
  assert(
    hostSource.includes("from '@aila/agent/node'") &&
      hostSource.includes('createDefaultNodeRuntimeHost'),
    'default runtime host should compose filesystem and default workspace root wiring from @aila/agent/node',
  )
  assert(
    hostSource.includes('createToolPolicy') &&
      hostSource.includes('onToolPolicy:') &&
      hostSource.includes('loadSettings().approvalMode'),
    'default runtime host should wire safe/yolo tool policy from settings',
  )

  const runtimeStoreSource = await readFile(
    join(process.cwd(), 'src/main/runtime-store.ts'),
    'utf-8',
  )
  assert(
    !runtimeStoreSource.includes('rewriteDocRefs'),
    'persisted runtime store adapter must not expose Desktop doc ref rewrites',
  )
  assert(
    runtimeStoreSource.includes('recordAgentEvent: appendAgentEventAndTouchConversation'),
    'persisted runtime store adapter should map persisted event append into runtime recordAgentEvent',
  )
  assert(
    runtimeStoreSource.includes(
      'recoverInterruptedActivities: recoverInterruptedConversationActivityResults',
    ),
    'persisted runtime store adapter should map persisted recovery results into runtime recoverInterruptedActivities',
  )
  assert(
    runtimeStoreSource.includes('saveMessage: upsertMessage') &&
      runtimeStoreSource.includes('recordUsage: setConversationUsage'),
    'persisted runtime store adapter should map persisted message and usage helpers into runtime names',
  )

  const runtimeSdkSource = await readFile(
    join(process.cwd(), 'packages/agent/src/index.ts'),
    'utf-8',
  )
  assert(
    !runtimeSdkSource.includes('DocRefRewrite'),
    'runtime SDK must not expose Desktop doc ref rewrite types',
  )
  assert(
    runtimeSdkSource.trim() === "export * from './core'",
    'agent package SDK should expose the core surface only',
  )
  const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>
  }
  assertEqual(
    packageJson.scripts?.['typecheck:agent'],
    'tsc --noEmit -p tsconfig.runtime.json --composite false',
    'package scripts should expose an agent-only compile contract',
  )
  assertEqual(
    packageJson.scripts?.['typecheck:agent-package'],
    'tsc --noEmit -p tsconfig.runtime-package.json --composite false',
    'package scripts should expose an agent package compile contract',
  )
  assert(
    packageJson.scripts?.typecheck ===
      'bun run typecheck:agent && bun run typecheck:agent-package && bun run typecheck:node && bun run typecheck:web',
    'full typecheck should run agent core, package, node, and web compile contracts',
  )
  const runtimeTsconfig = JSON.parse(
    await readFile(join(process.cwd(), 'tsconfig.runtime.json'), 'utf-8'),
  ) as {
    include?: string[]
  }
  assertEqual(
    JSON.stringify(runtimeTsconfig.include),
    JSON.stringify(['packages/agent/src/**/*', 'scripts/runtime-core-surface-contract.ts']),
    'agent-only tsconfig should compile the package source and public surface fixture',
  )
  assert(
    !JSON.stringify(runtimeTsconfig).includes('src/main'),
    'runtime-only tsconfig must not include Desktop/main adapter sources',
  )
  const runtimePackageTsconfig = JSON.parse(
    await readFile(join(process.cwd(), 'tsconfig.runtime-package.json'), 'utf-8'),
  ) as {
    compilerOptions?: {
      paths?: Record<string, string[]>
    }
    include?: string[]
  }
  assertEqual(
    JSON.stringify(runtimePackageTsconfig.include),
    JSON.stringify(['scripts/runtime-package-consumer-contract.ts']),
    'runtime package dry-run tsconfig should compile the simulated package consumer fixture only',
  )
  assertEqual(
    JSON.stringify(runtimePackageTsconfig.compilerOptions?.paths),
    JSON.stringify({
      '@aila/agent': ['./packages/agent/src/index.ts'],
      '@aila/agent/node': ['./packages/agent/src/node.ts'],
      '@shared/*': ['./src/shared/*'],
    }),
    'agent package dry-run aliases should model only public package entrypoints',
  )
  assert(
    !Object.keys(runtimePackageTsconfig.compilerOptions?.paths ?? {}).some(
      (path) => path === '@aila/agent/internal' || path === '@aila/agent/*',
    ),
    'runtime package dry-run must not expose an internal package alias',
  )
  const nodeTsconfig = JSON.parse(
    await readFile(join(process.cwd(), 'tsconfig.node.json'), 'utf-8'),
  ) as {
    exclude?: string[]
  }
  assert(
    nodeTsconfig.exclude?.includes('scripts/runtime-package-consumer-contract.ts'),
    'node tsconfig should leave the package dry-run fixture to the package compile contract',
  )
  const runtimePackageConsumerSource = await readFile(
    join(process.cwd(), 'scripts/runtime-package-consumer-contract.ts'),
    'utf-8',
  )
  assert(
    runtimePackageConsumerSource.includes("from '@aila/agent'") &&
      runtimePackageConsumerSource.includes("from '@aila/agent/node'") &&
      !runtimePackageConsumerSource.includes("from '@aila/agent/core'"),
    'agent package dry-run should consume the core and node package entrypoints',
  )
  for (const expectedError of [
    "typeof import('@aila/agent/internal')",
    'agent.executeTool',
    'agent.createConversation',
    'agent.createDoc',
    'agent.configureDataDir',
  ]) {
    assert(
      runtimePackageConsumerSource.includes('@ts-expect-error') &&
        runtimePackageConsumerSource.includes(expectedError),
      `runtime package dry-run should assert unavailable package API: ${expectedError}`,
    )
  }

  const runtimeCoreSdkSource = await readFile(
    join(process.cwd(), 'packages/agent/src/core.ts'),
    'utf-8',
  )
  for (const expected of [
    "'./agent-protocol'",
    "'./conversation-core'",
    "'./runtime'",
    "'./settings-types'",
    "'./skills'",
    "'./tool-approvals'",
    "'./tool-policy'",
    "'./tools'",
  ]) {
    assert(
      runtimeCoreSdkSource.includes(expected),
      `runtime core SDK should directly export runtime module: ${expected}`,
    )
  }
  for (const forbidden of [
    "'./find-replace'",
    'BUILTIN_TOOL_PACKS',
    'TOOL_DEFINITIONS',
    'TOOL_SPECS',
    'applyFindReplace',
    'createDefaultToolRegistry',
    'createToolRegistry',
    'evaluateToolPolicy',
    'executeTool',
    'formatFindReplaceErrors',
    'getToolDefinitions',
    'summarizeToolTarget',
  ]) {
    assert(
      !runtimeCoreSdkSource.includes(forbidden),
      `runtime core SDK source must not expose internal helper: ${forbidden}`,
    )
  }
  for (const forbidden of [
    "'../main/agent-protocol'",
    "'../main/conversation-core'",
    "'../main/find-replace'",
    "'../main/runtime'",
    "'../main/settings-types'",
    "'../main/skills'",
    "'../main/tool-approvals'",
    "'../main/tools'",
    "'../main/agent'",
    "'../main/conversations'",
    "'../main/extensions'",
    "'../main/paths'",
    "'../main/runtime-host'",
    "'../main/runtime-store'",
    "'../main/settings'",
    "'../main/skill-loader'",
    "'../main/tool-pack-loader'",
  ]) {
    assert(
      !runtimeCoreSdkSource.includes(forbidden),
      `runtime core SDK must not re-export node adapter module: ${forbidden}`,
    )
  }
  const runtimeInternalSdkSource = await readFile(
    join(process.cwd(), 'packages/agent/src/internal.ts'),
    'utf-8',
  )
  assert(
    runtimeInternalSdkSource.includes("from './find-replace'") &&
      runtimeInternalSdkSource.includes("from './tools'") &&
      runtimeInternalSdkSource.includes('executeTool') &&
      runtimeInternalSdkSource.includes('summarizeToolTarget'),
    'runtime internal SDK should own implementation helper exports',
  )
  for (const [mainFile, runtimeFile] of [
    ['agent-protocol.ts', 'agent-protocol'],
    ['conversation-core.ts', 'conversation-core'],
    ['runtime-events.ts', 'runtime-events'],
    ['context.ts', 'context'],
    ['runtime.ts', 'runtime'],
    ['settings-types.ts', 'settings-types'],
    ['tools.ts', 'tools'],
    ['skills.ts', 'skills'],
    ['tool-approvals.ts', 'tool-approvals'],
    ['find-replace.ts', 'find-replace'],
  ] as const) {
    const source = (await readFile(join(process.cwd(), 'src/main', mainFile), 'utf-8')).trim()
    assertEqual(
      source,
      `export * from '../../packages/agent/src/${runtimeFile}'`,
      `main ${mainFile} should stay a compatibility shim`,
    )
  }

  const conversationCoreSource = await readFile(
    join(process.cwd(), 'packages/agent/src/conversation-core.ts'),
    'utf-8',
  )
  assert(
    !conversationCoreSource.includes("from 'node:") &&
      !conversationCoreSource.includes('getConversationsDir') &&
      !conversationCoreSource.includes('appendFile(') &&
      !conversationCoreSource.includes('writeFile(') &&
      !conversationCoreSource.includes('readFile('),
    'conversation core must keep schema, normalization, and replay free of persisted filesystem IO',
  )

  const conversationsSource = await readFile(
    join(process.cwd(), 'src/main/conversations.ts'),
    'utf-8',
  )
  assert(
    conversationsSource.includes("from 'node:fs/promises'") &&
      conversationsSource.includes("from '../../packages/agent/src/conversation-core'") &&
      conversationsSource.includes('getConversationsDir'),
    'persisted conversations module should own filesystem IO and reuse pure conversation core contracts',
  )

  for (const adapterFile of [
    'src/main/agent.ts',
    'src/main/conversations.ts',
    'src/main/doc-conversation-cleanup.ts',
    'src/main/docs.ts',
    'src/main/filesystem.ts',
    'src/main/image-store.ts',
    'src/main/runtime-host.ts',
    'src/main/runtime-store.ts',
    'src/main/runtime-workbench.ts',
    'src/main/settings.ts',
    'src/main/shell.ts',
    'src/main/skill-loader.ts',
    'src/main/tool-pack-loader.ts',
    'src/main/web-search.ts',
    'src/main/workspace-context.ts',
  ]) {
    const source = await readFile(join(process.cwd(), adapterFile), 'utf-8')
    for (const forbidden of [
      "from './agent-protocol'",
      "from './conversation-core'",
      "from './runtime'",
      "from './settings-types'",
      "from './skills'",
      "from './tool-approvals'",
      "from './tools'",
    ]) {
      assert(
        !source.includes(forbidden),
        `${adapterFile} should not import runtime contracts through main compatibility shim: ${forbidden}`,
      )
    }
  }

  const runtimeNodeSdkSource = await readFile(
    join(process.cwd(), 'src/main/agent-host.ts'),
    'utf-8',
  )
  for (const expected of [
    "'./runtime-host'",
    "'./runtime-store'",
    "'./settings'",
    "'./paths'",
    "'./skill-loader'",
    "'./tool-pack-loader'",
  ]) {
    assert(
      runtimeNodeSdkSource.includes(expected),
      `runtime node SDK should re-export adapter module: ${expected}`,
    )
  }

  const packageNodeSource = await readFile(
    join(process.cwd(), 'packages/agent/src/node.ts'),
    'utf-8',
  )
  for (const expected of [
    "'./node/runtime-host'",
    "'./node/stream-chat'",
    "'./node/model-registry'",
    "'./node/protocols'",
    "'./node/auth'",
    "'./node/file-store'",
    "'./node/web-search'",
  ]) {
    assert(
      packageNodeSource.includes(expected),
      `@aila/agent/node should re-export adapter module: ${expected}`,
    )
  }

  const approvalSource = await readFile(
    join(process.cwd(), 'packages/agent/src/tool-approvals.ts'),
    'utf-8',
  )
  assert(
    !approvalSource.includes("from 'node:") &&
      !approvalSource.includes("from './runtime-host'") &&
      !approvalSource.includes("from './runtime-store'") &&
      !approvalSource.includes("from './conversations'") &&
      !approvalSource.includes('ipcMain') &&
      !approvalSource.includes('BrowserWindow'),
    'tool approval activity helpers must stay host-agnostic and free of Desktop/Node adapter wiring',
  )

  const toolsSource = await readFile(join(process.cwd(), 'packages/agent/src/tools.ts'), 'utf-8')
  assert(
    !toolsSource.includes("from './image'") &&
      !toolsSource.includes("from './image-store'") &&
      !toolsSource.includes('defaultGenerateImage') &&
      !toolsSource.includes('defaultSaveImage'),
    'builtin tool core must not import provider image generation or Desktop image storage',
  )
  assert(
    toolsSource.includes('image generation host is not available') &&
      toolsSource.includes('image storage host is not available'),
    'image tool should fail closed when host image dependencies are absent',
  )
  assert(
    !toolsSource.includes('TAVILY_API_KEY') &&
      !toolsSource.includes('https://api.tavily.com/search') &&
      !toolsSource.includes('fetch(') &&
      !toolsSource.includes('Tavily'),
    'builtin tool core must not own web search provider HTTP wiring',
  )
  assert(
    toolsSource.includes('web search host is not available'),
    'web search tool should fail closed when host search dependency is absent',
  )
  assert(
    !toolsSource.includes("from 'node:child_process'") &&
      !toolsSource.includes('execAsync') &&
      !toolsSource.includes('process.env'),
    'builtin tool core must not own shell process execution or environment wiring',
  )
  assert(
    toolsSource.includes('shell host is not available'),
    'bash tool should fail closed when host shell dependency is absent',
  )
  assert(
    !toolsSource.includes("from 'node:fs/promises'") &&
      !toolsSource.includes('readFile(') &&
      !toolsSource.includes('writeFile(') &&
      !toolsSource.includes('process.cwd()'),
    'builtin tool core must not own filesystem IO or default workspace roots',
  )
  assert(
    toolsSource.includes('filesystem host is not available') &&
      toolsSource.includes('no workspace roots configured'),
    'filesystem tools should fail closed when host filesystem or workspace roots are absent',
  )
  assert(
    toolsSource.includes("if (requiresApproval) return { action: 'ask' }"),
    'approval-required tools should fail closed unless a policy explicitly allows them',
  )
  assert(
    hostSource.includes("from '@aila/agent/node'") &&
      hostSource.includes('createDefaultNodeRuntimeHost'),
    'default runtime host should compose provider stream and model metadata wiring from @aila/agent/node',
  )

  const webSearchSource = await readFile(join(process.cwd(), 'src/main/web-search.ts'), 'utf-8')
  assert(
    webSearchSource.includes("from '@aila/agent/node'") &&
      webSearchSource.includes('createDefaultWebSearch') &&
      webSearchSource.includes('loadSettings().webSearch') &&
      !webSearchSource.includes('$TAVILY_API_KEY') &&
      !webSearchSource.includes('process.env') &&
      !webSearchSource.includes('https://api.tavily.com/search') &&
      !webSearchSource.includes('fetch('),
    'Desktop web search adapter should compose @aila/agent/node default search instead of owning provider HTTP wiring',
  )

  const nodeWebSearchSource = await readFile(
    join(process.cwd(), 'packages/agent/src/node/web-search/index.ts'),
    'utf-8',
  )
  assert(
    nodeWebSearchSource.includes('https://api.tavily.com/search') &&
      nodeWebSearchSource.includes('https://api.duckduckgo.com/') &&
      nodeWebSearchSource.includes('https://api.wikimedia.org/core/v1/wikipedia') &&
      nodeWebSearchSource.includes('https://hn.algolia.com/api/v1/search') &&
      nodeWebSearchSource.includes('https://export.arxiv.org/api/query') &&
      nodeWebSearchSource.includes('https://api.stackexchange.com/2.3/search/advanced') &&
      !nodeWebSearchSource.includes('process.env') &&
      !nodeWebSearchSource.includes('$TAVILY_API_KEY'),
    '@aila/agent/node web search provider registry should own provider HTTP wiring without env fallback',
  )

  const shellSource = await readFile(join(process.cwd(), 'src/main/shell.ts'), 'utf-8')
  assert(
    shellSource.includes("from 'node:child_process'") &&
      shellSource.includes('process.env') &&
      shellSource.includes('GIT_TERMINAL_PROMPT'),
    'default shell adapter should own process execution and environment wiring',
  )

  const filesystemSource = await readFile(join(process.cwd(), 'src/main/filesystem.ts'), 'utf-8')
  assert(
    filesystemSource.includes("from 'node:fs/promises'") &&
      filesystemSource.includes('readFile(') &&
      filesystemSource.includes('writeFile(') &&
      filesystemSource.includes('process.cwd()'),
    'default filesystem adapter should own filesystem IO and default workspace roots',
  )

  const protocolSource = await readFile(
    join(process.cwd(), 'packages/agent/src/agent-protocol.ts'),
    'utf-8',
  )
  assert(
    protocolSource.includes('export interface StreamRequest') &&
      protocolSource.includes('export type RuntimeStreamChat') &&
      protocolSource.includes('export type RuntimeModelInfoResolver') &&
      protocolSource.includes('fileSystem?:'),
    'agent protocol should define stream and model-info host contracts',
  )

  const skillCoreSource = await readFile(
    join(process.cwd(), 'packages/agent/src/skills.ts'),
    'utf-8',
  )
  for (const forbidden of [
    "from 'node:fs'",
    "from 'node:fs/promises'",
    "from 'node:path'",
    'getSkillsDir',
    'loadSkillFromDir',
    'loadSkillsFromDir',
  ]) {
    assert(
      !skillCoreSource.includes(forbidden),
      `skills core must not depend on filesystem loading: ${forbidden}`,
    )
  }

  const skillLoaderSource = await readFile(join(process.cwd(), 'src/main/skill-loader.ts'), 'utf-8')
  assert(
    skillLoaderSource.includes('loadSkillsFromDir') && skillLoaderSource.includes('getSkillsDir'),
    'filesystem skill loading should live in the host loader module',
  )

  assertEqual(
    typeof (runtimeSdk as Record<string, unknown>).createSkillToolPack,
    'function',
    'runtime SDK should expose the host-agnostic skill tool pack builder',
  )
  assertEqual(
    typeof (runtimeNodeSdk as Record<string, unknown>).loadSkillsFromDir,
    'function',
    'agent host adapter should expose the filesystem skill loader adapter',
  )
}

async function testPersistedAgentRuntimeFactoryContract(): Promise<void> {
  await withTempDataDir(async () => {
    const toolPacksDir = getToolPacksDir()
    const factoryToolPackDir = join(toolPacksDir, 'factory-pack')
    await mkdir(factoryToolPackDir, { recursive: true })

    await writeFile(
      join(factoryToolPackDir, AILA_TOOL_PACK_MANIFEST_FILE),
      `${JSON.stringify(
        {
          schemaVersion: AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION,
          id: 'factory-pack',
          name: 'Factory Pack',
          entry: 'index.mjs',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    )
    await writeFile(
      join(factoryToolPackDir, 'index.mjs'),
      `
export default {
  id: 'factory-pack',
  name: 'Factory Pack',
  tools: [
    {
      spec: {
        type: 'function',
        function: {
          name: 'factory_tool',
          description: 'Factory runtime host fixture.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
        metadata: {
          name: 'factory_tool',
          readOnly: true,
          destructive: false,
          requiresApproval: false,
          access: ['read'],
          scope: ['workspace'],
        },
      },
      async run() {
        return 'factory'
      },
    },
  ],
}
`.trimStart(),
      'utf-8',
    )

    const emitted: AgentRuntimeEvent[] = []
    const runtime = runtimeNodeSdk.createPersistedAgentRuntime({
      host: {
        onEvent: (event) => emitted.push(event),
      },
    })

    assert(
      (await runtime.getToolRegistry()).specsByName.has('factory_tool'),
      'persisted runtime factory should load manifest tool packs through the default host',
    )
    const conversation = await runtime.createConversation()
    const record = await runtime.getConversation(conversation.id)
    assertEqual(
      record.meta.id,
      conversation.id,
      'persisted runtime factory should use persisted store by default',
    )
    assert(
      emitted.some(
        (event) => event.type === 'conversations:updated' && event.data.id === conversation.id,
      ),
      'persisted runtime factory should preserve host event overrides',
    )
  })
}

async function testPersistedRuntimeFactoryPersistsImageAttachmentsThroughDefaultHost(): Promise<void> {
  await withTempDataDir(async () => {
    const runtime = runtimeNodeSdk.createPersistedAgentRuntime({
      host: {
        streamChat: async (req, handlers) => {
          await handlers.onDone({
            conversationId: req.conversationId,
            messageId: req.assistantMessageId,
            message: {
              schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
              id: req.assistantMessageId,
              role: 'assistant',
              blocks: [{ type: 'text', content: 'default host image attachment done' }],
              status: 'done',
              model: req.selection,
            },
          })
        },
      },
    })
    const conversation = await runtime.createConversation()

    await runtime.send({
      conversationId: conversation.id,
      userText: 'default host should persist image attachments',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      attachments: [
        {
          kind: 'image',
          name: 'default-host.png',
          mime: 'image/png',
          data: Buffer.from('default-host-image').toString('base64'),
        },
      ],
    })
    await waitFor(
      () => runtime.listActiveStreams().length === 0,
      'default host image attachment stream should settle',
    )

    const record = await runtime.getConversation(conversation.id)
    const imageBlock = record.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'image')
    assert(imageBlock, 'default host should persist an image block')
    assert(
      imageBlock.type === 'image' && imageBlock.url.startsWith('aila-image://i/'),
      'default host image block should use the Desktop image protocol',
    )
    const imageFiles = await readdir(getImagesDir())
    assertEqual(imageFiles.length, 1, 'default host should write one image asset')
  })
}

async function testToolPackManifestLoader(): Promise<void> {
  await withTempDataDir(async () => {
    const toolPacksDir = getToolPacksDir()
    const echoDir = join(toolPacksDir, 'echo')
    const disabledDir = join(toolPacksDir, 'disabled')
    await mkdir(echoDir, { recursive: true })
    await mkdir(disabledDir, { recursive: true })

    await writeFile(
      join(echoDir, AILA_TOOL_PACK_MANIFEST_FILE),
      `${JSON.stringify(
        {
          schemaVersion: AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION,
          id: 'echo',
          name: 'Echo',
          entry: 'index.mjs',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    )
    await writeFile(
      join(echoDir, 'index.mjs'),
      `
export default {
  id: 'echo',
  name: 'Echo',
  tools: [
    {
      spec: {
        type: 'function',
        function: {
          name: 'manifest_echo',
          description: 'Echo a value loaded from a manifest tool pack.',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
        metadata: {
          name: 'manifest_echo',
          readOnly: true,
          destructive: false,
          requiresApproval: false,
          access: ['read'],
          scope: ['workspace'],
        },
      },
      async run(args) {
        return JSON.stringify({ value: args.value })
      },
    },
  ],
}
`.trimStart(),
      'utf-8',
    )
    await writeFile(
      join(disabledDir, AILA_TOOL_PACK_MANIFEST_FILE),
      `${JSON.stringify(
        {
          schemaVersion: AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION,
          id: 'disabled',
          name: 'Disabled',
          entry: 'index.mjs',
          enabled: false,
        },
        null,
        2,
      )}\n`,
      'utf-8',
    )

    const loaded = await loadToolPacksFromDir()
    assertEqual(loaded.length, 1, 'disabled manifest tool pack should be skipped')
    assertEqual(loaded[0]?.manifest.id, 'echo', 'manifest id')
    assertEqual(loaded[0]?.toolPack.id, 'echo', 'loaded tool pack id')

    const registry = createDefaultToolRegistry(loaded.map((pack) => pack.toolPack))
    const result = await executeTool(
      'manifest_echo',
      { value: 'from manifest' },
      { settings: { apiKeys: {}, defaultModel: null } },
      registry,
    )
    assertEqual(JSON.parse(result).value, 'from manifest', 'manifest tool result')

    const runtime = new AgentRuntime({
      loadToolPacks: async () => (await loadToolPacksFromDir()).map((pack) => pack.toolPack),
      logger: { warn() {}, error() {} },
    })
    const runtimeRegistry = await runtime.getToolRegistry()
    assert(
      runtimeRegistry.specsByName.has('manifest_echo'),
      'AgentRuntime should load manifest tool packs',
    )
  })
}

async function testToolPackReloadsChangedEntry(): Promise<void> {
  await withTempDataDir(async () => {
    const toolPacksDir = getToolPacksDir()
    const reloadDir = join(toolPacksDir, 'reloadable')
    const entryPath = join(reloadDir, 'index.mjs')
    const valuePath = join(reloadDir, 'value.mjs')
    await mkdir(reloadDir, { recursive: true })

    await writeFile(
      join(reloadDir, AILA_TOOL_PACK_MANIFEST_FILE),
      `${JSON.stringify(
        {
          schemaVersion: AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION,
          id: 'reloadable',
          name: 'Reloadable',
          entry: 'index.mjs',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    )

    const writeReloadableToolPack = async (value: string) => {
      await writeFile(
        entryPath,
        `
import { reloadValue } from './value.mjs'

export default {
  id: 'reloadable',
  name: 'Reloadable',
  tools: [
    {
      spec: {
        type: 'function',
        function: {
          name: 'reload_value',
          description: 'Return the current reload test value.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        metadata: {
          name: 'reload_value',
          readOnly: true,
          destructive: false,
          requiresApproval: false,
          access: ['read'],
          scope: ['workspace'],
        },
      },
      async run() {
        return reloadValue
      },
    },
  ],
}
`.trimStart(),
        'utf-8',
      )
      await writeFile(valuePath, `export const reloadValue = ${JSON.stringify(value)}\n`, 'utf-8')
    }

    const runtime = new AgentRuntime({
      loadToolPacks: async () => (await loadToolPacksFromDir()).map((pack) => pack.toolPack),
      logger: { warn() {}, error() {} },
    })
    const context = {
      settings: { apiKeys: {}, defaultModel: null } satisfies Settings,
    }

    await writeReloadableToolPack('one')
    let registry = await runtime.getToolRegistry()
    assertEqual(
      await executeTool('reload_value', {}, context, registry),
      'one',
      'runtime should execute initial manifest tool pack entry',
    )

    await writeReloadableToolPack('version-two')
    registry = await runtime.reloadToolPacks()
    assertEqual(
      await executeTool('reload_value', {}, context, registry),
      'version-two',
      'runtime should execute changed manifest tool pack source after reload',
    )
  })
}

async function testExtensionReportContract(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const toolPackDir = join(dataDir, 'tool-packs', 'contract-inspector')
    await mkdir(toolPackDir, { recursive: true })
    await writeFile(
      join(toolPackDir, AILA_TOOL_PACK_MANIFEST_FILE),
      `${JSON.stringify(
        {
          schemaVersion: AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION,
          id: 'contract-inspector',
          name: 'Contract Inspector',
          entry: 'index.mjs',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    )
    await writeFile(
      join(toolPackDir, 'index.mjs'),
      `
export default {
  id: 'contract-inspector',
  name: 'Contract Inspector',
  tools: [
    {
      spec: {
        type: 'function',
        function: {
          name: 'contract_context',
          description: 'Return contract fixture context.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        metadata: {
          name: 'contract_context',
          readOnly: true,
          destructive: false,
          requiresApproval: false,
          access: ['read'],
          scope: ['workspace'],
        },
      },
      async run() {
        return JSON.stringify({ ok: true })
      },
    },
  ],
}
`.trimStart(),
      'utf-8',
    )

    const report = await getExtensionReport()
    assertEqual(report.ok, true, 'extension report should be ok')
    assertEqual(report.dataDir, dataDir, 'extension report data dir')
    assertEqual(report.toolPacks[0]?.id, 'contract-inspector', 'extension report tool pack id')
    assert(
      report.toolPacks[0]?.tools.includes('contract_context'),
      'extension report should include tool names',
    )
    assertEqual(report.errors.length, 0, 'extension report should not include errors')
  })
}

function skillDocument(name: string, description: string, body = 'Do the thing.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

async function writeSkill(skillsDir: string, dirName: string, contents: string): Promise<string> {
  const directory = join(skillsDir, dirName)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, AILA_SKILL_FILE), contents, 'utf-8')
  return directory
}

function testSkillDocumentParsingContract(): void {
  const parsed = parseSkillDocument(
    `---
name: pdf-processing
description: Extract text and tables from PDF files.
license: MIT
compatibility: Requires Python 3.
metadata:
  category: documents
allowed-tools: read, bash
---

# Steps

Use pdfplumber.
`,
  )
  assertEqual(parsed.definition.name, 'pdf-processing', 'skill name parsed')
  assertEqual(
    parsed.definition.description,
    'Extract text and tables from PDF files.',
    'skill description parsed',
  )
  assertEqual(parsed.definition.license, 'MIT', 'skill license parsed')
  assertEqual(parsed.definition.compatibility, 'Requires Python 3.', 'skill compatibility parsed')
  assertEqual(parsed.definition.metadata?.category, 'documents', 'skill metadata parsed')
  assert(
    parsed.definition.allowedTools?.includes('read') &&
      parsed.definition.allowedTools?.includes('bash'),
    'skill allowed-tools parsed from comma list',
  )
  assert(parsed.body.includes('Use pdfplumber.'), 'skill body excludes frontmatter')

  const expectFailure = (raw: string, label: string) => {
    let threw = false
    try {
      parseSkillDocument(raw)
    } catch {
      threw = true
    }
    assert(threw, label)
  }

  expectFailure('no frontmatter here', 'skill without frontmatter is rejected')
  expectFailure('---\nname: only-name\n---\n\nbody\n', 'skill without description is rejected')
  expectFailure(
    '---\nname: Bad_Name\ndescription: x\n---\n\nbody\n',
    'skill with invalid name characters is rejected',
  )
  expectFailure(
    `---\nname: empty-body\ndescription: ${'a'.repeat(2000)}\n---\n\nbody\n`,
    'skill with over-long description is rejected',
  )
  expectFailure(
    '---\nname: empty-body\ndescription: valid\n---\n\n   \n',
    'skill without body instructions is rejected',
  )
}

async function testSkillLoaderGracefulErrorsContract(): Promise<void> {
  await withTempDataDir(async () => {
    const skillsDir = getSkillsDir()
    await writeSkill(skillsDir, 'good-skill', skillDocument('good-skill', 'A working skill.'))
    // name must match directory name.
    await writeSkill(skillsDir, 'mismatch', skillDocument('other-name', 'Mismatched name.'))
    // Stray non-directory entry must be ignored, not fail the whole load.
    await writeFile(join(skillsDir, 'README.txt'), 'not a skill', 'utf-8')

    const result = await loadSkillsFromDir(skillsDir)
    assertEqual(result.skills.length, 1, 'loader returns only valid skills')
    assertEqual(result.skills[0]?.definition.name, 'good-skill', 'loader keeps valid skill')
    assertEqual(result.errors.length, 1, 'loader collects per-skill errors')
    assert(
      result.errors[0]?.message.includes('must match its directory name'),
      'loader reports name/directory mismatch',
    )

    const single = await loadSkillFromDir(join(skillsDir, 'good-skill'))
    assertEqual(single.definition.name, 'good-skill', 'loadSkillFromDir returns the skill')
  })
}

async function testSkillToolProgressiveDisclosureContract(): Promise<void> {
  await withTempDataDir(async () => {
    const skillsDir = getSkillsDir()
    await writeSkill(
      skillsDir,
      'brand-voice',
      skillDocument('brand-voice', 'Apply the company brand voice to copy.', 'Write warmly.'),
    )
    const referencePath = join(skillsDir, 'brand-voice', 'references', 'tone.md')
    await mkdir(join(skillsDir, 'brand-voice', 'references'), { recursive: true })
    await writeFile(referencePath, '# Tone\nFriendly.\n', 'utf-8')

    const runtime = new AgentRuntime({
      loadSkills: async () => (await loadSkillsFromDir()).skills,
      fileSystem: {
        readTextFile: (path) => readFile(path, 'utf-8'),
        writeTextFile: (path, content) => writeFile(path, content, 'utf-8'),
      },
      logger: { warn() {}, error() {} },
    })

    const registry = await runtime.getToolRegistry()
    const skillSpec = registry.specsByName.get(SKILL_TOOL_NAME)
    assert(skillSpec, 'runtime registers the skill tool when skills exist')
    // Level 1 disclosure: name + description embedded in the tool description.
    assert(
      skillSpec?.function.description.includes('brand-voice') &&
        skillSpec?.function.description.includes('Apply the company brand voice'),
      'skill tool description embeds skill name and description',
    )
    const skillParams = skillSpec?.function.parameters as {
      properties?: { name?: { enum?: string[] } }
    }
    assert(
      skillParams.properties?.name?.enum?.includes('brand-voice'),
      'skill tool constrains name to known skills',
    )

    const context = { settings: { apiKeys: {}, defaultModel: null } satisfies Settings }
    const output = await executeTool(SKILL_TOOL_NAME, { name: 'brand-voice' }, context, registry)
    // Level 2 disclosure: SKILL.md body returned on invocation.
    assert(output.includes('Write warmly.'), 'skill invocation returns the SKILL.md body')
    // Level 3 disclosure: bundled files listed for on-demand reading.
    assert(output.includes(referencePath), 'skill invocation lists bundled files')

    let unknownThrew = false
    try {
      await executeTool(SKILL_TOOL_NAME, { name: 'missing' }, context, registry)
    } catch {
      unknownThrew = true
    }
    assert(unknownThrew, 'skill invocation rejects unknown skill names')
  })
}

async function testSkillBundledFilesAreReadableContract(): Promise<void> {
  await withTempDataDir(async () => {
    const skillsDir = getSkillsDir()
    await writeSkill(
      skillsDir,
      'data-helper',
      skillDocument('data-helper', 'Helps with data.', 'See scripts/run.py.'),
    )
    const scriptPath = join(skillsDir, 'data-helper', 'scripts', 'run.py')
    await mkdir(join(skillsDir, 'data-helper', 'scripts'), { recursive: true })
    await writeFile(scriptPath, 'print("hi")\n', 'utf-8')

    const runtime = new AgentRuntime({
      loadSkills: async () => (await loadSkillsFromDir()).skills,
      fileSystem: {
        readTextFile: (path) => readFile(path, 'utf-8'),
        writeTextFile: (path, content) => writeFile(path, content, 'utf-8'),
      },
      logger: { warn() {}, error() {} },
    })

    // The skill directory is added as a workspace root, so the read tool can
    // open bundled files even though they live under the data dir.
    const readOutput = await runtime.executeTool({ name: 'read', args: { path: scriptPath } })
    assert(readOutput.includes('print("hi")'), 'read tool can open bundled skill files')
  })
}

async function testSkillReloadPicksUpNewSkillsContract(): Promise<void> {
  await withTempDataDir(async () => {
    const skillsDir = getSkillsDir()
    await writeSkill(skillsDir, 'first', skillDocument('first', 'The first skill.'))

    const runtime = new AgentRuntime({
      loadSkills: async () => (await loadSkillsFromDir()).skills,
      logger: { warn() {}, error() {} },
    })

    let registry = await runtime.getToolRegistry()
    let params = registry.specsByName.get(SKILL_TOOL_NAME)?.function.parameters as {
      properties?: { name?: { enum?: string[] } }
    }
    assert(params.properties?.name?.enum?.includes('first'), 'initial skill is registered')
    assert(!params.properties?.name?.enum?.includes('second'), 'second skill not yet present')

    await writeSkill(skillsDir, 'second', skillDocument('second', 'The second skill.'))
    registry = await runtime.reloadToolPacks()
    params = registry.specsByName.get(SKILL_TOOL_NAME)?.function.parameters as {
      properties?: { name?: { enum?: string[] } }
    }
    assert(
      params.properties?.name?.enum?.includes('first') &&
        params.properties?.name?.enum?.includes('second'),
      'reload picks up newly added skills',
    )
  })
}

async function testPersistedRuntimeLoadsSkillsContract(): Promise<void> {
  await withTempDataDir(async () => {
    await writeSkill(
      getSkillsDir(),
      'factory-skill',
      skillDocument('factory-skill', 'Loaded through the default host.'),
    )
    const runtime = runtimeNodeSdk.createPersistedAgentRuntime()
    const registry = await runtime.getToolRegistry()
    assert(
      registry.specsByName.has(SKILL_TOOL_NAME),
      'persisted runtime factory loads skills through the default host',
    )
    const skills = await runtime.getSkills()
    assertEqual(
      skills[0]?.definition.name,
      'factory-skill',
      'default host loads skills from dataDir',
    )
  })
}

async function testSkillExtensionReportContract(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const skillsDir = getSkillsDir()
    await writeSkill(skillsDir, 'reportable', skillDocument('reportable', 'Shows up in reports.'))
    await writeSkill(skillsDir, 'broken', skillDocument('different', 'Name mismatch error.'))

    const report = await getExtensionReport()
    assertEqual(report.skillsDir, skillsDir, 'extension report exposes skills dir')
    assert(
      report.skills.some((skill) => skill.name === 'reportable'),
      'extension report lists loaded skills',
    )
    const skillError = report.errors.find((error) => error.kind === 'skills')
    assert(skillError, 'extension report surfaces skill load errors')
    assertEqual(report.ok, false, 'extension report is not ok when a skill fails to load')
    assertEqual(report.dataDir, dataDir, 'extension report data dir')
  })
}

async function main(): Promise<void> {
  await testRuntimeEventContract()
  await testRuntimeEmitsVersionedEvents()
  await testRuntimeWithoutStreamHostFailsAtSetupBoundary()
  await testRuntimeHostBoundaryContract()
  await testRuntimeSettingsFallbackIsHostAgnostic()
  await testRuntimeStreamAndModelInfoUseHostBoundary()
  await testRuntimeAttachmentPersistenceUsesHostBoundary()
  await testRuntimeTextAttachmentFallbackIsHostAgnostic()
  await testRuntimeImageAttachmentRequiresHostBoundary()
  await testRuntimeRejectsInvalidHostAttachmentBlocks()
  await testRuntimeHostStaticExtensionContract()
  await testRuntimeDynamicExtensionLoaderSnapshots()
  await testRuntimeInjectableStoreContract()
  await testRuntimeHostTransientContextUsesInjectedRecord()
  await testRuntimeHostStableInstructionsUsesInjectedRecord()
  testContextAssemblerSectionsContract()
  await testRuntimeStreamHandlerSnapshots()
  await testRuntimeConversationStoreFacadeContract()
  await testRuntimeConversationRuntimeStateApiUsesEventReplay()
  await testRuntimeOptionalStoreCapabilitiesFailClosed()
  await testInMemoryRuntimeStoreEventListContract()
  await testRuntimeEnvironmentContract()
  await testRuntimeAppendUserMessageUsesInjectedStore()
  await testRuntimeRecordAgentEventUsesInjectedStore()
  await testRuntimeRecoveryDelegatesToInjectedStore()
  await testRuntimeRecoveryUsesInjectedStoreReplay()
  await testRuntimeDeleteAssetCleanupHostBoundary()
  await testRuntimeRetriesDanglingUserTurn()
  await testRuntimeRetriesFailedAssistantTurn()
  await testRuntimeContextSkipsNonDoneAssistantHistory()
  await testRuntimeSerializesConcurrentTurnStarts()
  await testRuntimeAbortCancelsTurnSetupBeforeStreamStarts()
  await testRuntimeSendRecoversTimedOutTurnSetupLock()
  await testRuntimeAbortPersistsCancellationActivity()
  await testRuntimeAbortTimesOutStuckStreamCleanup()
  await testRuntimeRepeatedAbortWaitsForSameCleanup()
  await testRuntimeUnexpectedStreamErrorPersistsFailureActivity()
  await testRuntimeSetupFailurePersistsAssistantError()
  await testRuntimeSetupFailureRejectsWhenConversationDeleted()
  await testRuntimeSetupFailureSuppressesChatErrorAfterDelete()
  await testRuntimeListsActiveAssistantTurns()
  await testRuntimeDeleteRunsAbortCleanupBeforeWaitingForStream()
  await testRuntimeDeleteTimesOutStuckStreamAndSuppressesLateEvents()
  await testRuntimeRejectsNewTurnsAfterDeleteStarts()
  await testRuntimeDeleteFailureReopensConversation()
  await testRuntimeDeleteFailureRecordsCancellationForReopenedTurn()
  await testRuntimeSendRecoversAbortedStuckPreviousStream()
  await testRuntimeAbortAllWaitsForShutdownCleanup()
  await testRuntimeAbortAllTimesOutStuckStreamCleanup()
  await testRuntimeShutdownRejectsNewTurns()
  await testPersistenceContract()
  await testMessageUpsertPreventsDuplicatePersistedMessages()
  await testAgentEventReplayDeduplicatesExactDuplicates()
  await testAgentEventReplayPreservesAppendOrderForSameTimestamp()
  testAgentEventReplayDerivesLatestActivity()
  testAgentEventReplayDerivesRuntimeState()
  testAgentEventReplayKeepsToolFailureActive()
  testInterruptedRecoveryEventHelper()
  await testInterruptedRecoveryUsesEventReplayOverStaleMeta()
  await testInterruptedRecoveryFallsBackToLegacyMetaActivity()
  await testInterruptedRecoveryUsesRuntimeReplayForNonTerminalToolFailure()
  await testLegacyPersistenceNormalization()
  await testImmediateToolApprovalActivityHelper()
  await testToolRegistryContract()
  await testRuntimeExecuteToolUsesHostBoundary()
  await testGenerateImageToolUsesInjectedImageDependencies()
  await testGenerateImageToolRequiresHostImageDependencies()
  await testWebSearchToolUsesInjectedHostDependency()
  await testWebSearchToolRequiresHostDependency()
  await testNodeWebSearchRegistryFallbacksAndMerge()
  testToolActivityTargetContract()
  await testFilesystemToolWorkspaceRootsContract()
  await testDefaultRuntimeHostOwnsFilesystemTools()
  await testBashToolShellCwdContract()
  await testBashToolRequiresHostDependency()
  await testRuntimeCoreHasNoDocToolContract()
  await testRuntimeSdkDoesNotExportDocsContract()
  await testRuntimeCoreHostBoundarySourceContract()
  await testPersistedAgentRuntimeFactoryContract()
  await testPersistedRuntimeFactoryPersistsImageAttachmentsThroughDefaultHost()
  await testToolPackManifestLoader()
  await testToolPackReloadsChangedEntry()
  await testExtensionReportContract()
  testSkillDocumentParsingContract()
  await testSkillLoaderGracefulErrorsContract()
  await testSkillToolProgressiveDisclosureContract()
  await testSkillBundledFilesAreReadableContract()
  await testSkillReloadPicksUpNewSkillsContract()
  await testPersistedRuntimeLoadsSkillsContract()
  await testSkillExtensionReportContract()
  console.log('runtime contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
