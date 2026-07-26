import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = process.cwd()

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(path)))
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) files.push(path)
  }
  return files
}

function importSpecifiers(source: string): string[] {
  return Array.from(
    source.matchAll(
      /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g,
    ),
    (match) => match[1] ?? match[2],
  )
}

async function assertImports(
  directory: string,
  validate: (specifier: string, file: string) => string | null,
): Promise<void> {
  for (const file of await filesUnder(directory)) {
    const source = await readFile(file, 'utf-8')
    for (const specifier of importSpecifiers(source)) {
      const error = validate(specifier, file)
      if (error) throw new Error(`${relative(root, file)}: ${error}`)
    }
  }
}

async function packageJson(path: string): Promise<{
  dependencies?: Record<string, string>
}> {
  return JSON.parse(await readFile(path, 'utf-8'))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  assert(
    (await stat(join(root, 'apps/desktop'))).isDirectory(),
    'Desktop must live in apps/desktop',
  )
  assert((await stat(join(root, 'apps/cli'))).isDirectory(), 'CLI must live in apps/cli')
  assert((await stat(join(root, 'apps/tui'))).isDirectory(), 'TUI must live in apps/tui')

  await assertImports(join(root, 'packages/agent/src'), (specifier) => {
    if (specifier.startsWith('node:')) return `core cannot import Node builtin "${specifier}"`
    if (specifier === 'electron' || specifier.startsWith('electron/')) {
      return `core cannot import Electron module "${specifier}"`
    }
    if (specifier.startsWith('@aila/agent-node')) {
      return `core cannot depend on Node adapter "${specifier}"`
    }
    if (specifier.includes('/apps/')) return `package cannot import app source "${specifier}"`
    return null
  })

  await assertImports(join(root, 'packages/agent-node/src'), (specifier) => {
    if (specifier.includes('/apps/')) return `package cannot import app source "${specifier}"`
    if (/packages\/[^/]+\/src/.test(specifier)) {
      return `package cannot bypass workspace exports with "${specifier}"`
    }
    return null
  })

  await assertImports(join(root, 'apps/desktop/src/renderer'), (specifier) => {
    if (specifier.startsWith('@aila/agent-node')) {
      return `renderer cannot import Node adapter "${specifier}"`
    }
    return null
  })

  for (const app of ['desktop', 'cli', 'tui']) {
    await assertImports(join(root, `apps/${app}/src`), (specifier) => {
      if (specifier.includes('/apps/')) return `app cannot import another app source "${specifier}"`
      if (/packages\/[^/]+\/src/.test(specifier)) {
        return `app cannot bypass workspace exports with "${specifier}"`
      }
      return null
    })
  }

  const agent = await packageJson(join(root, 'packages/agent/package.json'))
  const agentNode = await packageJson(join(root, 'packages/agent-node/package.json'))
  assert(!agent.dependencies?.['@aila/agent-node'], '@aila/agent cannot depend on @aila/agent-node')
  assert(
    agentNode.dependencies?.['@aila/agent'] === 'workspace:*',
    '@aila/agent-node must declare @aila/agent as a workspace dependency',
  )
  assert(
    !Object.keys(agent.dependencies ?? {}).some((name) => name.includes('pi-ai')),
    '@aila/agent must implement its own model boundary rather than depend on pi-ai',
  )
  assert(
    !Object.keys(agentNode.dependencies ?? {}).some((name) => name.includes('pi-ai')),
    '@aila/agent-node must implement its own providers rather than depend on pi-ai',
  )

  assert(
    !(await exists(join(root, 'packages/agent-node/src/node/stream-chat.ts'))),
    'legacy stream-chat implementation must stay deleted',
  )

  const agentKernel = await readFile(join(root, 'packages/agent/src/agent/agent.ts'), 'utf-8')
  for (const forbidden of [
    'conversation-core',
    'run-persistence',
    'runtime',
    'plan-core',
    '@aila/agent-node',
  ]) {
    assert(
      !agentKernel.includes(forbidden),
      `minimal Agent kernel cannot depend on durable/product layer "${forbidden}"`,
    )
  }
  assert(
    agentKernel.includes("from '../run-machine'") && agentKernel.includes('runDurableRun'),
    'minimal Agent and durable Workbench execution must share the pure Run Machine',
  )
  const durableExecutor = await readFile(
    join(root, 'packages/agent-node/src/node/durable-run.ts'),
    'utf-8',
  )
  assert(
    durableExecutor.includes("from '@aila/agent/internal'") &&
      durableExecutor.includes('runDurableRun'),
    'durable executor must schedule work through the shared Run Machine',
  )

  const publicCore = await readFile(join(root, 'packages/agent/src/core.ts'), 'utf-8')
  for (const legacy of [
    'AgentRuntimeHost',
    'AgentRuntimeStore',
    'AgentRuntimeEvent',
    'RuntimeStreamChat',
    'createProviderStreamChat',
    'type RunState',
    'type RunTransition',
    'runDurableRun,',
  ]) {
    assert(
      !publicCore.includes(legacy),
      `root Agent API must not expose legacy concept "${legacy}"`,
    )
  }

  for (const app of ['desktop', 'cli', 'tui']) {
    const manifest = await packageJson(join(root, `apps/${app}/package.json`))
    assert(
      manifest.dependencies?.['@aila/agent'] === 'workspace:*',
      `apps/${app} must depend on @aila/agent`,
    )
    assert(
      manifest.dependencies?.['@aila/agent-node'] === 'workspace:*',
      `apps/${app} must depend on @aila/agent-node`,
    )
  }

  console.log('package boundaries contract: ok')
}

await main()
