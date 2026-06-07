import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentProfile,
  type BuiltinAgentProfileId,
  isBuiltinAgentProfileId,
} from './agent-profile'
import { getProfilesDir } from './paths'

export const AILA_PROFILE_MANIFEST_SCHEMA_VERSION = 1

export interface AgentProfileManifest {
  schemaVersion: typeof AILA_PROFILE_MANIFEST_SCHEMA_VERSION
  id: string
  label: string
  description: string
  baseProfileId: BuiltinAgentProfileId
  instructions?: string
  enabled?: boolean
}

export interface LoadedAgentProfile {
  path: string
  manifest: AgentProfileManifest
  profile: AgentProfile
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

function assertProfileId(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value)) {
    throw new Error(
      'manifest.id must contain only letters, numbers, underscores, dots, colons, or dashes',
    )
  }
}

export function parseAgentProfileManifest(value: unknown): AgentProfileManifest {
  assertObject(value, 'profile manifest')
  if (value.schemaVersion !== AILA_PROFILE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `unsupported profile manifest schemaVersion: ${String(value.schemaVersion ?? 'missing')}`,
    )
  }
  assertNonEmptyString(value.id, 'manifest.id')
  assertProfileId(value.id)
  assertNonEmptyString(value.label, 'manifest.label')
  assertNonEmptyString(value.description, 'manifest.description')
  assertNonEmptyString(value.baseProfileId, 'manifest.baseProfileId')
  if (!isBuiltinAgentProfileId(value.baseProfileId)) {
    throw new Error('manifest.baseProfileId must be one of: chat, coding, research')
  }
  if (value.instructions !== undefined && typeof value.instructions !== 'string') {
    throw new Error('manifest.instructions must be a string')
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error('manifest.enabled must be a boolean')
  }

  return {
    schemaVersion: AILA_PROFILE_MANIFEST_SCHEMA_VERSION,
    id: value.id,
    label: value.label,
    description: value.description,
    baseProfileId: value.baseProfileId,
    ...(value.instructions !== undefined && { instructions: value.instructions }),
    ...(value.enabled !== undefined && { enabled: value.enabled }),
  }
}

export async function loadAgentProfileManifest(path: string): Promise<AgentProfileManifest> {
  const raw = await readFile(path, 'utf-8')
  return parseAgentProfileManifest(JSON.parse(raw))
}

function manifestToProfile(manifest: AgentProfileManifest): AgentProfile {
  return {
    id: manifest.id,
    label: manifest.label,
    description: manifest.description,
    baseProfileId: manifest.baseProfileId,
    ...(manifest.instructions !== undefined && { instructions: manifest.instructions }),
  }
}

export async function loadAgentProfileFromManifest(path: string): Promise<LoadedAgentProfile> {
  const manifest = await loadAgentProfileManifest(path)
  if (manifest.enabled === false) {
    throw new Error(`profile is disabled: ${manifest.id}`)
  }
  return { path, manifest, profile: manifestToProfile(manifest) }
}

export async function loadAgentProfilesFromDir(
  dir = getProfilesDir(),
): Promise<LoadedAgentProfile[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const loaded: LoadedAgentProfile[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    const path = join(dir, entry)
    try {
      const manifest = await loadAgentProfileManifest(path)
      if (manifest.enabled === false) continue
      loaded.push({ path, manifest, profile: manifestToProfile(manifest) })
    } catch (error) {
      throw new Error(
        `failed to load profile "${entry}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return loaded
}
