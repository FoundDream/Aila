import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_TOKEN_LENGTH = 64 * 1_024

export type ImportableAccountProvider = 'claude-subscription' | 'openai-codex' | 'github-copilot'

export interface ImportedProviderAccount {
  credential: string
  source: string
}

export async function importExistingProviderAccount(
  providerType: string,
): Promise<ImportedProviderAccount> {
  switch (providerType) {
    case 'claude-subscription':
      return importClaudeCodeLogin()
    case 'openai-codex':
      return importCodexLogin()
    case 'github-copilot':
      return importGitHubCliLogin()
    default:
      throw new Error(`Provider "${providerType}" does not support account import`)
  }
}

function importClaudeCodeLogin(): ImportedProviderAccount {
  const paths = [
    join(homedir(), '.claude', '.credentials.json'),
    join(homedir(), '.claude', 'credentials.json'),
  ]
  for (const path of paths) {
    const payload = readJson(path)
    if (!payload) continue
    const oauth = recordValue(payload.claudeAiOauth) ?? recordValue(payload.oauth)
    const credential =
      stringValue(oauth?.accessToken) ??
      stringValue(oauth?.access_token) ??
      stringValue(payload.accessToken) ??
      stringValue(payload.access_token)
    if (credential) return { credential: boundedCredential(credential), source: 'Claude Code' }
  }
  throw new Error('No Claude Code login was found. Sign in with Claude Code first.')
}

function importCodexLogin(): ImportedProviderAccount {
  const payload = readJson(join(homedir(), '.codex', 'auth.json'))
  const tokens = recordValue(payload?.tokens)
  const credential =
    stringValue(tokens?.access_token) ??
    stringValue(tokens?.accessToken) ??
    stringValue(payload?.access_token) ??
    stringValue(payload?.accessToken)
  if (!credential) {
    throw new Error('No Codex login was found. Run `codex login` first.')
  }
  return { credential: boundedCredential(credential), source: 'Codex CLI' }
}

async function importGitHubCliLogin(): Promise<ImportedProviderAccount> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 10_000,
      maxBuffer: MAX_TOKEN_LENGTH,
      encoding: 'utf8',
    })
    const credential = stdout.trim()
    if (!credential) throw new Error('GitHub CLI returned an empty token')
    if (credential.startsWith('ghp_')) {
      throw new Error(
        'GitHub Copilot does not accept classic personal access tokens. Sign in with GitHub CLI OAuth or use a fine-grained token with Copilot Requests access.',
      )
    }
    if (!isSupportedGitHubCopilotCredential(credential)) {
      throw new Error('The GitHub CLI credential is not an OAuth or supported fine-grained token.')
    }
    return { credential: boundedCredential(credential), source: 'GitHub CLI' }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('GitHub Copilot')) throw error
    if (error instanceof Error && error.message.startsWith('The GitHub CLI')) throw error
    throw new Error(
      'No compatible GitHub CLI login was found. Run `gh auth login` with Copilot Requests access first.',
    )
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return recordValue(parsed)
  } catch {
    return undefined
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function boundedCredential(value: string): string {
  if (value.length > MAX_TOKEN_LENGTH || hasInvalidCredentialCharacter(value)) {
    throw new Error('The imported account credential is invalid')
  }
  return value
}

function hasInvalidCredentialCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      return true
    }
  }
  return false
}

function isSupportedGitHubCopilotCredential(value: string): boolean {
  return value.startsWith('gho_') || value.startsWith('ghu_') || value.startsWith('github_pat_')
}
