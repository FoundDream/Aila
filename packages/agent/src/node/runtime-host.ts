import {
  AgentRuntime,
  type AgentRuntimeHost,
  type AgentRuntimeOptions,
  type AgentRuntimeStore,
  createInMemoryRuntimeStore,
  type ModelSelection,
  type RuntimeStreamChat,
} from '../core'
import {
  createNodeContextTokenCounter,
  createNodeSemanticCompactGenerator,
  type NodeContextServiceOptions,
} from './context-services'
import { createFileRuntimeStore } from './file-store'
import { nodeFileSystem, nodeWorkspaceRoots } from './filesystem'
import { createNodeImageGenerator } from './image-generation'
import { createNodeImageStore } from './image-store'
import {
  type CreateModelRegistryInput,
  createModelRegistry,
  type ModelRegistry,
} from './model-registry'
import { defaultAilaDataDir, loadNodeSettings, type NodeSettingsOptions } from './settings'
import { runNodeShell } from './shell'
import {
  createModelInfoResolver,
  createProviderStreamChat,
  type ProviderStreamChatOptions,
} from './stream-chat'

export interface CreateDefaultNodeRuntimeHostInput
  extends ProviderStreamChatOptions,
    NodeSettingsOptions,
    Pick<NodeContextServiceOptions, 'fetch'> {
  cwd?: string
  modelRegistry?: ModelRegistry
  modelRegistryOptions?: CreateModelRegistryInput
  store?: AgentRuntimeStore
  enableFileStore?: boolean
  enableShell?: boolean
  enableFileSystem?: boolean
  enableImages?: boolean
  streamChat?: RuntimeStreamChat
  host?: AgentRuntimeHost
}

export interface CreateNodeAgentRuntimeInput extends CreateDefaultNodeRuntimeHostInput {
  options?: Omit<AgentRuntimeOptions, 'host' | 'store'>
  model?: ModelSelection
}

export function createDefaultNodeRuntimeHost(
  input: CreateDefaultNodeRuntimeHostInput = {},
): AgentRuntimeHost {
  const dataDir = input.dataDir ?? defaultAilaDataDir()
  const cwd = input.cwd ?? process.cwd()
  const modelRegistry =
    input.modelRegistry ??
    createModelRegistry(input.modelRegistryOptions ?? { providers: input.providers })
  const imageStore =
    input.enableImages === false
      ? null
      : createNodeImageStore({ dataDir, imageDir: input.imageDir })
  const streamChat =
    input.streamChat ??
    createProviderStreamChat({
      ...input,
      modelRegistry,
      imageDir: imageStore?.imageDir,
      loadSettings: () => input.settings ?? loadNodeSettings(input),
    })
  const contextServiceOptions: NodeContextServiceOptions = {
    ...input,
    modelRegistry,
    loadSettings: () => input.settings ?? loadNodeSettings(input),
  }

  return {
    loadSettings: () => input.settings ?? loadNodeSettings(input),
    getModelInfo: createModelInfoResolver(modelRegistry),
    countContextTokens: createNodeContextTokenCounter(contextServiceOptions),
    generateContextCompactArtifact: createNodeSemanticCompactGenerator(contextServiceOptions),
    streamChat,
    ...(input.enableFileSystem === false
      ? {}
      : {
          fileSystem: nodeFileSystem,
          workspaceRoots: () => nodeWorkspaceRoots(cwd),
        }),
    ...(input.enableShell === false ? {} : { runShell: runNodeShell, shellCwd: cwd }),
    ...(imageStore
      ? {
          saveImage: imageStore.saveImage,
          generateImage: createNodeImageGenerator(input),
          cleanupConversationAssets: imageStore.cleanupConversationImages,
        }
      : {}),
    ...input.host,
  }
}

export function createNodeAgentRuntime(input: CreateNodeAgentRuntimeInput = {}): AgentRuntime {
  const dataDir = input.dataDir ?? defaultAilaDataDir()
  const store =
    input.store ??
    (input.enableFileStore === false
      ? createInMemoryRuntimeStore()
      : createFileRuntimeStore({ dataDir }))
  return new AgentRuntime({
    ...(input.options ?? {}),
    store,
    host: createDefaultNodeRuntimeHost({ ...input, dataDir, store }),
  })
}
