import {
  AgentRuntime,
  type AgentRuntimeHost,
  type AgentRuntimeOptions,
  type AgentRuntimeStore,
  createToolPolicy,
  type RuntimeAttachmentBlock,
  type RuntimePersistAttachmentInput,
} from '@aila/agent'
import { getModelInfo, streamChat } from './agent'
import { fileSystem, workspaceRoots } from './filesystem'
import { generateImage } from './image'
import { saveImage } from './image-store'
import { createPersistedRuntimeStore } from './runtime-store'
import { loadSettings } from './settings'
import { runShell } from './shell'
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

export function createDefaultRuntimeHost(overrides: AgentRuntimeHost = {}): AgentRuntimeHost {
  return {
    loadSettings,
    onToolPolicy: (request) => createToolPolicy(loadSettings().approvalMode)(request),
    loadToolPacks: async () => (await loadToolPacksFromDir()).map((pack) => pack.toolPack),
    loadSkills: async () => (await loadSkillsFromDir()).skills,
    persistAttachment: persistRuntimeAttachment,
    fileSystem,
    workspaceRoots,
    webSearch,
    generateImage,
    saveImage,
    runShell,
    getModelInfo: (selection) => getModelInfo(selection.providerId, selection.modelId),
    streamChat,
    ...overrides,
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
