import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  appendMessage,
  configureDataDir,
  createConversation,
  createDoc,
  getConversation,
  getDoc,
  updateDoc,
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
    const child = spawn('bun', ['src/tui/index.ts', ...args], {
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

async function seedExampleExtensions(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, 'profiles'), { recursive: true })
  await mkdir(join(dataDir, 'tool-packs'), { recursive: true })
  await cp('examples/profiles/code-reviewer.json', join(dataDir, 'profiles', 'code-reviewer.json'))
  await cp('examples/tool-packs/repo-inspector', join(dataDir, 'tool-packs', 'repo-inspector'), {
    recursive: true,
  })
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
    await seedExampleExtensions(dataDir)

    const stdin = [
      '/extensions',
      '/profile',
      '/profile code-reviewer',
      '/model openai:gpt-5.4',
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
    assert(result.stdout.includes('code-reviewer'), 'TUI should list manifest profile')
    assert(result.stdout.includes('repo-inspector'), 'TUI should list manifest tool pack')
    assert(result.stdout.includes('repo_context'), 'TUI should list manifest tool')
    assert(result.stdout.includes('[profile] code-reviewer'), 'TUI should switch active profile')
    assert(result.stdout.includes('[model] OpenAI / GPT-5.4'), 'TUI should switch active model')
    assert(result.stdout.includes('[extensions] reloaded'), 'TUI should reload extension caches')
  })
}

async function testDocSlashCommands(): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const created = await createDoc()
    const doc = await updateDoc(created.path, {
      title: 'TUI Contract Doc',
      content: 'intro\nold doc text\noutro',
    })

    const stdin = ['/doc', '/doc-edit old doc text => new doc text', '/exit', ''].join('\n')
    const result = await runTui(
      [
        '--data-dir',
        dataDir,
        '--doc',
        doc.path,
        '--model',
        'openrouter:minimax/minimax-m3',
        '--no-history',
      ],
      stdin,
    )

    assertEqual(result.code, 0, 'TUI doc slash commands should exit cleanly')
    assert(result.stdout.includes(`[doc] ${doc.path}`), 'TUI should display bound doc read')
    assert(result.stdout.includes('old doc text'), 'TUI doc read should show original content')
    assert(result.stdout.includes(`[doc-edit] ${doc.path}`), 'TUI should display doc edit')
    assert(result.stdout.includes('new doc text'), 'TUI doc edit should show diff')
    assertEqual(
      (await getDoc(doc.path)).content,
      'intro\nnew doc text\noutro',
      'TUI doc edit should update bound markdown document',
    )

    const conversationId = extractConversationId(result.stdout)
    const record = await getConversation(conversationId)
    const localContexts = record.messages.filter(
      (message) =>
        message.role === 'user' &&
        message.blocks.some(
          (block) => block.type === 'text' && block.content.startsWith('[local command]'),
        ),
    )
    assertEqual(localContexts.length, 2, 'TUI doc commands should persist local context messages')
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

async function main(): Promise<void> {
  await testLocalSlashCommands()
  await testExtensionAndSessionSlashCommands()
  await testDocSlashCommands()
  await testRetryLastDoesNotDuplicateUser()
  console.log('tui contract: ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
