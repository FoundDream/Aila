import {
  AgentRuntime,
  type AgentRuntimeHost,
  type AgentRuntimeOptions,
  type AgentRuntimeStore,
} from './runtime'
import { createPersistedRuntimeStore } from './runtime-store'
import { loadSettings } from './settings'
import { loadSkillsFromDir } from './skills'
import { loadToolPacksFromDir } from './tool-pack-loader'

export interface CreatePersistedAgentRuntimeInput {
  host?: AgentRuntimeHost
  options?: Omit<AgentRuntimeOptions, 'host' | 'store'>
  store?: AgentRuntimeStore
}

export function createDefaultRuntimeHost(overrides: AgentRuntimeHost = {}): AgentRuntimeHost {
  return {
    loadSettings,
    loadToolPacks: async () => (await loadToolPacksFromDir()).map((pack) => pack.toolPack),
    loadSkills: async () => (await loadSkillsFromDir()).skills,
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
