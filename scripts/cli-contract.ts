import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  appendMessage,
  configureDataDir,
  createConversation,
  getConversation,
} from '../src/runtime'

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
    await mkdir(join(dataDir, 'profiles'), { recursive: true })
    await writeFile(join(dataDir, 'profiles', 'bad.json'), '{"schemaVersion":999}\n', 'utf-8')

    const result = await runCli(['--data-dir', dataDir, '--extensions', '--json'])
    assertEqual(result.code, 1, 'bad extension report should fail')
    const parsed = JSON.parse(result.stdout) as {
      ok?: boolean
      errors?: Array<{ kind?: string; message?: string }>
    }
    assertEqual(parsed.ok, false, 'bad extension JSON report ok=false')
    assertEqual(parsed.errors?.[0]?.kind, 'profiles', 'bad extension error kind')
    assert(
      parsed.errors?.[0]?.message?.includes('unsupported profile manifest schemaVersion'),
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

async function main(): Promise<void> {
  await testExtensionReportFailure()
  await testRetryLastDoesNotDuplicateUser()
  console.log('cli contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
