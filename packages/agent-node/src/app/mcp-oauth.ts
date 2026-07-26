import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { LoadedMcpServerConfig, McpOAuthConfig } from './mcp-config'
import { getDataDir } from './paths'

const MCP_OAUTH_STORE_FILE = 'mcp-oauth.json'
const DEFAULT_NONINTERACTIVE_REDIRECT_URI = 'http://127.0.0.1:45575/oauth/callback'
const DEFAULT_INTERACTIVE_REDIRECT_URI = 'http://127.0.0.1:0/oauth/callback'
const DEFAULT_OAUTH_FLOW_TIMEOUT_MS = 180_000

export interface PublicMcpOAuthStatus {
  type: 'oauth'
  configured: boolean
  authorized: boolean
  hasRefreshToken: boolean
  scopes: string[]
  clientIdSuffix?: string
  redirectUri?: string
  lastAuthorizedAt?: number
  updatedAt?: number
}

export interface McpOAuthFlowResult {
  ok: boolean
  serverName: string
  status: PublicMcpOAuthStatus
}

export type OpenExternalUrl = (url: string) => Promise<unknown> | unknown

interface StoredMcpOAuthRecord {
  tokens?: OAuthTokens
  clientInformation?: OAuthClientInformationMixed
  codeVerifier?: string
  discoveryState?: OAuthDiscoveryState
  lastAuthorizationUrl?: string
  lastAuthorizedAt?: number
  updatedAt?: number
}

interface StoredMcpOAuthFile {
  version: 1
  records: Record<string, StoredMcpOAuthRecord>
}

interface CreateMcpOAuthProviderOptions {
  interactive?: boolean
  redirectUrl?: string
  state?: string
  onRedirect?: OpenExternalUrl
}

interface OAuthCallbackServer {
  redirectUrl: string
  code: Promise<string>
  close(): Promise<void>
}

function getMcpOAuthStorePath(): string {
  return join(getDataDir(), MCP_OAUTH_STORE_FILE)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function readOAuthStore(): Promise<StoredMcpOAuthFile> {
  try {
    const raw = await readFile(getMcpOAuthStorePath(), 'utf-8')
    const parsed = asObject(JSON.parse(raw))
    const records = asObject(parsed?.records)
    if (!records) return { version: 1, records: {} }
    return { version: 1, records: records as Record<string, StoredMcpOAuthRecord> }
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT') {
      return { version: 1, records: {} }
    }
    throw error
  }
}

async function writeOAuthStore(store: StoredMcpOAuthFile): Promise<void> {
  const path = getMcpOAuthStorePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  })
  await chmod(path, 0o600).catch(() => {})
}

async function updateOAuthRecord(
  key: string,
  updater: (record: StoredMcpOAuthRecord | undefined) => StoredMcpOAuthRecord | undefined,
): Promise<StoredMcpOAuthRecord | undefined> {
  const store = await readOAuthStore()
  const next = updater(store.records[key] ? { ...store.records[key] } : undefined)
  if (next) {
    store.records[key] = { ...next, updatedAt: Date.now() }
  } else {
    delete store.records[key]
  }
  await writeOAuthStore(store)
  return next
}

async function readOAuthRecord(key: string): Promise<StoredMcpOAuthRecord | undefined> {
  const store = await readOAuthStore()
  const record = store.records[key]
  return record ? { ...record } : undefined
}

export function getMcpOAuthRecordKey(config: LoadedMcpServerConfig): string {
  return createHash('sha256')
    .update([config.sourcePath, config.name, config.url ?? ''].join('\n'))
    .digest('hex')
}

function requireOAuthConfig(config: LoadedMcpServerConfig): McpOAuthConfig {
  if (config.auth?.type !== 'oauth') {
    throw new Error(`MCP server "${config.name}" is not configured for OAuth`)
  }
  if (!config.url) throw new Error(`MCP server "${config.name}" has no URL`)
  return config.auth
}

function normalizeScopes(config: McpOAuthConfig): string[] {
  return [...new Set((config.scopes ?? []).map((scope) => scope.trim()).filter(Boolean))]
}

function scopeString(config: McpOAuthConfig): string | undefined {
  const scopes = normalizeScopes(config)
  return scopes.length > 0 ? scopes.join(' ') : undefined
}

function shortClientId(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length <= 12 ? value : value.slice(-12)
}

function randomState(): string {
  return randomBytes(24).toString('base64url')
}

class AilaMcpOAuthProvider implements OAuthClientProvider {
  private readonly key: string
  private readonly stateValue: string
  private readonly interactive: boolean
  private readonly onRedirect?: OpenExternalUrl
  private readonly redirectUrlValue: string

  constructor(
    private readonly config: LoadedMcpServerConfig,
    private readonly oauthConfig: McpOAuthConfig,
    options: CreateMcpOAuthProviderOptions = {},
  ) {
    this.key = getMcpOAuthRecordKey(config)
    this.stateValue = options.state ?? randomState()
    this.interactive = options.interactive === true
    this.onRedirect = options.onRedirect
    this.redirectUrlValue =
      options.redirectUrl ?? oauthConfig.redirectUri ?? DEFAULT_NONINTERACTIVE_REDIRECT_URI
  }

  get redirectUrl(): string {
    return this.redirectUrlValue
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrlValue],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: this.oauthConfig.clientName ?? 'Aila',
      ...(scopeString(this.oauthConfig) && { scope: scopeString(this.oauthConfig) }),
      ...(this.oauthConfig.tokenEndpointAuthMethod && {
        token_endpoint_auth_method: this.oauthConfig.tokenEndpointAuthMethod,
      }),
    }
  }

  state(): string {
    return this.stateValue
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.oauthConfig.clientId) {
      return {
        client_id: this.oauthConfig.clientId,
        redirect_uris: [this.redirectUrlValue],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(this.oauthConfig.clientSecret && { client_secret: this.oauthConfig.clientSecret }),
        ...(this.oauthConfig.tokenEndpointAuthMethod && {
          token_endpoint_auth_method: this.oauthConfig.tokenEndpointAuthMethod,
        }),
      }
    }
    return (await readOAuthRecord(this.key))?.clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await updateOAuthRecord(this.key, (record) => ({ ...(record ?? {}), clientInformation }))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await readOAuthRecord(this.key))?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await updateOAuthRecord(this.key, (record) => {
      const refreshToken = tokens.refresh_token ?? record?.tokens?.refresh_token
      return {
        ...(record ?? {}),
        tokens: {
          ...tokens,
          ...(refreshToken && { refresh_token: refreshToken }),
        },
        lastAuthorizedAt: Date.now(),
      }
    })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const url = new URL(authorizationUrl)
    for (const [key, value] of Object.entries(this.oauthConfig.authorizationParams ?? {})) {
      if (value) url.searchParams.set(key, value)
    }

    await updateOAuthRecord(this.key, (record) => ({
      ...(record ?? {}),
      lastAuthorizationUrl: url.toString(),
    }))

    if (!this.interactive) {
      throw new Error(
        `OAuth authorization required for MCP server "${this.config.name}". Open Settings > Extensions and connect it first.`,
      )
    }
    if (!this.onRedirect) throw new Error('OAuth redirect handler is not configured')
    await this.onRedirect(url.toString())
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await updateOAuthRecord(this.key, (record) => ({ ...(record ?? {}), codeVerifier }))
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await readOAuthRecord(this.key))?.codeVerifier
    if (!verifier)
      throw new Error(`No OAuth code verifier saved for MCP server "${this.config.name}"`)
    return verifier
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    await updateOAuthRecord(this.key, (record) => {
      if (!record || scope === 'all') return undefined
      const next = { ...record }
      if (scope === 'client') delete next.clientInformation
      if (scope === 'tokens') delete next.tokens
      if (scope === 'verifier') delete next.codeVerifier
      if (scope === 'discovery') delete next.discoveryState
      return next
    })
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await updateOAuthRecord(this.key, (record) => ({ ...(record ?? {}), discoveryState: state }))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await readOAuthRecord(this.key))?.discoveryState
  }
}

export function createMcpOAuthProvider(
  config: LoadedMcpServerConfig,
  options: CreateMcpOAuthProviderOptions = {},
): OAuthClientProvider {
  return new AilaMcpOAuthProvider(config, requireOAuthConfig(config), options)
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    )
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function createOAuthCallbackServer(
  configuredRedirectUri: string | undefined,
  expectedState: string,
): Promise<OAuthCallbackServer> {
  const base = new URL(configuredRedirectUri ?? DEFAULT_INTERACTIVE_REDIRECT_URI)
  if (base.protocol !== 'http:' || !isLoopbackHost(base.hostname)) {
    throw new Error('Aila OAuth can only complete http loopback redirect URIs')
  }
  const host = base.hostname.replace(/^\[|\]$/g, '')
  const port = base.port ? Number(base.port) : 80
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid OAuth redirect port "${base.port}"`)
  }

  let settle: ((code: string) => void) | undefined
  let fail: ((error: Error) => void) | undefined
  let settled = false
  const code = new Promise<string>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  let redirectUrl = base.toString()
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', redirectUrl)
    if (requestUrl.pathname !== base.pathname) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }

    const error = requestUrl.searchParams.get('error')
    const codeValue = requestUrl.searchParams.get('code')
    const state = requestUrl.searchParams.get('state')
    if (error) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<h1>Authorization failed</h1><p>You can return to Aila.</p>')
      if (!settled) {
        settled = true
        fail?.(new Error(`OAuth authorization failed: ${error}`))
      }
      return
    }
    if (!codeValue) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<h1>Authorization failed</h1><p>Missing authorization code.</p>')
      if (!settled) {
        settled = true
        fail?.(new Error('OAuth callback did not include an authorization code'))
      }
      return
    }
    if (state !== expectedState) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<h1>Authorization failed</h1><p>State verification failed.</p>')
      if (!settled) {
        settled = true
        fail?.(new Error('OAuth callback state did not match the expected value'))
      }
      return
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<h1>Authorization complete</h1><p>You can return to Aila.</p>')
    if (!settled) {
      settled = true
      settle?.(codeValue)
    }
  })

  await listen(server, port, host)
  const address = server.address() as AddressInfo | null
  if (!address) throw new Error('OAuth callback server did not start')
  const actual = new URL(base)
  actual.port = String(address.port)
  redirectUrl = actual.toString()

  return {
    redirectUrl,
    code,
    close: async () => {
      await closeServer(server).catch(() => {})
    },
  }
}

export async function getMcpOAuthStatus(
  config: LoadedMcpServerConfig,
): Promise<PublicMcpOAuthStatus | undefined> {
  if (config.auth?.type !== 'oauth') return undefined
  const record = await readOAuthRecord(getMcpOAuthRecordKey(config))
  const clientId = config.auth.clientId ?? record?.clientInformation?.client_id
  return {
    type: 'oauth',
    configured: Boolean(clientId),
    authorized: Boolean(record?.tokens?.access_token),
    hasRefreshToken: Boolean(record?.tokens?.refresh_token),
    scopes: normalizeScopes(config.auth),
    ...(shortClientId(clientId) && { clientIdSuffix: shortClientId(clientId) }),
    ...(config.auth.redirectUri && { redirectUri: config.auth.redirectUri }),
    ...(record?.lastAuthorizedAt && { lastAuthorizedAt: record.lastAuthorizedAt }),
    ...(record?.updatedAt && { updatedAt: record.updatedAt }),
  }
}

export async function clearMcpOAuthCredentials(config: LoadedMcpServerConfig): Promise<void> {
  requireOAuthConfig(config)
  await updateOAuthRecord(getMcpOAuthRecordKey(config), () => undefined)
}

export async function startMcpOAuthFlow(
  config: LoadedMcpServerConfig,
  options: { openExternal: OpenExternalUrl; timeoutMs?: number },
): Promise<McpOAuthFlowResult> {
  const oauthConfig = requireOAuthConfig(config)
  if (!config.url) throw new Error(`MCP server "${config.name}" has no URL`)
  const state = randomState()
  const callback = await createOAuthCallbackServer(oauthConfig.redirectUri, state)
  const provider = createMcpOAuthProvider(config, {
    interactive: true,
    redirectUrl: callback.redirectUrl,
    state,
    onRedirect: options.openExternal,
  })

  try {
    const authResult = await auth(provider, {
      serverUrl: config.url,
      scope: scopeString(oauthConfig),
    })
    if (authResult === 'REDIRECT') {
      const code = await withTimeout(
        callback.code,
        options.timeoutMs ?? DEFAULT_OAUTH_FLOW_TIMEOUT_MS,
        'OAuth authorization',
      )
      const finishResult = await auth(provider, {
        serverUrl: config.url,
        authorizationCode: code,
        scope: scopeString(oauthConfig),
      })
      if (finishResult !== 'AUTHORIZED') {
        throw new Error(`OAuth authorization did not finish for MCP server "${config.name}"`)
      }
    }
    const status = await getMcpOAuthStatus(config)
    if (!status) throw new Error(`MCP server "${config.name}" has no OAuth status`)
    return { ok: status.authorized, serverName: config.name, status }
  } finally {
    await callback.close()
  }
}
