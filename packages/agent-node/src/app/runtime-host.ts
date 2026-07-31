import {
  type ChatMessage,
  createToolPolicy,
  promptNeedsWidget,
  type RuntimeAttachmentBlock,
  type RuntimePersistAttachmentInput,
  type RuntimeStableInstructionsInput,
  WIDGET_SYSTEM_PROMPT,
  type WorkbenchHost,
  type WorkbenchOptions,
  WorkbenchRuntime,
  type WorkbenchStore,
} from '@aila/agent'
import { createDefaultNodeRuntimeHost } from '../node/runtime-host'
import { saveImage } from './image-store'
import { loadMcpTools } from './mcp-tools'
import { getDataDir, getImagesDir } from './paths'
import { getPersistedRuntimeStore } from './runtime-store'
import { loadSettings } from './settings'
import { loadSkillsFromDir } from './skill-loader'
import { webSearch } from './web-search'
import { WIDGET_TOOL } from './widget-tool'

export interface CreatePersistedWorkbenchInput {
  host?: WorkbenchHost
  options?: Omit<WorkbenchOptions, 'host' | 'store'>
  store?: WorkbenchStore
}

async function persistRuntimeAttachment(
  input: RuntimePersistAttachmentInput,
): Promise<RuntimeAttachmentBlock> {
  if (input.kind === 'image') {
    const bytes = Buffer.from(input.data, 'base64')
    const { url } = await saveImage(bytes, input.name)
    return { type: 'image', url, mime: input.mime }
  }
  return { type: 'file', name: input.name, content: input.data }
}

function formatLocalDate(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const AILA_SYSTEM_PROMPT = [
  'You are Aila, a local-first agent runtime and workbench for software projects and personal workflows.',
  '',
  'Working style:',
  "- Be direct, practical, and concise. Answer in the user's language unless they ask otherwise.",
  '- Prefer doing the requested work end to end when the intent is clear. Ask a question only when a missing detail blocks safe progress.',
  '- Before editing files, inspect the relevant content first. Preserve existing style and avoid unrelated rewrites.',
  '- Make the smallest useful change. Do not modify files outside the requested scope unless it is necessary and explain why.',
  '- Use `edit` for targeted replacements and `write` for new files or intentional full-file rewrites.',
  '- Use `bash` for inspection, builds, tests, and verification when useful. Keep commands focused and explain failures plainly.',
  '- Respect tool denials, approval decisions, workspace roots, and sensitive-file protections. Do not try to work around safety boundaries.',
  '- Use `web_search` for fresh or time-sensitive facts. Otherwise prefer local context and project files.',
  '- If a matching skill is available, load it before doing specialized work.',
  '- When finished, summarize what changed and mention any verification that was run or could not be run.',
].join('\n')

function buildStableInstructions(): ChatMessage[] {
  return [{ role: 'system', content: AILA_SYSTEM_PROMPT }]
}

/**
 * Inject the widget capability prompt only when the conversation actually needs
 * generative UI — keyword in the latest user turn, or a widget already present.
 * Saves prompt tokens on non-visual conversations.
 */
function buildWidgetInstructions(input: RuntimeStableInstructionsInput): ChatMessage[] {
  let lastUserText = ''
  let conversationHasWidget = false
  for (const msg of input.record.messages) {
    for (const block of msg.blocks) {
      if (block.type !== 'text') continue
      if (msg.role === 'user') lastUserText = block.content
      else if (block.content.includes('show-widget')) conversationHasWidget = true
    }
  }
  return promptNeedsWidget(lastUserText, conversationHasWidget)
    ? [{ role: 'system', content: WIDGET_SYSTEM_PROMPT }]
    : []
}

function buildDateContext(): ChatMessage[] {
  return [{ role: 'system', content: `Current date: ${formatLocalDate()}` }]
}

function resolveToolCwd(input: Parameters<NonNullable<WorkbenchHost['loadTools']>>[0]) {
  const path = input?.record?.meta.workspace?.path
  return path?.trim() ? path : undefined
}

export function createDefaultRuntimeHost(overrides: WorkbenchHost = {}): WorkbenchHost {
  const overrideStableInstructions = overrides.loadStableInstructions
  const overrideTransientContext = overrides.loadTransientContext
  const hostOverrides = { ...overrides }
  delete hostOverrides.loadStableInstructions
  delete hostOverrides.loadTransientContext

  return {
    ...createDefaultNodeRuntimeHost({
      dataDir: getDataDir(),
      imageDir: getImagesDir(),
      loadSettings,
    }),
    loadSettings,
    onToolPolicy: (request) => createToolPolicy(loadSettings().approvalMode)(request),
    loadTools: async (input) => {
      const cwd = resolveToolCwd(input)
      const mcpTools = await loadMcpTools({ cwd })
      return [WIDGET_TOOL, ...mcpTools]
    },
    loadSkills: async () => (await loadSkillsFromDir()).skills,
    persistAttachment: persistRuntimeAttachment,
    webSearch,
    saveImage,
    ...hostOverrides,
    loadStableInstructions: async (input) => {
      const provided = await overrideStableInstructions?.(input)
      return [...buildStableInstructions(), ...buildWidgetInstructions(input), ...(provided ?? [])]
    },
    loadTransientContext: async (input) => {
      const provided = await overrideTransientContext?.(input)
      return [...buildDateContext(), ...(provided ?? [])]
    },
  }
}

export function createPersistedWorkbench(
  input: CreatePersistedWorkbenchInput = {},
): WorkbenchRuntime {
  return new WorkbenchRuntime({
    ...(input.options ?? {}),
    store: input.store ?? getPersistedRuntimeStore(),
    host: createDefaultRuntimeHost(input.host),
  })
}
