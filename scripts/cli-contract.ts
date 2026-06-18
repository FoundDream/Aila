import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AILA_AGENT_EVENT_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  createRuntimeEvent,
} from '@aila/agent'
import { handleRuntimeEvent } from '../src/cli/index'
import { configureDataDir } from '../src/main/agent-host'
import { appendMessage, createConversation, getConversation } from '../src/main/conversations'

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
    const child = spawn('bun', ['src/cli/index.ts', ...args], {
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

async function testExtensionReportFailure(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    await mkdir(join(dataDir, 'tool-packs', 'bad'), { recursive: true })
    await writeFile(
      join(dataDir, 'tool-packs', 'bad', 'aila-tool-pack.json'),
      '{"schemaVersion":999}\n',
      'utf-8',
    )

    const result = await runCli(['--data-dir', dataDir, '--extensions', '--json'])
    assertEqual(result.code, 1, 'bad extension report should fail')
    const parsed = JSON.parse(result.stdout) as {
      ok?: boolean
      errors?: Array<{ kind?: string; message?: string }>
    }
    assertEqual(parsed.ok, false, 'bad extension JSON report ok=false')
    assertEqual(parsed.errors?.[0]?.kind, 'toolPacks', 'bad extension error kind')
    assert(
      parsed.errors?.[0]?.message?.includes('unsupported tool pack manifest schemaVersion'),
      'bad extension error should include loader message',
    )
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

async function testPlanListRequiresConversationScope(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const result = await runCli(['--data-dir', dataDir, '--list-plans'])
    assertEqual(result.code, 1, 'plan list without a conversation scope should fail')
    assert(
      result.stderr.includes('plan management options require --conversation or --resume'),
      'plan list should require an explicit conversation scope',
    )
  })
}

async function testPlanListForConversation(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const conversation = await createConversation()
    const result = await runCli([
      '--data-dir',
      dataDir,
      '--conversation',
      conversation.id,
      '--list-plans',
    ])
    assertEqual(result.code, 0, 'plan list for a conversation should exit cleanly')
    assert(result.stdout.includes('Aila plans'), 'plan list should print a plan header')
    assert(
      result.stdout.includes(`Conversation: ${conversation.id}`),
      'plan list should print scope',
    )
    assert(result.stdout.includes('No plans found.'), 'empty plan list should be explicit')
  })
}

function testInterruptedAgentEventCompletesCliAdapter(): void {
  const completionRef: {
    current: {
      assistantText: string
      error: string | null
      status: 'done' | 'error'
    } | null
  } = { current: null }

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
  const source = await readFile(join(process.cwd(), 'src/cli/index.ts'), 'utf-8')
  assert(
    source.includes("from '@aila/agent'") && source.includes("from '../main/agent-host'"),
    'CLI adapter should import agent core from @aila/agent and host adapters from main',
  )
  assert(!source.includes("from '../runtime"), 'CLI adapter should not import local runtime paths')
  assert(
    !source.includes("from '../runtime/internal'"),
    'CLI adapter should not import runtime implementation internals',
  )
  assert(
    source.includes('createPersistedAgentRuntime'),
    'CLI adapter should use the shared persisted runtime factory',
  )
  assert(
    source.includes('type AgentRuntimeApi') && !source.includes('type AgentRuntime,'),
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
      source.includes('--plan <id>') &&
      source.includes('--list-plans') &&
      source.includes('--approve-plan <id>') &&
      source.includes('--cancel-plan <id>') &&
      source.includes('runtime.listPlans(conversationId)') &&
      source.includes('runtime.revisePlan({') &&
      source.includes('runtime.approvePlan({') &&
      source.includes('runtime.cancelPlan({'),
    'CLI adapter should expose Plan mode and use the shared runtime Plan API',
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
  await testExtensionReportFailure()
  await testRetryLastDoesNotDuplicateUser()
  await testPlanListRequiresConversationScope()
  await testPlanListForConversation()
  testInterruptedAgentEventCompletesCliAdapter()
  await testCliUsesSharedRuntimeFactory()
  console.log('cli contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
