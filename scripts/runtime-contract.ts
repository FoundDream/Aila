import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runtimeSdk from '../src/runtime'
import {
  AgentRuntime,
  type AgentRuntimeEvent,
  type AgentRuntimeHost,
  type AgentRuntimeStore,
  AILA_AGENT_EVENT_SCHEMA_VERSION,
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  AILA_PROFILE_MANIFEST_SCHEMA_VERSION,
  AILA_RUNTIME_EVENT_SCHEMA_VERSION,
  AILA_RUNTIME_EVENT_TYPES,
  AILA_TOOL_PACK_MANIFEST_FILE,
  AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION,
  appendAgentEvent,
  appendAgentEventAndTouchConversation,
  appendMessage,
  type ConversationRecord,
  configureDataDir,
  createConversation,
  createDefaultToolRegistry,
  createInterruptedConversationRecoveryEvent,
  createRuntimeEvent,
  deleteConversation,
  executeTool,
  getConversation,
  getConversationsDir,
  getExtensionReport,
  getProfilesDir,
  getToolDefinitionsForProfile,
  getToolPacksDir,
  isRuntimeEventType,
  listAgentEvents,
  listConversations,
  loadAgentProfilesFromDir,
  loadToolPacksFromDir,
  type PersistedAgentEvent,
  recoverInterruptedConversationActivities,
  replayConversationActivity,
  replayConversationRuntimeState,
  type Settings,
  setConversationUsage,
  summarizeToolTarget,
  type ToolPack,
  upsertMessage,
} from '../src/runtime'

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

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
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
    const previousOpenRouterKey = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = ''
    try {
      const conversation = await createConversation()
      const events: AgentRuntimeEvent[] = []
      const runtime = new AgentRuntime({
        onEvent: (event) => events.push(event),
        logger: { warn() {}, error() {} },
      })

      await runtime.send({
        conversationId: conversation.id,
        userText: 'runtime contract smoke',
        selection: { providerId: 'openrouter', modelId: 'minimax/minimax-m3' },
        requestedProfileId: 'coding',
      })

      await waitFor(
        () => events.some((event) => event.type === 'chat:error'),
        'runtime did not emit expected no-key error event',
      )
      await runtime.abortAll()

      assert(events.length >= 2, 'runtime should emit persistence and error events')
      for (const event of events) {
        assertEqual(event.schemaVersion, AILA_RUNTIME_EVENT_SCHEMA_VERSION, 'runtime event version')
        assert(isRuntimeEventType(event.type), `runtime emitted unknown event type: ${event.type}`)
      }
    } finally {
      if (previousOpenRouterKey === undefined) {
        delete process.env.OPENROUTER_API_KEY
      } else {
        process.env.OPENROUTER_API_KEY = previousOpenRouterKey
      }
    }
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
    let profileId: string | null = null
    let workspaceRootPath: string | null = null
    let workspaceRootLabel: string | null = null
    let shellCwdPath: string | null = null
    let settingsLoaded = false
    let streamSettingsKey: string | null = null

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
      loadProfiles: async () => [
        {
          id: 'host-coding',
          label: 'Host Coding',
          description: 'Runtime host boundary fixture.',
          baseProfileId: 'coding',
          instructions: 'Use host-provided profile instructions.',
        },
      ],
      loadSettings: () => {
        settingsLoaded = true
        return { apiKeys: { openrouter: 'host-openrouter-key' }, defaultModel: null }
      },
      workspaceRoots: () => [{ path: '/host/workspace', label: 'host-root' }],
      shellCwd: () => '/host/shell',
      streamChat: async (req, handlers) => {
        profileId = req.profileId
        shellCwdPath = req.shellCwd ?? null
        streamSettingsKey = req.settings?.apiKeys.openrouter ?? null
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
            allowedProfiles: ['coding'],
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
              allowedProfiles: ['coding'],
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
          data: { providerId: req.selection.providerId, modelId: req.selection.modelId },
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
    const runtime = new AgentRuntime({ host })

    await runtime.send({
      conversationId: conversation.id,
      userText: 'exercise host boundary',
      selection: { providerId: 'openrouter', modelId: 'contract/mock' },
      requestedProfileId: 'host-coding',
    })
    await waitFor(() => streamStarted, 'host streamChat should start')
    await runtime.abort(conversation.id)

    assertEqual(profileId, 'coding', 'host-loaded profile should resolve to base profile')
    assertEqual(settingsLoaded, true, 'host settings loader should be called')
    assertEqual(
      streamSettingsKey,
      'host-openrouter-key',
      'host settings should be passed to streamChat',
    )
    assertEqual(workspaceRootPath, '/host/workspace', 'host workspace root path')
    assertEqual(workspaceRootLabel, 'host-root', 'host workspace root label')
    assertEqual(shellCwdPath, '/host/shell', 'host shell cwd should pass to streamChat')
    assertEqual(policyRequested, true, 'host tool policy should receive tool request')
    assertEqual(approvalRequested, true, 'host tool approval should receive tool request')
    assertEqual(approvalResult, true, 'host tool approval should resolve request')
    assertEqual(abortConversationId, conversation.id, 'host abort cleanup conversation id')
    assertEqual(abortReason, 'user', 'host abort cleanup reason')
    assert(
      events.some((event) => event.type === 'agent:event' && event.data.type === 'turn.cancelled'),
      'host onEvent should receive runtime events',
    )
    assertEqual(runtime.listActiveStreams().length, 0, 'host aborted stream should settle')
  })
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
            allowedProfiles: ['coding'],
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
            allowedProfiles: ['coding'],
          },
        },
        async run() {
          return 'host'
        },
      },
    ],
  }

  const runtime = new AgentRuntime({
    profiles: [
      {
        id: 'static-host-profile',
        label: 'Top Level Profile',
        description: 'Top-level compatibility profile.',
        baseProfileId: 'chat',
      },
    ],
    toolPacks: [topLevelPack],
    host: {
      profiles: [
        {
          id: 'static-host-profile',
          label: 'Host Profile',
          description: 'Host static profile.',
          baseProfileId: 'coding',
        },
      ],
      toolPacks: [hostPack],
    },
  })

  const profiles = await runtime.getProfiles()
  assertEqual(
    profiles.get('static-host-profile')?.label,
    'Host Profile',
    'host static profiles should be part of the runtime host boundary',
  )
  assertEqual(
    profiles.get('static-host-profile')?.baseProfileId,
    'coding',
    'host static profiles should take precedence over top-level compatibility profiles',
  )

  const registry = await runtime.getToolRegistry()
  assert(
    registry.specsByName.has('host_static_tool'),
    'host static tool packs should be part of the runtime host boundary',
  )
  assert(
    !registry.specsByName.has('top_level_static_tool'),
    'host static tool packs should take precedence over top-level compatibility tool packs',
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
      upsertMessage: async (conversationId, message) => {
        calls.push(`upsert:${message.role}:${message.id}`)
        return upsertMessage(conversationId, message)
      },
      appendAgentEventAndTouchConversation: async (conversationId, event) => {
        calls.push(`event:${event.type}`)
        return appendAgentEventAndTouchConversation(conversationId, event)
      },
      setConversationUsage: async (conversationId, usage) => {
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
      requestedProfileId: 'coding',
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

async function testRuntimeDeleteAssetCleanupHostBoundary(): Promise<void> {
  await withTempDataDir(async () => {
    let getCalledWithoutHook = false
    let deleteCalledWithoutHook = false
    const withoutCleanupStore: AgentRuntimeStore = {
      getConversation: async () => {
        getCalledWithoutHook = true
        throw new Error('delete without cleanup hook should not read conversation')
      },
      upsertMessage: async () => {
        throw new Error('not used')
      },
      appendAgentEventAndTouchConversation: async () => {
        throw new Error('not used')
      },
      setConversationUsage: async () => {
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
      upsertMessage: async () => {
        throw new Error('not used')
      },
      appendAgentEventAndTouchConversation: async () => {
        throw new Error('not used')
      },
      setConversationUsage: async () => {
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
        onEvent: (event) => events.push(event),
        logger: { warn() {}, error() {} },
      })

      const result = await runtime.retryLastUserMessage({
        conversationId: conversation.id,
        selection: { providerId: 'openrouter', modelId: 'minimax/minimax-m3' },
        requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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

async function testRuntimeAbortPersistsCancellationActivity(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const runtime = new AgentRuntime({
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
      requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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

async function testRuntimeUnexpectedStreamErrorPersistsFailureActivity(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation()
    const events: AgentRuntimeEvent[] = []
    const runtime = new AgentRuntime({
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
      requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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
        requestedProfileId: 'coding',
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
        requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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
            requestedProfileId: 'coding',
          })
        } else {
          await runtime.retryLastUserMessage({
            conversationId: conversation.id,
            selection: { providerId: 'openrouter', modelId: 'contract/mock' },
            requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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
        requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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
      requestedProfileId: 'coding',
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
            requestedProfileId: 'coding',
          })
        } else {
          await runtime.retryLastUserMessage({
            conversationId: conversation.id,
            selection: { providerId: 'openrouter', modelId: 'contract/mock' },
            requestedProfileId: 'coding',
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
        requestedProfileId: 'coding',
      })
    } catch (error) {
      rejectedAfterShutdown = error instanceof Error && error.message.includes('shut down')
    }
    assert(rejectedAfterShutdown, 'send should reject after shutdown finishes')
  })
}

async function testPersistenceContract(): Promise<void> {
  await withTempDataDir(async () => {
    const conversation = await createConversation('docs/runtime-contract')
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
            allowedProfiles: ['coding'],
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
    getToolDefinitionsForProfile('coding', registry).some(
      (definition) => definition.function.name === 'contract_echo',
    ),
    'custom tool should be exposed to allowed profile',
  )
  const result = await executeTool(
    'contract_echo',
    { value: 'hello' },
    { settings, profileId: 'coding' },
    registry,
  )
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
            allowedProfiles: ['coding'],
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
        profileId: 'coding',
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
            allowedProfiles: ['coding'],
          },
        },
        async run() {
          policyAllowedRunnerCalled = true
          return 'policy ok'
        },
      },
    ],
  }
  const policyRegistry = createDefaultToolRegistry([policyPack])

  const allowed = await executeTool(
    'contract_policy_tool',
    { mode: 'allow' },
    {
      settings,
      profileId: 'coding',
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
      profileId: 'coding',
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
  try {
    await executeTool(
      'contract_policy_tool',
      { mode: 'deny' },
      {
        settings,
        profileId: 'coding',
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
      profileId: 'chat',
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
  const dir = await mkdtemp(join(tmpdir(), 'aila-tool-workspace-'))
  try {
    const sourcePath = join(dir, 'source.md')
    await writeFile(sourcePath, 'hello workspace roots', 'utf-8')

    try {
      await executeTool('read', { path: sourcePath }, { settings, profileId: 'coding' })
      throw new Error('read outside default workspace unexpectedly succeeded')
    } catch (error) {
      assert(
        error instanceof Error && error.message.includes('outside workspace roots'),
        'read outside configured roots should be denied',
      )
    }

    const previousCwd = process.cwd()
    try {
      process.chdir(dir)
      const cwdSourcePath = join(process.cwd(), 'source.md')
      assertEqual(
        await executeTool('read', { path: cwdSourcePath }, { settings, profileId: 'coding' }),
        'hello workspace roots',
        'default workspace root should resolve from current cwd at execution time',
      )
    } finally {
      process.chdir(previousCwd)
    }

    const readResult = await executeTool(
      'read',
      { path: sourcePath },
      { settings, profileId: 'coding', workspaceRoots: [{ path: dir, label: 'contract' }] },
    )
    assertEqual(readResult, 'hello workspace roots', 'read should allow configured workspace root')

    const writePath = join(dir, 'created.md')
    await executeTool(
      'write',
      { path: writePath, content: 'draft' },
      { settings, profileId: 'coding', workspaceRoots: [dir] },
    )
    assertEqual(await readFile(writePath, 'utf-8'), 'draft', 'write should target extra root')

    await executeTool(
      'edit',
      { path: writePath, oldText: 'draft', newText: 'final' },
      { settings, profileId: 'coding', workspaceRoots: [dir] },
    )
    assertEqual(await readFile(writePath, 'utf-8'), 'final', 'edit should target extra root')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testBashToolShellCwdContract(): Promise<void> {
  const settings: Settings = { apiKeys: {}, defaultModel: null }
  const dir = await mkdtemp(join(tmpdir(), 'aila-tool-shell-'))
  try {
    const result = await executeTool(
      'bash',
      { command: 'printf shell-cwd > shell-cwd.txt' },
      { settings, profileId: 'coding', shellCwd: dir },
    )
    const parsed = JSON.parse(result) as { exit_code?: unknown }
    assertEqual(parsed.exit_code, 0, 'bash shell cwd command should succeed')
    assertEqual(
      await readFile(join(dir, 'shell-cwd.txt'), 'utf-8'),
      'shell-cwd',
      'bash tool should run from injected shell cwd',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testRuntimeCoreHasNoDocToolContract(): Promise<void> {
  const registry = createDefaultToolRegistry()
  assert(!registry.specsByName.has('edit_doc'), 'runtime core must not register edit_doc')

  for (const spec of registry.specs) {
    assert(
      !(spec.metadata.allowedProfiles as readonly string[]).includes('doc'),
      `tool ${spec.metadata.name} must not target a doc profile`,
    )
    assert(
      !(spec.metadata.access as readonly string[]).includes('doc'),
      `tool ${spec.metadata.name} must not use doc access`,
    )
    assert(
      !(spec.metadata.scope as readonly string[]).includes('current_doc'),
      `tool ${spec.metadata.name} must not use current_doc scope`,
    )
  }

  assert(
    !Object.hasOwn(runtimeSdk.AGENT_PROFILES, 'doc'),
    'runtime core must not expose a built-in doc profile',
  )
  assertEqual(runtimeSdk.isBuiltinAgentProfileId('doc'), false, 'doc is not a built-in profile')

  try {
    await executeTool(
      'edit_doc',
      {},
      { settings: { apiKeys: {}, defaultModel: null }, profileId: 'coding' },
      registry,
    )
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
          allowedProfiles: ['coding'],
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
      { settings: { apiKeys: {}, defaultModel: null }, profileId: 'coding' },
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
          allowedProfiles: ['coding'],
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
      profileId: 'coding' as const,
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

async function testProfileManifestLoader(): Promise<void> {
  await withTempDataDir(async () => {
    const profilesDir = getProfilesDir()
    await mkdir(profilesDir, { recursive: true })
    await writeFile(
      join(profilesDir, 'manifest-reviewer.json'),
      `${JSON.stringify(
        {
          schemaVersion: AILA_PROFILE_MANIFEST_SCHEMA_VERSION,
          id: 'manifest-reviewer',
          label: 'Manifest Reviewer',
          description: 'Review code with a conservative engineering stance.',
          baseProfileId: 'coding',
          instructions: 'Prioritize bugs, regressions, and missing tests.',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    )
    await writeFile(
      join(profilesDir, 'disabled.json'),
      `${JSON.stringify(
        {
          schemaVersion: AILA_PROFILE_MANIFEST_SCHEMA_VERSION,
          id: 'disabled-profile',
          label: 'Disabled',
          description: 'Should not load.',
          baseProfileId: 'chat',
          enabled: false,
        },
        null,
        2,
      )}\n`,
      'utf-8',
    )

    const loaded = await loadAgentProfilesFromDir()
    assertEqual(loaded.length, 1, 'disabled profile manifest should be skipped')
    assertEqual(loaded[0]?.manifest.id, 'manifest-reviewer', 'profile manifest id')
    assertEqual(loaded[0]?.profile.baseProfileId, 'coding', 'profile base id')
    assertEqual(
      loaded[0]?.profile.instructions,
      'Prioritize bugs, regressions, and missing tests.',
      'profile instructions',
    )

    const runtime = new AgentRuntime({
      loadProfiles: async () =>
        (await loadAgentProfilesFromDir()).map((profile) => profile.profile),
      logger: { warn() {}, error() {} },
    })
    const profiles = await runtime.getProfiles()
    assert(profiles.has('manifest-reviewer'), 'AgentRuntime should load manifest profiles')
    await runtime.reloadProfiles()
  })
}

async function testExtensionReportContract(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const profilesDir = join(dataDir, 'profiles')
    const toolPackDir = join(dataDir, 'tool-packs', 'contract-inspector')
    await mkdir(profilesDir, { recursive: true })
    await mkdir(toolPackDir, { recursive: true })
    await writeFile(
      join(profilesDir, 'contract-reviewer.json'),
      `${JSON.stringify(
        {
          schemaVersion: AILA_PROFILE_MANIFEST_SCHEMA_VERSION,
          id: 'contract-reviewer',
          label: 'Contract Reviewer',
          description: 'Contract fixture profile.',
          baseProfileId: 'coding',
          instructions: 'Review contract behavior.',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    )
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
          allowedProfiles: ['coding'],
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
    assertEqual(report.profiles[0]?.id, 'contract-reviewer', 'extension report profile id')
    assertEqual(report.toolPacks[0]?.id, 'contract-inspector', 'extension report tool pack id')
    assert(
      report.toolPacks[0]?.tools.includes('contract_context'),
      'extension report should include tool names',
    )
    assertEqual(report.errors.length, 0, 'extension report should not include errors')
  })
}

async function main(): Promise<void> {
  await testRuntimeEventContract()
  await testRuntimeEmitsVersionedEvents()
  await testRuntimeHostBoundaryContract()
  await testRuntimeHostStaticExtensionContract()
  await testRuntimeInjectableStoreContract()
  await testRuntimeDeleteAssetCleanupHostBoundary()
  await testRuntimeRetriesDanglingUserTurn()
  await testRuntimeRetriesFailedAssistantTurn()
  await testRuntimeContextSkipsNonDoneAssistantHistory()
  await testRuntimeAbortPersistsCancellationActivity()
  await testRuntimeAbortTimesOutStuckStreamCleanup()
  await testRuntimeUnexpectedStreamErrorPersistsFailureActivity()
  await testRuntimeSetupFailurePersistsAssistantError()
  await testRuntimeSetupFailureRejectsWhenConversationDeleted()
  await testRuntimeSetupFailureSuppressesChatErrorAfterDelete()
  await testRuntimeListsActiveAssistantTurns()
  await testRuntimeDeleteRunsAbortCleanupBeforeWaitingForStream()
  await testRuntimeDeleteTimesOutStuckStreamAndSuppressesLateEvents()
  await testRuntimeRejectsNewTurnsAfterDeleteStarts()
  await testRuntimeDeleteFailureReopensConversation()
  await testRuntimeSendRecoversAbortedStuckPreviousStream()
  await testRuntimeAbortAllWaitsForShutdownCleanup()
  await testRuntimeAbortAllTimesOutStuckStreamCleanup()
  await testRuntimeShutdownRejectsNewTurns()
  await testPersistenceContract()
  await testMessageUpsertPreventsDuplicatePersistedMessages()
  await testAgentEventReplayDeduplicatesExactDuplicates()
  testAgentEventReplayDerivesLatestActivity()
  testAgentEventReplayDerivesRuntimeState()
  testAgentEventReplayKeepsToolFailureActive()
  testInterruptedRecoveryEventHelper()
  await testInterruptedRecoveryUsesEventReplayOverStaleMeta()
  await testInterruptedRecoveryFallsBackToLegacyMetaActivity()
  await testInterruptedRecoveryUsesRuntimeReplayForNonTerminalToolFailure()
  await testLegacyPersistenceNormalization()
  await testToolRegistryContract()
  await testGenerateImageToolUsesInjectedImageDependencies()
  testToolActivityTargetContract()
  await testFilesystemToolWorkspaceRootsContract()
  await testBashToolShellCwdContract()
  await testRuntimeCoreHasNoDocToolContract()
  await testRuntimeSdkDoesNotExportDocsContract()
  await testToolPackManifestLoader()
  await testToolPackReloadsChangedEntry()
  await testProfileManifestLoader()
  await testExtensionReportContract()
  console.log('runtime contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
