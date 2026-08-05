import {
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  TestTubeIcon,
  Trash2Icon,
} from 'lucide-react'
import { type ReactElement, useEffect, useMemo, useState } from 'react'
import type {
  ConnectionModel,
  ConnectionProfile,
  ProviderConnectionSnapshot,
  ProviderId,
  SettingsState,
} from '../types'
import { ProviderLogo } from './ProviderLogo'

interface Props {
  connections: ProviderConnectionSnapshot[]
  onStateChange: (state: SettingsState) => void
}

type BusyAction = 'save' | 'test' | 'discover' | 'import' | 'remove' | 'credential-remove' | null

const CUSTOM_PROVIDER_TYPE = 'openai-compatible'

export function ProviderConnectionsPanel({ connections, onStateChange }: Props): ReactElement {
  const [selectedId, setSelectedId] = useState<ProviderId>(
    connections[0]?.profile.id ?? 'anthropic',
  )
  const [adding, setAdding] = useState(false)
  const selected = connections.find((connection) => connection.profile.id === selectedId)

  useEffect(() => {
    if (!selected && connections[0]) setSelectedId(connections[0].profile.id)
  }, [connections, selected])

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-52 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-soft)]/60">
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {connections.map((connection) => (
            <button
              key={connection.profile.id}
              type="button"
              onClick={() => {
                setAdding(false)
                setSelectedId(connection.profile.id)
              }}
              className={`mb-1 flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors last:mb-0 ${
                !adding && selectedId === connection.profile.id
                  ? 'bg-[var(--surface)] shadow-[var(--shadow-xs)]'
                  : 'hover:bg-[var(--surface-hover)]'
              }`}
            >
              <ProviderLogo id={connection.profile.providerType} size={15} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-[var(--text)]">
                  {connection.profile.label ?? connection.definition.label}
                </span>
                <span className="block truncate text-[10px] text-[var(--text-dim)]">
                  {connection.profile.id === connection.profile.providerType
                    ? connection.definition.category === 'account'
                      ? 'Account'
                      : connection.definition.category === 'coding-plan'
                        ? 'Coding plan'
                        : 'API'
                    : connection.profile.id}
                </span>
              </span>
              <span
                title={connectionStatusLabel(connection)}
                className={`size-1.5 shrink-0 rounded-full ${connectionStatusDot(connection)}`}
              />
            </button>
          ))}
        </div>
        <div className="border-t border-[var(--border)] p-2">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[11px] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <PlusIcon className="size-3.5" />
            Add connection
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {adding ? (
          <ConnectionEditor
            key="new-connection"
            connections={connections}
            onStateChange={onStateChange}
            onSaved={(id) => {
              setSelectedId(id)
              setAdding(false)
            }}
            onCancel={() => setAdding(false)}
          />
        ) : selected ? (
          <ConnectionEditor
            key={selected.profile.id}
            connection={selected}
            connections={connections}
            onStateChange={onStateChange}
            onSaved={setSelectedId}
          />
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-[var(--text-dim)]">
            Select a connection.
          </div>
        )}
      </div>
    </div>
  )
}

function ConnectionEditor({
  connection,
  connections,
  onStateChange,
  onSaved,
  onCancel,
}: {
  connection?: ProviderConnectionSnapshot
  connections: ProviderConnectionSnapshot[]
  onStateChange: (state: SettingsState) => void
  onSaved: (id: ProviderId) => void
  onCancel?: () => void
}): ReactElement {
  const templates = useMemo(
    () =>
      connections.filter((candidate) => candidate.profile.id === candidate.profile.providerType),
    [connections],
  )
  const initialTemplate = connection ?? templates[0]
  const [profile, setProfile] = useState<ConnectionProfile>(() =>
    connection
      ? structuredClone(connection.profile)
      : newProfile(
          initialTemplate,
          connections.map((candidate) => candidate.profile.id),
        ),
  )
  const [credential, setCredential] = useState('')
  const [credentialImported, setCredentialImported] = useState(false)
  const [revealCredential, setRevealCredential] = useState(false)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(
    null,
  )
  const [manualModelId, setManualModelId] = useState('')
  const definition =
    connection?.profile.providerType === profile.providerType
      ? connection.definition
      : templates.find((candidate) => candidate.profile.providerType === profile.providerType)
          ?.definition
  const modelChoices = profile.models ?? []
  const enabledModelIds = new Set(profile.enabledModelIds ?? [])
  const hasUsableCredential =
    Boolean(credential.trim()) ||
    credentialImported ||
    connection?.credentialStatus === 'secure' ||
    connection?.credentialStatus === 'environment' ||
    connection?.credentialStatus === 'settings' ||
    definition?.authKind === 'none'
  const isNew = !connection?.persisted
  const canDiscover = definition?.modelDiscovery?.kind === 'protocol' || !definition

  const chooseTemplate = (providerType: string): void => {
    const template = templates.find((candidate) => candidate.profile.providerType === providerType)
    const currentIds = connections.map((candidate) => candidate.profile.id)
    setProfile(newProfile(template, currentIds, providerType))
    setCredential('')
    setNotice(null)
  }

  const save = async (discoverAfterSave: boolean): Promise<void> => {
    if (busy) return
    setBusy('save')
    setNotice(null)
    try {
      const saved = await window.api.providers.save({
        profile,
        ...(credential.trim() ? { credential: credential.trim() } : {}),
      })
      onStateChange(saved)
      onSaved(profile.id)
      setCredential('')
      let message = 'Connection saved. Credential is encrypted by the operating system.'
      const savedConnection = saved.connections.find(
        (candidate) => candidate.profile.id === profile.id,
      )
      if (discoverAfterSave && canDiscover && savedConnection?.configured) {
        setBusy('discover')
        try {
          const discovered = await window.api.providers.discover({
            profile: savedConnection.profile,
          })
          onStateChange(discovered)
          setProfile(
            structuredClone(
              discovered.connections.find((candidate) => candidate.profile.id === profile.id)
                ?.profile ?? savedConnection.profile,
            ),
          )
          message = `Connection saved. Found ${discovered.result.models.length} models.`
        } catch (error) {
          setNotice({
            tone: 'error',
            text: `Connection saved, but model discovery failed: ${errorMessage(error)}`,
          })
          return
        }
      }
      setNotice({ tone: 'success', text: message })
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const test = async (): Promise<void> => {
    if (busy) return
    setBusy('test')
    setNotice(null)
    try {
      const result = await window.api.providers.test({
        profile,
        ...(credential.trim() ? { credential: credential.trim() } : {}),
      })
      onStateChange(await window.api.settings.get())
      setNotice({
        tone: result.ok ? 'success' : 'error',
        text: result.ok
          ? `Connected to ${result.modelTested ?? 'the provider'} in ${result.latencyMs} ms.`
          : (result.errorMessage ?? 'Connection failed.'),
      })
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const discover = async (): Promise<void> => {
    if (busy) return
    setBusy('discover')
    setNotice(null)
    try {
      const response = await window.api.providers.discover({
        profile,
        ...(credential.trim() ? { credential: credential.trim() } : {}),
      })
      onStateChange(response)
      const updated = response.connections.find((candidate) => candidate.profile.id === profile.id)
      if (updated) setProfile(structuredClone(updated.profile))
      setNotice({
        tone: 'success',
        text: `Found ${response.result.models.length} models from this account.`,
      })
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (busy || !connection) return
    const label = profile.label ?? profile.id
    if (!window.confirm(`Remove "${label}" and its stored credential from Aila?`)) return
    setBusy('remove')
    try {
      const state = await window.api.providers.remove(profile.id)
      onStateChange(state)
      onSaved(state.connections[0]?.profile.id ?? 'anthropic')
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const removeCredential = async (): Promise<void> => {
    if (busy) return
    setBusy('credential-remove')
    try {
      const state = await window.api.providers.save({ profile, clearCredential: true })
      onStateChange(state)
      setCredential('')
      setCredentialImported(false)
      setNotice({ tone: 'info', text: 'Stored credential removed.' })
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const importAccount = async (): Promise<void> => {
    if (busy) return
    setBusy('import')
    setNotice(null)
    try {
      const response = await window.api.providers.importAccount(profile.id, profile.providerType)
      onStateChange(response)
      const updated = response.connections.find((candidate) => candidate.profile.id === profile.id)
      if (updated) setProfile(structuredClone(updated.profile))
      setCredential('')
      setCredentialImported(true)
      onSaved(profile.id)
      setNotice({
        tone: 'success',
        text: `Imported ${response.source} login${
          response.discoveredModels > 0 ? ` and found ${response.discoveredModels} models` : ''
        }.`,
      })
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const toggleModel = (modelId: string): void => {
    setProfile((current) => {
      const enabled = new Set(current.enabledModelIds ?? [])
      if (enabled.has(modelId)) enabled.delete(modelId)
      else enabled.add(modelId)
      const nextEnabled = Array.from(enabled)
      const defaultModel = enabled.has(current.defaultModel ?? '')
        ? current.defaultModel
        : nextEnabled[0]
      return {
        ...current,
        enabledModelIds: nextEnabled,
        ...(defaultModel ? { defaultModel } : { defaultModel: undefined }),
      }
    })
  }

  const addManualModel = (): void => {
    const id = manualModelId.trim()
    if (!id) return
    setProfile((current) => {
      if (current.models?.some((model) => model.id === id)) return current
      return {
        ...current,
        models: [...(current.models ?? []), { id }],
        enabledModelIds: [...(current.enabledModelIds ?? []), id],
        defaultModel: current.defaultModel || id,
      }
    })
    setManualModelId('')
  }

  return (
    <div className="mx-auto max-w-[620px]">
      <div className="mb-4 flex items-start gap-2.5">
        <ProviderLogo id={profile.providerType} size={22} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold text-[var(--text)]">
              {connection ? profile.label || definition?.label : 'Add connection'}
            </h3>
            {connection && <ConnectionStatusBadge connection={connection} />}
          </div>
          <p className="mt-0.5 text-[11px] text-[var(--text-dim)]">
            {definition?.description ?? 'OpenAI-compatible custom endpoint.'}
          </p>
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className={`mb-4 rounded-md border px-2.5 py-2 text-[11px] ${noticeClass(notice.tone)}`}
        >
          {notice.text}
        </div>
      )}

      <div className="space-y-5">
        {!connection && (
          <section>
            <FieldLabel>Provider</FieldLabel>
            <select
              value={profile.providerType}
              onChange={(event) => chooseTemplate(event.target.value)}
              disabled={Boolean(busy)}
              className={inputClassName}
            >
              {templates.map((template) => (
                <option key={template.profile.providerType} value={template.profile.providerType}>
                  {template.definition.label}
                </option>
              ))}
              <option value={CUSTOM_PROVIDER_TYPE}>OpenAI-compatible endpoint</option>
            </select>
          </section>
        )}

        <section className="grid grid-cols-2 gap-3">
          <label>
            <FieldLabel>Name</FieldLabel>
            <input
              value={profile.label ?? ''}
              onChange={(event) =>
                setProfile((current) => ({ ...current, label: event.target.value }))
              }
              disabled={Boolean(busy)}
              className={inputClassName}
            />
          </label>
          <label>
            <FieldLabel>Connection ID</FieldLabel>
            <input
              value={profile.id}
              onChange={(event) =>
                setProfile((current) => ({
                  ...current,
                  id: slugify(event.target.value),
                  credentialRef: slugify(event.target.value),
                }))
              }
              disabled={Boolean(connection) || Boolean(busy)}
              className={inputClassName}
            />
          </label>
        </section>

        <section>
          <div className="mb-1 flex items-center justify-between">
            <FieldLabel>{definition?.credentialLabel ?? 'API key'}</FieldLabel>
            {connection?.credentialStatus === 'secure' && (
              <span className="flex items-center gap-1 text-[10px] text-[var(--success)]">
                <KeyRoundIcon className="size-3" /> Stored securely
              </span>
            )}
            {connection?.credentialStatus === 'environment' && (
              <span className="text-[10px] text-[var(--text-dim)]">From environment</span>
            )}
          </div>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                type={revealCredential ? 'text' : 'password'}
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                placeholder={
                  connection?.configured
                    ? 'Leave blank to keep current credential'
                    : 'Paste credential'
                }
                disabled={Boolean(busy)}
                className={`${inputClassName} pr-8`}
              />
              <button
                type="button"
                aria-label={revealCredential ? 'Hide credential' : 'Show credential'}
                onClick={() => setRevealCredential((visible) => !visible)}
                className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-[var(--text-dim)] hover:text-[var(--text)]"
              >
                {revealCredential ? (
                  <EyeOffIcon className="size-3.5" />
                ) : (
                  <EyeIcon className="size-3.5" />
                )}
              </button>
            </div>
            {connection?.credentialStatus === 'secure' && (
              <button
                type="button"
                onClick={() => void removeCredential()}
                disabled={Boolean(busy)}
                className="h-8 rounded-md border border-[var(--border)] px-2 text-[10px] text-[var(--text-dim)] hover:border-[var(--error)] hover:text-[var(--error)] disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
          <p className="mt-1 text-[10.5px] text-[var(--text-dim)]">
            Secrets stay in the main process and are encrypted with the operating system keychain.
          </p>
          {isImportableAccount(profile.providerType) && (
            <button
              type="button"
              onClick={() => void importAccount()}
              disabled={Boolean(busy)}
              className="mt-2 flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-soft)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
            >
              <KeyRoundIcon className="size-3.5" />
              {busy === 'import'
                ? 'Checking local login…'
                : `Use existing ${accountSourceLabel(profile.providerType)} login`}
            </button>
          )}
        </section>

        <section>
          <FieldLabel>Endpoint</FieldLabel>
          <input
            value={profile.baseUrl ?? ''}
            onChange={(event) =>
              setProfile((current) => ({ ...current, baseUrl: event.target.value }))
            }
            placeholder="https://api.example.com/v1"
            disabled={Boolean(busy)}
            className={`${inputClassName} font-mono`}
          />
        </section>

        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <FieldLabel>Models</FieldLabel>
            <span className="rounded-full bg-[var(--surface-hover)] px-1.5 py-px text-[10px] tabular-nums text-[var(--text-dim)]">
              {modelChoices.length}
            </span>
            {profile.modelSource && (
              <span className="text-[10px] text-[var(--text-dim)]">
                {profile.modelSource === 'fetched' ? 'From account' : 'Built-in catalog'}
              </span>
            )}
            <button
              type="button"
              onClick={() => void discover()}
              disabled={Boolean(busy) || !canDiscover || !hasUsableCredential}
              className="ml-auto flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
            >
              <RefreshCwIcon className={`size-3 ${busy === 'discover' ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          <div className="max-h-44 overflow-y-auto rounded-md border border-[var(--border)]">
            {modelChoices.map((model) => (
              <ModelChoiceRow
                key={model.id}
                model={model}
                enabled={enabledModelIds.has(model.id)}
                isDefault={profile.defaultModel === model.id}
                onToggle={() => toggleModel(model.id)}
                onDefault={() =>
                  setProfile((current) => ({
                    ...current,
                    defaultModel: model.id,
                    enabledModelIds: Array.from(
                      new Set([...(current.enabledModelIds ?? []), model.id]),
                    ),
                  }))
                }
              />
            ))}
            {modelChoices.length === 0 && (
              <div className="px-2.5 py-3 text-[11px] text-[var(--text-dim)]">
                Refresh models from the provider or add one manually.
              </div>
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={manualModelId}
              onChange={(event) => setManualModelId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addManualModel()
                }
              }}
              placeholder="Add model ID"
              disabled={Boolean(busy)}
              className={`${inputClassName} font-mono`}
            />
            <button
              type="button"
              onClick={addManualModel}
              disabled={Boolean(busy) || !manualModelId.trim()}
              className="h-8 rounded-md border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-soft)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </section>

        <label className="flex items-center gap-2 text-[11px] text-[var(--text-soft)]">
          <input
            type="checkbox"
            checked={profile.enabled !== false}
            onChange={(event) =>
              setProfile((current) => ({ ...current, enabled: event.target.checked }))
            }
            disabled={Boolean(busy)}
            className="size-3.5"
          />
          Show this connection in model pickers
        </label>

        <div className="flex items-center gap-2 border-t border-[var(--border)] pt-4">
          {connection?.persisted && (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={Boolean(busy)}
              className="grid size-8 place-items-center rounded-md text-[var(--text-dim)] hover:bg-[var(--error-soft)] hover:text-[var(--error)] disabled:opacity-40"
              title="Remove connection"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          )}
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={Boolean(busy)}
              className="h-8 rounded-md px-3 text-[11px] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
            >
              Cancel
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => void test()}
              disabled={Boolean(busy) || !hasUsableCredential || !profile.defaultModel}
              className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 text-[11px] text-[var(--text-soft)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
            >
              <TestTubeIcon className="size-3.5" />
              {busy === 'test' ? 'Testing…' : 'Test'}
            </button>
            <button
              type="button"
              onClick={() => void save(!connection?.persisted)}
              disabled={Boolean(busy) || !profile.id || !profile.label}
              className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--brand-ink)] px-3 text-[11px] font-medium text-[var(--brand-ink-fg)] hover:opacity-90 disabled:opacity-40"
            >
              <SaveIcon className="size-3.5" />
              {busy === 'save' ? 'Saving…' : isNew ? 'Save & discover' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelChoiceRow({
  model,
  enabled,
  isDefault,
  onToggle,
  onDefault,
}: {
  model: ConnectionModel
  enabled: boolean
  isDefault: boolean
  onToggle: () => void
  onDefault: () => void
}): ReactElement {
  return (
    <div className="flex min-h-9 items-center gap-2 border-b border-[var(--border)] px-2.5 last:border-0">
      <input type="checkbox" checked={enabled} onChange={onToggle} className="size-3.5" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] text-[var(--text)]">
          {model.displayName ?? model.id}
        </div>
        {model.displayName && (
          <div className="truncate font-mono text-[9.5px] text-[var(--text-dim)]">{model.id}</div>
        )}
      </div>
      {model.contextLength && (
        <span className="text-[9.5px] tabular-nums text-[var(--text-dim)]">
          {formatContext(model.contextLength)}
        </span>
      )}
      <button
        type="button"
        onClick={onDefault}
        title={isDefault ? 'Default model' : 'Make default'}
        className={`grid size-5 place-items-center rounded ${
          isDefault
            ? 'bg-[var(--success-soft)] text-[var(--success)]'
            : 'text-transparent hover:bg-[var(--surface-hover)] hover:text-[var(--text-dim)]'
        }`}
      >
        <CheckIcon className="size-3" />
      </button>
    </div>
  )
}

function ConnectionStatusBadge({
  connection,
}: {
  connection: ProviderConnectionSnapshot
}): ReactElement {
  const tone = connection.profile.lastTestStatus
    ? connection.profile.lastTestStatus === 'verified'
      ? 'bg-[var(--success-soft)] text-[var(--success)]'
      : connection.profile.lastTestStatus === 'needs_reauth'
        ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
        : 'bg-[var(--error-soft)] text-[var(--error)]'
    : connection.configured
      ? 'bg-[var(--success-soft)] text-[var(--success)]'
      : 'bg-[var(--surface-hover)] text-[var(--text-dim)]'
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {connectionStatusLabel(connection)}
    </span>
  )
}

function connectionStatusLabel(connection: ProviderConnectionSnapshot): string {
  if (connection.profile.lastTestStatus === 'verified') return 'Verified'
  if (connection.profile.lastTestStatus === 'needs_reauth') return 'Sign in again'
  if (connection.profile.lastTestStatus === 'error') return 'Connection error'
  if (connection.credentialStatus === 'environment') return 'Environment'
  return connection.configured ? 'Configured' : 'Not connected'
}

function connectionStatusDot(connection: ProviderConnectionSnapshot): string {
  if (connection.profile.lastTestStatus === 'needs_reauth') return 'bg-[var(--warning)]'
  if (connection.profile.lastTestStatus === 'error') return 'bg-[var(--error)]'
  return connection.configured ? 'bg-[var(--success)]' : 'bg-[var(--border-strong)]'
}

function newProfile(
  template: ProviderConnectionSnapshot | undefined,
  existingIds: ProviderId[],
  providerType = template?.profile.providerType ?? 'anthropic',
): ConnectionProfile {
  const id = deriveId(providerType, existingIds)
  if (!template || providerType === CUSTOM_PROVIDER_TYPE) {
    return {
      id,
      providerType,
      label: providerType === CUSTOM_PROVIDER_TYPE ? 'Custom endpoint' : providerType,
      enabled: true,
      credentialRef: id,
      enabledModelIds: [],
      models: [],
      modelSource: 'fallback',
    }
  }
  return {
    ...structuredClone(template.profile),
    id,
    label: template.definition.label,
    credentialRef: id,
    lastTestStatus: undefined,
    lastTestAt: undefined,
    lastTestMessage: undefined,
  }
}

function deriveId(providerType: string, existingIds: ProviderId[]): string {
  const base = slugify(providerType) || 'connection'
  if (!existingIds.includes(base)) return base
  let suffix = 2
  while (existingIds.includes(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isImportableAccount(providerType: string): boolean {
  return (
    providerType === 'claude-subscription' ||
    providerType === 'openai-codex' ||
    providerType === 'github-copilot'
  )
}

function accountSourceLabel(providerType: string): string {
  if (providerType === 'claude-subscription') return 'Claude Code'
  if (providerType === 'openai-codex') return 'Codex CLI'
  return 'GitHub CLI'
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${parseFloat((tokens / 1_000_000).toFixed(2))}M`
  return `${Math.round(tokens / 1_000)}K`
}

function noticeClass(tone: 'success' | 'error' | 'info'): string {
  if (tone === 'success') {
    return 'border-[var(--success)]/25 bg-[var(--success-soft)] text-[var(--success)]'
  }
  if (tone === 'error') {
    return 'border-[var(--error)]/25 bg-[var(--error-soft)] text-[var(--error)]'
  }
  return 'border-[var(--border)] bg-[var(--bg-soft)] text-[var(--text-soft)]'
}

function FieldLabel({ children }: { children: string }): ReactElement {
  return (
    <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
      {children}
    </span>
  )
}

const inputClassName =
  'h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 text-[11.5px] text-[var(--text)] outline-none focus:border-[var(--border-strong)] disabled:opacity-50'
