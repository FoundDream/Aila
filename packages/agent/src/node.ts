export {
  configuredProviders,
  ENV_KEY_BY_PROVIDER,
  MissingApiKeyError,
  type NodeAuthInput,
  requireApiKey,
  resolveApiKey,
  resolveConfiguredValue,
} from './node/auth'
export {
  createFileRuntimeStore,
  type FileRuntimeStoreOptions,
} from './node/file-store'
export {
  nodeFileSystem,
  nodeWorkspaceRoots,
} from './node/filesystem'
export { createNodeImageGenerator } from './node/image-generation'
export {
  AILA_IMAGE_HOST,
  AILA_IMAGE_PROTOCOL,
  createNodeImageStore,
  getNodeImagesDir,
  imageNameFromUrl,
  isAllowedImageName,
  mimeForImageName,
} from './node/image-store'
export {
  type CreateModelRegistryInput,
  createModelRegistry,
  ModelRegistry,
  type NodeProviderConfig,
} from './node/model-registry'
export {
  createProtocolRegistry,
  type ProtocolAdapter,
  type ProtocolAdapterInput,
  ProtocolRegistry,
  registerBuiltInProtocolAdapters,
} from './node/protocols'
export {
  type CreateDefaultNodeRuntimeHostInput,
  type CreateNodeAgentRuntimeInput,
  createDefaultNodeRuntimeHost,
  createNodeAgentRuntime,
} from './node/runtime-host'
export {
  defaultAilaDataDir,
  emptySettings,
  getNodeSettingsPath,
  loadNodeSettings,
  type NodeSettingsOptions,
  saveNodeSettings,
} from './node/settings'
export { runNodeShell } from './node/shell'
export {
  createModelInfoResolver,
  createProviderStreamChat,
  type ProviderStreamChatOptions,
} from './node/stream-chat'
export {
  type CreateWebSearchRegistryInput,
  createDefaultWebSearch,
  createWebSearchRegistry,
  registerBuiltInWebSearchProviders,
  type WebSearchProvider,
  type WebSearchProviderConfig,
  type WebSearchProviderId,
  WebSearchRegistry,
} from './node/web-search'
