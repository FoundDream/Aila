import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AILA_AGENT_EVENT_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  createRuntimeEvent,
} from '@aila/agent'
import {
  appendMessage,
  configureDataDir,
  createConversation,
  getConversation,
} from '@aila/agent-node/app'
import { handleRuntimeEvent } from '../apps/tui/src/line-mode'

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

async function withTempDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'aila-tui-contract-data-'))
  try {
    configureDataDir(dir)
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function withTempWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-aila-tui-contract-'))
  try {
    await mkdir(dir, { recursive: true })
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function runTui(
  args: string[],
  stdin: string,
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['apps/tui/src/index.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
    child.stdin.end(stdin)
  })
}

function extractConversationId(stdout: string): string {
  const match = stdout.match(/^Conversation:\s+([0-9a-f-]+)/m)
  if (!match?.[1]) throw new Error(`conversation id not found in TUI output:\n${stdout}`)
  return match[1]
}

async function testLocalSlashCommands(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    await withTempWorkspace(async (workspaceDir) => {
      const readPath = join(workspaceDir, 'read-target.txt')
      const writePath = join(workspaceDir, 'write-target.txt')
      await writeFile(readPath, 'tui-read-content', 'utf-8')

      const stdin = [
        `/read ${readPath}`,
        '/run printf tui-contract-run',
        'y',
        `/write ${writePath} tui-write`,
        'y',
        `/edit ${writePath} tui-write => tui-edit`,
        'y',
        '/exit',
        '',
      ].join('\n')
      const result = await runTui(
        ['--data-dir', dataDir, '--model', 'openrouter:minimax/minimax-m3', '--no-history'],
        stdin,
      )

      assertEqual(result.code, 0, 'TUI local slash commands should exit cleanly')
      assert(result.stdout.includes('[read]'), 'TUI should display read result')
      assert(result.stdout.includes('tui-read-content'), 'TUI read should show file content')
      assert(result.stdout.includes('[run] printf tui-contract-run'), 'TUI should display run')
      assert(result.stdout.includes('tui-contract-run'), 'TUI run should show stdout')
      assert(result.stdout.includes('[write]'), 'TUI should display write result')
      assert(result.stdout.includes('[edit]'), 'TUI should display edit result')
      assertEqual(await readFile(writePath, 'utf-8'), 'tui-edit', 'TUI edit should update file')

      const conversationId = extractConversationId(result.stdout)
      const record = await getConversation(conversationId)
      const localContexts = record.messages.filter(
        (message) =>
          message.role === 'user' &&
          message.blocks.some(
            (block) => block.type === 'text' && block.content.startsWith('[local command]'),
          ),
      )
      assertEqual(localContexts.length, 4, 'TUI should persist local command context messages')
    })
  })
}

async function testExtensionAndSessionSlashCommands(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const stdin = [
      '/extensions',
      '/model openai:gpt-5.4',
      '/mode',
      '/plan',
      '/mode agent',
      '/plans',
      '/extensions reload',
      '/exit',
      '',
    ].join('\n')
    const result = await runTui(
      ['--data-dir', dataDir, '--model', 'openrouter:minimax/minimax-m3', '--no-history'],
      stdin,
    )

    assertEqual(result.code, 0, 'TUI extension slash commands should exit cleanly')
    assert(result.stdout.includes('Aila extensions'), 'TUI should display extension report')
    assert(result.stdout.includes('[model] OpenAI / GPT-5.4'), 'TUI should switch active model')
    assert(result.stdout.includes('[mode] agent'), 'TUI should display active runtime mode')
    assert(result.stdout.includes('[mode] plan'), 'TUI /plan should switch to plan mode')
    assert(result.stdout.includes('Aila plans'), 'TUI should list plans for the conversation')
    assert(result.stdout.includes('[extensions] reloaded'), 'TUI should reload extension caches')
  })
}

async function testDocCommandsAreNotRuntimeAdapterFeatures(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const result = await runTui(
      ['--data-dir', dataDir, '--model', 'openrouter:minimax/minimax-m3', '--no-history'],
      ['/doc', '/doc-edit old doc text => new doc text', '/exit', ''].join('\n'),
    )

    assertEqual(result.code, 0, 'TUI removed doc slash commands should exit cleanly')
    assert(result.stdout.includes('Unknown command: /doc'), 'TUI should reject /doc')
    assert(result.stdout.includes('Unknown command: /doc-edit'), 'TUI should reject /doc-edit')

    const conversationId = extractConversationId(result.stdout)
    const record = await getConversation(conversationId)
    const localContexts = record.messages.filter(
      (message) =>
        message.role === 'user' &&
        message.blocks.some(
          (block) => block.type === 'text' && block.content.startsWith('[local command]'),
        ),
    )
    assertEqual(
      localContexts.length,
      0,
      'removed doc commands should not persist local context messages',
    )
  })
}

async function testDocFlagIsRemoved(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const result = await runTui(
      ['--data-dir', dataDir, '--doc', 'Old Doc', '--model', 'openrouter:minimax/minimax-m3'],
      '',
    )

    assertEqual(result.code, 1, 'TUI --doc should be rejected')
    assert(result.stdout.includes('unknown option: --doc'), 'TUI should report removed --doc flag')
  })
}

async function testRetryLastDoesNotDuplicateUser(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const conversation = await createConversation()
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'dangling-user',
      role: 'user',
      blocks: [{ type: 'text', content: 'retry from tui contract' }],
      status: 'done',
    })

    const result = await runTui(
      [
        '--data-dir',
        dataDir,
        '--conversation',
        conversation.id,
        '--retry-last',
        '--model',
        'openrouter:minimax/minimax-m3',
      ],
      '/exit\n',
      { OPENROUTER_API_KEY: '' },
    )
    assertEqual(result.code, 0, 'TUI retry should return to prompt after model error')
    assert(
      result.stdout.includes('No API key for openrouter'),
      'TUI retry should display missing key error',
    )

    const record = await getConversation(conversation.id)
    assertEqual(
      record.messages.filter((message) => message.role === 'user').length,
      1,
      'TUI retry must not duplicate user messages',
    )
    assertEqual(
      record.messages.filter((message) => message.role === 'assistant').length,
      1,
      'TUI retry should append one assistant message',
    )
  })
}

function testInterruptedAgentEventCompletesLineModeAdapter(): void {
  let completed = false
  handleRuntimeEvent(
    createRuntimeEvent('agent:event', {
      schemaVersion: AILA_AGENT_EVENT_SCHEMA_VERSION,
      timestamp: 1,
      conversationId: 'conversation-interrupted',
      messageId: 'assistant-interrupted',
      type: 'turn.interrupted',
      data: { reason: 'user cleanup timed out' },
    }),
    {
      completions: new Map([
        [
          'assistant-interrupted',
          () => {
            completed = true
          },
        ],
      ]),
      toolNames: new Map(),
      onAssistantTextStart() {},
    },
  )

  assert(completed, 'TUI line-mode interrupted event should complete the adapter')
}

async function testTuiUsesSharedRuntimeFactory(): Promise<void> {
  const source = await readFile(join(process.cwd(), 'apps/tui/src/line-mode.ts'), 'utf-8')
  const fullscreenSource = await readFile(
    join(process.cwd(), 'apps/tui/src/fullscreen.ts'),
    'utf-8',
  )
  assert(
    source.includes("from '@aila/agent'") &&
      source.includes("from '@aila/agent-node/app'") &&
      fullscreenSource.includes("from '@aila/agent-node/app'"),
    'TUI adapters should import agent core and Node host through workspace packages',
  )
  assert(
    !source.includes("from '../runtime") && !fullscreenSource.includes("from '../runtime"),
    'TUI adapters should not import local runtime paths',
  )
  assert(
    !source.includes("from '../runtime/internal'") &&
      !fullscreenSource.includes("from '../runtime/internal'"),
    'TUI adapters should not import runtime implementation internals',
  )
  assert(
    source.includes('createPersistedAgentRuntime'),
    'TUI adapter should use the shared persisted runtime factory',
  )
  assert(
    source.includes('type AgentRuntimeApi') &&
      fullscreenSource.includes('type AgentRuntimeApi') &&
      !source.includes('type AgentRuntime,') &&
      !fullscreenSource.includes('type AgentRuntime,'),
    'TUI adapters should depend on the host-facing runtime API type, not the concrete runtime class',
  )
  assert(
    source.includes('requestToolApprovalWithActivity'),
    'TUI adapter should record approval activity through the shared helper',
  )
  assert(
    source.includes('createToolPolicy') &&
      source.includes('--approval-mode <mode>') &&
      source.includes('--yolo'),
    'TUI adapter should expose safe/yolo tool execution modes through the shared policy helper',
  )
  assert(
    source.includes('isAilaExecutionMode') &&
      source.includes('--mode <mode>') &&
      source.includes('--plan <id>') &&
      source.includes('/approve-plan [id]') &&
      source.includes('runtime.revisePlan({') &&
      source.includes('runtime.approvePlan({') &&
      source.includes('runtime.cancelPlan({') &&
      fullscreenSource.includes('runtime.revisePlan({') &&
      fullscreenSource.includes('runtime.approvePlan({') &&
      fullscreenSource.includes('runtime.cancelPlan({'),
    'TUI adapters should expose Plan mode and use the shared runtime Plan API',
  )
  assert(
    !source.includes('createPersistedRuntimeStore'),
    'TUI adapter should not wire the persisted store directly',
  )
  assert(
    !source.includes('loadToolPacksFromDir'),
    'TUI adapter should not wire tool-pack loaders directly',
  )
}

async function main(): Promise<void> {
  await testLocalSlashCommands()
  await testExtensionAndSessionSlashCommands()
  await testDocCommandsAreNotRuntimeAdapterFeatures()
  await testDocFlagIsRemoved()
  await testRetryLastDoesNotDuplicateUser()
  testInterruptedAgentEventCompletesLineModeAdapter()
  await testTuiUsesSharedRuntimeFactory()
  console.log('tui contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
