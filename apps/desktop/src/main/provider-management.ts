import {
  type ConnectionModel,
  type ConnectionModelDiscoveryResult,
  type ConnectionProfile,
  type ConnectionTestResult,
  MODEL_CATALOG,
  type ProviderConnectionSnapshot,
  type ProviderDefinition,
  type ProviderId,
  type ResolvedProviderCredential,
  type Settings,
} from '@aila/agent'
import {
  type CredentialResolver,
  configuredProviders,
  createConnectionService,
  createCredentialResolver,
  createModelRegistry,
  createProviderRegistry,
  loadSettings,
  type ModelRegistry,
  saveSettings,
} from '@aila/agent-node/app'
import { importExistingProviderAccount } from './provider-account-import'
import type { ProviderCredentialStore } from './provider-credential-store'

export interface SaveProviderConnectionInput {
  profile: ConnectionProfile
  credential?: string
  clearCredential?: boolean
}

export interface ProviderConnectionEffectRequest {
  profile: ConnectionProfile
  credential?: string
  modelId?: string
}

export interface ProviderModelDiscoveryResponse {
  result: ConnectionModelDiscoveryResult
  settings: Settings
  connections: ProviderConnectionSnapshot[]
  configuredProviders: ProviderId[]
}

export interface ProviderAccountImportResponse extends ProviderManagementState {
  source: string
  discoveredModels: number
}

export interface ProviderManagementState {
  settings: Settings
  connections: ProviderConnectionSnapshot[]
  configuredProviders: ProviderId[]
}

export interface ProviderManagement {
  modelRegistry: ModelRegistry
  credentialResolver: CredentialResolver
  migrateLegacySecrets(): ProviderManagementState
  state(settings?: Settings): ProviderManagementState
  updateSettings(settings: Settings): ProviderManagementState
  save(input: SaveProviderConnectionInput): ProviderManagementState
  remove(connectionId: ProviderId): ProviderManagementState
  importAccount(
    connectionId: ProviderId,
    providerType: string,
  ): Promise<ProviderAccountImportResponse>
  test(input: ProviderConnectionEffectRequest): Promise<ConnectionTestResult>
  discover(input: ProviderConnectionEffectRequest): Promise<ProviderModelDiscoveryResponse>
}

export function createProviderManagement(store: ProviderCredentialStore): ProviderManagement {
  const providerRegistry = createProviderRegistry()
  const modelRegistry = createModelRegistry({
    providerRegistry,
    connections: loadSettings().connections,
  })
  const fallbackCredentialResolver = createCredentialResolver({ modelRegistry })
  const credentialResolver: CredentialResolver = {
    async resolve(input): Promise<ResolvedProviderCredential> {
      const connectionId = input.descriptor.connectionId ?? input.descriptor.provider
      const config = modelRegistry.getProviderConfig(connectionId)
      const reference = config?.credentialRef ?? connectionId
      const secure = store.getSecret(reference)
      if (secure) {
        const definition = modelRegistry.getProviderDefinition(
          connectionId,
          input.descriptor.providerType,
        )
        return { value: secure, kind: definition.authKind }
      }
      return fallbackCredentialResolver.resolve(input)
    },
  }
  const connectionService = createConnectionService({
    modelRegistry,
    credentialResolver,
    loadSettings,
  })

  function state(settings = loadSettings()): ProviderManagementState {
    for (const connection of settings.connections ?? [])
      modelRegistry.registerConnection(connection)
    const snapshots = connectionSnapshots(settings, providerRegistry.list(), store)
    return {
      settings: rendererSafeSettings(settings),
      connections: snapshots,
      configuredProviders: snapshots
        .filter((snapshot) => snapshot.configured && snapshot.profile.enabled !== false)
        .map((snapshot) => snapshot.profile.id),
    }
  }

  return {
    modelRegistry,
    credentialResolver,

    migrateLegacySecrets() {
      const settings = loadSettings()
      if (!store.isAvailable()) return state(settings)
      const legacy = Object.entries(settings.apiKeys ?? {}).filter(
        (entry): entry is [string, string] => Boolean(entry[1]?.trim()),
      )
      if (legacy.length === 0) return state(settings)

      const connections = [...(settings.connections ?? [])]
      const apiKeys = { ...(settings.apiKeys ?? {}) }
      for (const [providerId, credential] of legacy) {
        const existing = connections.find((connection) => connection.id === providerId)
        const reference = existing?.credentialRef ?? providerId
        if (!store.hasSecret(reference)) store.setSecret(reference, credential)
        if (!existing) connections.push(defaultProfile(providerRegistry.resolve(providerId)))
        delete apiKeys[providerId]
      }
      return state(saveSettings({ ...settings, apiKeys, connections }))
    },

    state,

    updateSettings(settings) {
      const current = loadSettings()
      return state(
        saveSettings({
          ...settings,
          // API keys are main-process-only legacy state. Provider operations
          // migrate or remove them without ever round-tripping through IPC.
          apiKeys: current.apiKeys ?? {},
        }),
      )
    },

    save(input) {
      const current = loadSettings()
      const previous = current.connections?.find((connection) => connection.id === input.profile.id)
      const profile = normalizeProfile(input.profile, previous)
      const reference = profile.credentialRef ?? profile.id
      if (input.clearCredential) store.deleteSecret(reference)
      else if (input.credential?.trim()) store.setSecret(reference, input.credential)

      modelRegistry.registerConnection(profile)
      const next = saveSettings({
        ...current,
        apiKeys: withoutKey(current.apiKeys, profile.id),
        connections: [
          ...(current.connections ?? []).filter((connection) => connection.id !== profile.id),
          profile,
        ],
      })
      return state(next)
    },

    remove(connectionId) {
      const current = loadSettings()
      const connection = current.connections?.find((candidate) => candidate.id === connectionId)
      store.deleteSecret(connection?.credentialRef ?? connectionId)
      const next = saveSettings({
        ...current,
        apiKeys: withoutKey(current.apiKeys, connectionId),
        connections: (current.connections ?? []).filter(
          (candidate) => candidate.id !== connectionId,
        ),
        ...(current.defaultModel?.providerId === connectionId ? { defaultModel: null } : {}),
        ...(current.defaultVisionModel?.providerId === connectionId
          ? { defaultVisionModel: null }
          : {}),
        ...(current.defaultImageModel?.providerId === connectionId
          ? { defaultImageModel: null }
          : {}),
      })
      return state(next)
    },

    async importAccount(connectionId, providerType) {
      const imported = await importExistingProviderAccount(providerType)
      const current = loadSettings()
      const definition = providerRegistry.resolve(providerType)
      const previous = current.connections?.find((connection) => connection.id === connectionId)
      const profile = normalizeProfile(
        previous ?? {
          ...defaultProfile(definition),
          id: connectionId,
          credentialRef: connectionId,
        },
        previous,
      )
      modelRegistry.registerConnection(profile)
      const result = await connectionService.discoverModels({
        profile,
        credential: imported.credential,
      })
      if (result.source !== 'fetched' || result.models.length === 0) {
        throw new Error(
          `The ${imported.source} credential was found, but the account returned no usable models.`,
        )
      }
      const liveIds = result.models.map((model) => model.id)
      const defaultModel = liveIds.includes(profile.defaultModel ?? '')
        ? profile.defaultModel
        : liveIds[0]
      const updated: ConnectionProfile = {
        ...profile,
        models: result.models,
        modelSource: result.source,
        modelsFetchedAt: result.fetchedAt,
        ...(defaultModel ? { defaultModel } : {}),
        enabledModelIds: defaultModel ? [defaultModel] : [],
        lastTestStatus: 'verified',
        lastTestAt: Date.now(),
        lastTestMessage: `Imported and verified from ${imported.source}`,
      }
      store.setSecret(updated.credentialRef ?? updated.id, imported.credential)
      modelRegistry.registerConnection(updated)
      saveSettings({
        ...current,
        apiKeys: withoutKey(current.apiKeys, connectionId),
        connections: [
          ...(current.connections ?? []).filter((connection) => connection.id !== connectionId),
          updated,
        ],
      })
      return { ...state(), source: imported.source, discoveredModels: result.models.length }
    },

    async test(input) {
      const result = await connectionService.testConnection({
        profile: input.profile,
        ...(input.credential !== undefined ? { credential: input.credential } : {}),
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      })
      const current = loadSettings()
      const existing = current.connections?.find((connection) => connection.id === input.profile.id)
      if (existing) {
        const updated: ConnectionProfile = {
          ...existing,
          lastTestStatus: result.ok
            ? 'verified'
            : result.errorClass === 'auth'
              ? 'needs_reauth'
              : 'error',
          lastTestAt: Date.now(),
          lastTestMessage: result.ok
            ? `Connected in ${result.latencyMs} ms`
            : (result.errorMessage ?? 'Connection failed'),
        }
        saveSettings({
          ...current,
          connections: (current.connections ?? []).map((connection) =>
            connection.id === updated.id ? updated : connection,
          ),
        })
      }
      return result
    },

    async discover(input) {
      const result = await connectionService.discoverModels({
        profile: input.profile,
        ...(input.credential !== undefined ? { credential: input.credential } : {}),
      })
      const current = loadSettings()
      const previous = current.connections?.find((connection) => connection.id === input.profile.id)
      const base = normalizeProfile(input.profile, previous)
      const liveIds = new Set(result.models.map((model) => model.id))
      const previousEnabled = base.enabledModelIds ?? []
      const enabledModelIds = previousEnabled.filter((id) => liveIds.has(id))
      const defaultModel = liveIds.has(base.defaultModel ?? '')
        ? base.defaultModel
        : (enabledModelIds[0] ?? result.models[0]?.id)
      const profile: ConnectionProfile = {
        ...base,
        models: result.models,
        modelSource: result.source,
        modelsFetchedAt: result.fetchedAt,
        ...(defaultModel ? { defaultModel } : {}),
        enabledModelIds:
          enabledModelIds.length > 0 ? enabledModelIds : defaultModel ? [defaultModel] : [],
      }
      modelRegistry.registerConnection(profile)
      const settings = saveSettings({
        ...current,
        connections: [
          ...(current.connections ?? []).filter((connection) => connection.id !== profile.id),
          profile,
        ],
      })
      return { result, ...state(settings) }
    },
  }
}

function connectionSnapshots(
  settings: Settings,
  definitions: ProviderDefinition[],
  store: ProviderCredentialStore,
): ProviderConnectionSnapshot[] {
  const persistedIds = new Set((settings.connections ?? []).map((connection) => connection.id))
  const profiles = new Map<ProviderId, ConnectionProfile>()
  for (const definition of definitions) profiles.set(definition.id, defaultProfile(definition))
  for (const profile of settings.connections ?? []) {
    const definition = definitions.find((candidate) => candidate.id === profile.providerType)
    profiles.set(
      profile.id,
      normalizeProfile(profile, definition ? defaultProfile(definition) : undefined),
    )
  }
  const envConfigured = new Set(configuredProviders(settings))
  return Array.from(profiles.values(), (profile) => {
    const definition =
      definitions.find((candidate) => candidate.id === profile.providerType) ??
      createProviderRegistry().resolve(profile.providerType)
    const reference = profile.credentialRef ?? profile.id
    const credentialStatus =
      definition.authKind === 'none'
        ? ('not-required' as const)
        : store.hasSecret(reference)
          ? ('secure' as const)
          : settings.apiKeys?.[profile.id]?.trim()
            ? ('settings' as const)
            : envConfigured.has(profile.id) || envConfigured.has(profile.providerType)
              ? ('environment' as const)
              : ('missing' as const)
    return {
      profile,
      definition,
      credentialStatus,
      configured: credentialStatus !== 'missing',
      persisted: persistedIds.has(profile.id),
    }
  })
}

function defaultProfile(definition: ProviderDefinition): ConnectionProfile {
  const models = catalogModels(definition.id, definition.fallbackModels)
  const defaultModel = models[0]?.id
  return {
    id: definition.id,
    providerType: definition.id,
    label: definition.label,
    enabled: true,
    ...(definition.defaultBaseUrl ? { baseUrl: definition.defaultBaseUrl } : {}),
    credentialRef: definition.id,
    ...(defaultModel ? { defaultModel, enabledModelIds: models.map((model) => model.id) } : {}),
    models,
    modelSource: 'fallback',
  }
}

function catalogModels(
  providerId: ProviderId,
  fallbackModels: ConnectionModel[] = [],
): ConnectionModel[] {
  const catalog = MODEL_CATALOG.filter((model) => model.providerId === providerId).map((model) => ({
    id: model.modelId,
    displayName: model.displayName,
    ...(model.api ? { api: model.api } : {}),
    contextLength: model.contextLength,
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model.capabilities ? { capabilities: model.capabilities } : {}),
  }))
  return catalog.length > 0 ? catalog : structuredClone(fallbackModels)
}

function normalizeProfile(
  input: ConnectionProfile,
  previous?: ConnectionProfile,
): ConnectionProfile {
  const id = input.id.trim()
  const providerType = input.providerType.trim()
  if (!id || id.length > 64 || !/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    throw new Error('Connection id must use letters, numbers, and hyphens')
  }
  if (!providerType) throw new Error('Provider type is required')
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const models = normalizeModels(input.models ?? previous?.models ?? [])
  const enabledModelIds = uniqueStrings(input.enabledModelIds ?? previous?.enabledModelIds ?? [])
  const defaultModel = input.defaultModel?.trim() || previous?.defaultModel?.trim()
  if (defaultModel && !enabledModelIds.includes(defaultModel)) enabledModelIds.unshift(defaultModel)
  const headers = normalizeHeaders(input.headers)
  return {
    ...previous,
    ...input,
    id,
    providerType,
    label: input.label?.trim() || previous?.label?.trim() || id,
    enabled: input.enabled !== false,
    ...(baseUrl ? { baseUrl } : {}),
    ...(headers ? { headers } : {}),
    credentialRef: input.credentialRef?.trim() || previous?.credentialRef?.trim() || id,
    ...(defaultModel ? { defaultModel } : {}),
    enabledModelIds,
    models,
  }
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (trimmed.length > 2_048) throw new Error('Connection URL is too long')
  const url = new URL(trimmed)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Connection URL must use http or https')
  }
  return trimmed.replace(/\/+$/, '')
}

function normalizeHeaders(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined
  const headers: Record<string, string> = {}
  for (const [key, headerValue] of Object.entries(value)) {
    const normalizedKey = key.trim()
    const normalizedValue = headerValue.trim()
    if (!normalizedKey || !normalizedValue) continue
    if (/authorization|api[-_]key|token|secret|cookie/i.test(normalizedKey)) {
      throw new Error(`Sensitive header "${normalizedKey}" must use the credential field`)
    }
    headers[normalizedKey] = normalizedValue
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function normalizeModels(models: ConnectionModel[]): ConnectionModel[] {
  const result = new Map<string, ConnectionModel>()
  for (const model of models) {
    const id = model.id.trim()
    if (!id || id.length > 256 || hasControlCharacter(id) || result.has(id)) continue
    result.set(id, { ...model, id })
    if (result.size >= 1_000) break
  }
  return Array.from(result.values())
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

function withoutKey(apiKeys: Settings['apiKeys'], providerId: ProviderId): Settings['apiKeys'] {
  const next = { ...(apiKeys ?? {}) }
  delete next[providerId]
  return next
}

function rendererSafeSettings(settings: Settings): Settings {
  return { ...settings, apiKeys: {} }
}
