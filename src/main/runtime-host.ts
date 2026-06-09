import {
  AgentRuntime,
  type ChatMessage,
  type AgentRuntimeHost,
  type AgentRuntimeOptions,
  type AgentRuntimeStore,
  createToolPolicy,
  type RuntimeAttachmentBlock,
  type RuntimePersistAttachmentInput,
} from '@aila/agent'
import { createDefaultNodeRuntimeHost } from '@aila/agent/node'
import { saveImage } from './image-store'
import { getDataDir, getImagesDir } from './paths'
import { createPersistedRuntimeStore } from './runtime-store'
import { loadSettings } from './settings'
import { loadSkillsFromDir } from './skill-loader'
import { loadToolPacksFromDir } from './tool-pack-loader'
import { webSearch } from './web-search'

export interface CreatePersistedAgentRuntimeInput {
  host?: AgentRuntimeHost
  options?: Omit<AgentRuntimeOptions, 'host' | 'store'>
  store?: AgentRuntimeStore
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

function buildDateContext(): ChatMessage[] {
  return [{ role: 'system', content: `Current date: ${formatLocalDate()}` }]
}

export function createDefaultRuntimeHost(overrides: AgentRuntimeHost = {}): AgentRuntimeHost {
  const overrideTransientContext = overrides.loadTransientContext
  const hostOverrides = { ...overrides }
  delete hostOverrides.loadTransientContext

  return {
    ...createDefaultNodeRuntimeHost({
      dataDir: getDataDir(),
      imageDir: getImagesDir(),
      loadSettings,
      enableFileStore: false,
    }),
    loadSettings,
    onToolPolicy: (request) => createToolPolicy(loadSettings().approvalMode)(request),
    loadToolPacks: async () => (await loadToolPacksFromDir()).map((pack) => pack.toolPack),
    loadSkills: async () => (await loadSkillsFromDir()).skills,
    persistAttachment: persistRuntimeAttachment,
    webSearch,
    saveImage,
    ...hostOverrides,
    loadTransientContext: async (input) => {
      const provided = await overrideTransientContext?.(input)
      return [...buildDateContext(), ...(provided ?? [])]
    },
  }
}

export function createPersistedAgentRuntime(
  input: CreatePersistedAgentRuntimeInput = {},
): AgentRuntime {
  return new AgentRuntime({
    ...(input.options ?? {}),
    store: input.store ?? createPersistedRuntimeStore(),
    host: createDefaultRuntimeHost(input.host),
  })
}
