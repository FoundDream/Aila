import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  AILA_RUN_EVENT_SCHEMA_VERSION,
  createWorkbenchEvent,
} from '@aila/agent'
import {
  appendMessage,
  configureDataDir,
  createConversation,
  getConversation,
} from '@aila/agent-node/app'
import { handleRuntimeEvent } from '../apps/cli/src/index'

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
  const dir = await mkdtemp(join(tmpdir(), 'aila-cli-contract-'))
  try {
    configureDataDir(dir)
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['apps/cli/src/index.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
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
  })
}

async function testLegacyToolPackDirectoryIsIgnored(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const legacyToolPackDir = join(dataDir, 'tool-packs', 'legacy')
    await mkdir(legacyToolPackDir, { recursive: true })
    await writeFile(
      join(legacyToolPackDir, 'aila-tool-pack.json'),
      '{"schemaVersion":1,"id":"legacy","name":"Legacy","entry":"index.mjs"}\n',
      'utf-8',
    )
    await writeFile(
      join(legacyToolPackDir, 'index.mjs'),
      "throw new Error('legacy tool pack must not be loaded')\n",
      'utf-8',
    )

    const result = await runCli(['--data-dir', dataDir, '--extensions', '--json'])
    assertEqual(result.code, 0, 'legacy tool pack directory should be ignored')
    const parsed = JSON.parse(result.stdout) as {
      ok?: boolean
      toolPacks?: unknown
      toolPacksDir?: unknown
      errors?: Array<{ kind?: string; message?: string }>
    }
    assertEqual(parsed.ok, true, 'extension JSON report should remain healthy')
    assert(!('toolPacks' in parsed), 'extension JSON must not expose local tool packs')
    assert(!('toolPacksDir' in parsed), 'extension JSON must not expose a tool packs directory')
    assertEqual(parsed.errors?.length, 0, 'legacy tool packs must not create extension errors')
  })
}

async function testRetryLastDoesNotDuplicateUser(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const conversation = await createConversation()
    await appendMessage(conversation.id, {
      schemaVersion: AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: 'dangling-user',
      role: 'user',
      blocks: [{ type: 'text', content: 'retry from cli contract' }],
      status: 'done',
    })

    const result = await runCli(
      [
        '--data-dir',
        dataDir,
        '--conversation',
        conversation.id,
        '--retry-last',
        '--json',
        '--model',
        'openrouter:minimax/minimax-m3',
      ],
      { OPENROUTER_API_KEY: '' },
    )
    assertEqual(result.code, 1, 'retry without API key should return model error exit code')
    const parsed = JSON.parse(result.stdout) as { status?: string; error?: string }
    assertEqual(parsed.status, 'error', 'retry JSON status')
    assert(
      parsed.error?.includes('No API key for openrouter'),
      'retry JSON should include missing key error',
    )

    const record = await getConversation(conversation.id)
    assertEqual(
      record.messages.filter((message) => message.role === 'user').length,
      1,
      'retry must not duplicate user messages',
    )
    assertEqual(
      record.messages.filter((message) => message.role === 'assistant').length,
      1,
      'retry should append one assistant message',
    )
  })
}

function testInterruptedRunEventCompletesCliAdapter(): void {
  const completionRef: {
    current: {
      assistantText: string
      error: string | null
      status: 'done' | 'error'
    } | null
  } = { current: null }

  handleRuntimeEvent(
    createWorkbenchEvent('run:event', {
      schemaVersion: AILA_RUN_EVENT_SCHEMA_VERSION,
      timestamp: 1,
      conversationId: 'conversation-interrupted',
      messageId: 'assistant-interrupted',
      type: 'turn.interrupted',
      data: { reason: 'user cleanup timed out' },
    }),
    {
      assistantText: 'partial output',
      events: false,
      json: true,
      toolNames: new Map(),
      onAssistantText() {},
      onCompletion(state) {
        completionRef.current = state
      },
    },
  )

  const completed = completionRef.current
  assert(completed, 'CLI interrupted event should complete the adapter')
  assertEqual(completed.status, 'error', 'CLI interrupted completion status')
  assertEqual(completed.error, 'user cleanup timed out', 'CLI interrupted completion error')
  assertEqual(completed.assistantText, 'partial output', 'CLI interrupted partial text')
}

async function testCliUsesSharedRuntimeFactory(): Promise<void> {
  const source = await readFile(join(process.cwd(), 'apps/cli/src/index.ts'), 'utf-8')
  assert(
    source.includes("from '@aila/agent'") && source.includes("from '@aila/agent-node/app'"),
    'CLI adapter should import agent core and Node host through workspace packages',
  )
  assert(!source.includes("from '../runtime"), 'CLI adapter should not import local runtime paths')
  assert(
    !source.includes("from '../runtime/internal'"),
    'CLI adapter should not import runtime implementation internals',
  )
  assert(
    source.includes('createPersistedWorkbench'),
    'CLI adapter should use the shared persisted runtime factory',
  )
  assert(
    source.includes('type Workbench') && !source.includes('type WorkbenchRuntime,'),
    'CLI adapter should depend on the host-facing runtime API type, not the concrete runtime class',
  )
  assert(
    source.includes('requestToolApprovalWithActivity'),
    'CLI adapter should record approval activity through the shared helper',
  )
  assert(
    source.includes('createToolPolicy') &&
      source.includes('--approval-mode <mode>') &&
      source.includes('--yolo, --yes'),
    'CLI adapter should expose safe/yolo tool execution modes through the shared policy helper',
  )
  assert(
    source.includes('isAilaExecutionMode') &&
      source.includes('--mode <mode>') &&
      source.includes('Runtime mode: agent or chat'),
    'CLI adapter should expose the shared runtime execution modes',
  )
  assert(
    !source.includes('createPersistedRuntimeStore'),
    'CLI adapter should not wire the persisted store directly',
  )
  assert(
    !source.includes('loadToolPacksFromDir'),
    'CLI adapter should not wire tool-pack loaders directly',
  )
}

async function main(): Promise<void> {
  await testLegacyToolPackDirectoryIsIgnored()
  await testRetryLastDoesNotDuplicateUser()
  testInterruptedRunEventCompletesCliAdapter()
  await testCliUsesSharedRuntimeFactory()
  console.log('cli contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
