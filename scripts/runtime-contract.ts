import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runtimeSdk from '../src/runtime'
import {
  AgentRuntime,
  type AgentRuntimeEvent,
  AILA_AGENT_EVENT_SCHEMA_VERSION,
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  AILA_PROFILE_MANIFEST_SCHEMA_VERSION,
  AILA_RUNTIME_EVENT_SCHEMA_VERSION,
  AILA_RUNTIME_EVENT_TYPES,
  AILA_TOOL_PACK_MANIFEST_FILE,
  AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION,
  appendAgentEvent,
  appendMessage,
  configureDataDir,
  createConversation,
  createDefaultToolRegistry,
  createRuntimeEvent,
  executeTool,
  getConversation,
  getConversationsDir,
  getExtensionReport,
  getProfilesDir,
  getToolDefinitionsForProfile,
  getToolPacksDir,
  isRuntimeEventType,
  listConversations,
  loadAgentProfilesFromDir,
  loadToolPacksFromDir,
  type Settings,
  type ToolPack,
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
      runtime.abortAll()

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
      runtime.abortAll()

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
      type: 'turn.started',
    })
    const rawAgentEvent = JSON.parse(
      (await readFile(join(dir, `${conversation.id}.events.jsonl`), 'utf-8')).trim(),
    ) as { schemaVersion?: number }
    assertEqual(
      rawAgentEvent.schemaVersion,
      AILA_AGENT_EVENT_SCHEMA_VERSION,
      'written agent event version',
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
        async onToolApproval() {
          approvalRequested = true
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
      join(profilesDir, 'code-reviewer.json'),
      `${JSON.stringify(
        {
          schemaVersion: AILA_PROFILE_MANIFEST_SCHEMA_VERSION,
          id: 'code-reviewer',
          label: 'Code Reviewer',
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
    assertEqual(loaded[0]?.manifest.id, 'code-reviewer', 'profile manifest id')
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
    assert(profiles.has('code-reviewer'), 'AgentRuntime should load manifest profiles')
    await runtime.reloadProfiles()
  })
}

async function testExtensionExamplesLoad(): Promise<void> {
  const examplesDir = join(process.cwd(), 'examples')

  const profiles = await loadAgentProfilesFromDir(join(examplesDir, 'profiles'))
  const codeReviewer = profiles.find((profile) => profile.manifest.id === 'code-reviewer')
  assert(codeReviewer, 'example code-reviewer profile should load')
  assertEqual(codeReviewer.profile.baseProfileId, 'coding', 'example profile base')

  const toolPacks = await loadToolPacksFromDir(join(examplesDir, 'tool-packs'))
  const repoInspector = toolPacks.find((pack) => pack.manifest.id === 'repo-inspector')
  assert(repoInspector, 'example repo-inspector tool pack should load')

  const registry = createDefaultToolRegistry(toolPacks.map((pack) => pack.toolPack))
  assert(registry.specsByName.has('repo_context'), 'example repo_context tool should register')
  const result = await executeTool(
    'repo_context',
    { focus: 'runtime sdk examples' },
    { settings: { apiKeys: {}, defaultModel: null }, profileId: 'coding' },
    registry,
  )
  const parsed = JSON.parse(result) as { focus?: string; message?: string }
  assertEqual(parsed.focus, 'runtime sdk examples', 'example tool should receive args')
  assert(
    typeof parsed.message === 'string' && parsed.message.includes('manifest'),
    'example tool should return contextual JSON',
  )
}

async function testExtensionReportContract(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    await mkdir(join(dataDir, 'profiles'), { recursive: true })
    await mkdir(join(dataDir, 'tool-packs'), { recursive: true })
    await cp(
      'examples/profiles/code-reviewer.json',
      join(dataDir, 'profiles', 'code-reviewer.json'),
    )
    await cp('examples/tool-packs/repo-inspector', join(dataDir, 'tool-packs', 'repo-inspector'), {
      recursive: true,
    })

    const report = await getExtensionReport()
    assertEqual(report.ok, true, 'extension report should be ok')
    assertEqual(report.dataDir, dataDir, 'extension report data dir')
    assertEqual(report.profiles[0]?.id, 'code-reviewer', 'extension report profile id')
    assertEqual(report.toolPacks[0]?.id, 'repo-inspector', 'extension report tool pack id')
    assert(
      report.toolPacks[0]?.tools.includes('repo_context'),
      'extension report should include tool names',
    )
    assertEqual(report.errors.length, 0, 'extension report should not include errors')
  })
}

async function main(): Promise<void> {
  await testRuntimeEventContract()
  await testRuntimeEmitsVersionedEvents()
  await testRuntimeRetriesDanglingUserTurn()
  await testPersistenceContract()
  await testLegacyPersistenceNormalization()
  await testToolRegistryContract()
  await testRuntimeCoreHasNoDocToolContract()
  await testRuntimeSdkDoesNotExportDocsContract()
  await testToolPackManifestLoader()
  await testToolPackReloadsChangedEntry()
  await testProfileManifestLoader()
  await testExtensionExamplesLoad()
  await testExtensionReportContract()
  console.log('runtime contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
