import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

interface CredentialFile {
  version: 1
  secrets: Record<string, string>
}

const EMPTY_CREDENTIAL_FILE: CredentialFile = { version: 1, secrets: {} }
const MAX_SECRET_LENGTH = 64 * 1_024

/** Main-process-only encrypted credential storage backed by Electron safeStorage. */
export class ProviderCredentialStore {
  constructor(private readonly path: string) {}

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  hasSecret(reference: string): boolean {
    return Boolean(this.getSecret(reference))
  }

  getSecret(reference: string): string | undefined {
    const encrypted = this.readFile().secrets[normalizeReference(reference)]
    if (!encrypted) return undefined
    if (!this.isAvailable()) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return undefined
    }
  }

  setSecret(reference: string, secret: string): void {
    const normalizedReference = normalizeReference(reference)
    const normalizedSecret = secret.trim()
    if (!normalizedSecret) {
      this.deleteSecret(normalizedReference)
      return
    }
    if (!this.isAvailable()) {
      throw new Error('Secure credential storage is not available on this device')
    }
    if (normalizedSecret.length > MAX_SECRET_LENGTH) {
      throw new Error('Credential is too large')
    }
    const file = this.readFile()
    file.secrets[normalizedReference] = safeStorage
      .encryptString(normalizedSecret)
      .toString('base64')
    this.writeFile(file)
  }

  deleteSecret(reference: string): void {
    const normalizedReference = normalizeReference(reference)
    const file = this.readFile()
    if (!(normalizedReference in file.secrets)) return
    delete file.secrets[normalizedReference]
    this.writeFile(file)
  }

  private readFile(): CredentialFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return structuredClone(EMPTY_CREDENTIAL_FILE)
      }
      const record = parsed as { version?: unknown; secrets?: unknown }
      if (record.version !== 1 || !record.secrets || typeof record.secrets !== 'object') {
        return structuredClone(EMPTY_CREDENTIAL_FILE)
      }
      const secrets: Record<string, string> = {}
      for (const [key, value] of Object.entries(record.secrets)) {
        if (typeof value === 'string' && value) secrets[key] = value
      }
      return { version: 1, secrets }
    } catch {
      return structuredClone(EMPTY_CREDENTIAL_FILE)
    }
  }

  private writeFile(file: CredentialFile): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      chmodSync(temporaryPath, 0o600)
      renameSync(temporaryPath, this.path)
      chmodSync(this.path, 0o600)
    } catch (error) {
      try {
        unlinkSync(temporaryPath)
      } catch {
        // No temporary file remains in the normal success path.
      }
      throw error
    }
  }
}

function normalizeReference(reference: string): string {
  const normalized = reference.trim()
  if (!normalized || normalized.length > 128 || hasControlCharacter(normalized)) {
    throw new Error('Invalid credential reference')
  }
  return normalized
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}
