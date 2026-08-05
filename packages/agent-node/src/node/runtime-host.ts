import {
  createInMemoryRuntimeStore,
  type DurableRunExecutor,
  type ModelSelection,
  type WorkbenchHost,
  type WorkbenchOptions,
  WorkbenchRuntime,
  type WorkbenchStore,
} from '@aila/agent'
import {
  createNodeContextTokenCounter,
  createNodeSemanticCompactGenerator,
  type NodeContextServiceOptions,
} from './context-services'
import {
  createDurableRunExecutor,
  createModelInfoResolver,
  type DurableRunExecutorOptions,
} from './durable-run'
import { createFileRuntimeStore } from './file-store'
import { nodeFileSystem, nodeWorkspaceRoots } from './filesystem'
import { createNodeImageGenerator } from './image-generation'
import { createNodeImageStore } from './image-store'
import {
  type CreateModelRegistryInput,
  createModelRegistry,
  type ModelRegistry,
} from './model-registry'
import { nodePath } from './path'
import { defaultAilaDataDir, loadNodeSettings, type NodeSettingsOptions } from './settings'
import { runNodeShell } from './shell'

export interface CreateDefaultNodeRuntimeHostInput
  extends DurableRunExecutorOptions,
    NodeSettingsOptions,
    Pick<NodeContextServiceOptions, 'fetch'> {
  cwd?: string
  modelRegistry?: ModelRegistry
  modelRegistryOptions?: CreateModelRegistryInput
  enableShell?: boolean
  enableFileSystem?: boolean
  enableImages?: boolean
  runAgent?: DurableRunExecutor
  host?: WorkbenchHost
}

export interface CreateNodeWorkbenchInput extends CreateDefaultNodeRuntimeHostInput {
  options?: Omit<WorkbenchOptions, 'host' | 'store'>
  model?: ModelSelection
  store?: WorkbenchStore
  enableFileStore?: boolean
}

export function createDefaultNodeRuntimeHost(
  input: CreateDefaultNodeRuntimeHostInput = {},
): WorkbenchHost {
  const dataDir = input.dataDir ?? defaultAilaDataDir()
  const cwd = input.cwd ?? process.cwd()
  const loadSettings = input.loadSettings ?? (() => input.settings ?? loadNodeSettings(input))
  const initialSettings = input.settings ?? loadSettings()
  const modelRegistry =
    input.modelRegistry ??
    createModelRegistry(
      input.modelRegistryOptions ?? {
        providers: input.providers,
        connections: initialSettings.connections,
      },
    )
  const imageStore =
    input.enableImages === false
      ? null
      : createNodeImageStore({ dataDir, imageDir: input.imageDir })
  const runAgent =
    input.host?.runAgent ??
    input.runAgent ??
    createDurableRunExecutor({
      ...input,
      modelRegistry,
      imageDir: imageStore?.imageDir,
      loadSettings,
    })
  const contextServiceOptions: NodeContextServiceOptions = {
    ...input,
    modelRegistry,
    loadSettings,
  }

  return {
    loadSettings,
    getModelInfo: createModelInfoResolver(modelRegistry),
    countContextTokens: createNodeContextTokenCounter(contextServiceOptions),
    generateContextCompactArtifact: createNodeSemanticCompactGenerator(contextServiceOptions),
    path: nodePath,
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
          generateImage: createNodeImageGenerator({ ...input, modelRegistry }),
          cleanupConversationAssets: imageStore.cleanupConversationImages,
        }
      : {}),
    ...input.host,
    runAgent,
  }
}

export function createNodeWorkbench(input: CreateNodeWorkbenchInput = {}): WorkbenchRuntime {
  const dataDir = input.dataDir ?? defaultAilaDataDir()
  const store =
    input.store ??
    (input.enableFileStore === false
      ? createInMemoryRuntimeStore()
      : createFileRuntimeStore({ dataDir }))
  return new WorkbenchRuntime({
    ...(input.options ?? {}),
    store,
    host: createDefaultNodeRuntimeHost({ ...input, dataDir }),
  })
}
