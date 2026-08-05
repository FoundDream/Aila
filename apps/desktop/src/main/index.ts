import { mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConversationWorkspaceRef, ProviderId } from '@aila/agent'
import {
  configureDataDir,
  disposeMcpConnections,
  getDataDir,
  getExtensionReport,
  getModelInfo,
  getTokenUsageStats,
  installSkillFromDirectory,
  listIntegrationDefinitions,
  loadMcpTools,
  loadSettings,
  type SaveIntegrationRequest,
  type Settings,
  saveImage,
  saveIntegrationMcpServerConfig,
} from '@aila/agent-node/app'
import { is } from '@electron-toolkit/utils'
import * as dotenv from 'dotenv'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type NativeImage,
  nativeImage,
  nativeTheme,
  type OpenDialogOptions,
  shell,
} from 'electron'
import { handleImageProtocol, registerImageProtocolScheme } from './images'
import {
  clearMcpOAuthForServer,
  deleteUserMcpServer,
  type SaveMcpServerRequest,
  saveUserMcpServerConfig,
  setMcpServerEnabled,
  startMcpOAuthForServer,
  testConfiguredMcpServer,
  testMcpServerDraft,
} from './mcp-management'
import { getOpenRouterCatalog } from './openrouter-catalog'
import { ProviderCredentialStore } from './provider-credential-store'
import {
  createProviderManagement,
  type ProviderConnectionEffectRequest,
  type ProviderManagement,
  type SaveProviderConnectionInput,
} from './provider-management'
import {
  createDesktopRuntimeWorkbench,
  registerRuntimeWorkbenchIpcHandlers,
} from './runtime-workbench'
import { handleWidgetProtocol, registerWidgetProtocolScheme } from './widget-protocol'

dotenv.config()

const APP_NAME = 'Aila'
const MAIN_DIR = dirname(fileURLToPath(import.meta.url))
const DEV_DATA_DIR = join(process.cwd(), '.dev-data')
const DEV_ELECTRON_USER_DATA_DIR = join(process.cwd(), '.dev-electron-user-data')

app.setName(APP_NAME)
if (is.dev) {
  mkdirSync(DEV_ELECTRON_USER_DATA_DIR, { recursive: true })
  app.setPath('userData', DEV_ELECTRON_USER_DATA_DIR)
}

// Custom schemes must be registered before the app `ready` event fires.
registerImageProtocolScheme()
registerWidgetProtocolScheme()

// electron-vite injects the renderer dev server's *actual* URL here. The
// fallback matches the port pinned in electron.vite.config.ts.
const DEV_RENDERER_URL = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5183'

let mainWindow: BrowserWindow | null = null
let gracefulShutdownStarted = false
let gracefulShutdownComplete = false

function getDevelopmentAppIcon(): NativeImage | undefined {
  if (!is.dev) return undefined

  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build/icon.png'))
  return icon.isEmpty() ? undefined : icon
}

function createWindow(): void {
  // Follow the operating system so native chrome and renderer tokens stay aligned.
  nativeTheme.themeSource = 'system'
  const appIcon = getDevelopmentAppIcon()

  if (process.platform === 'darwin' && app.dock && appIcon) app.dock.setIcon(appIcon)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    show: false,
    titleBarStyle: 'hiddenInset',
    // macOS keeps a restrained native material beneath the task rail.
    ...(process.platform === 'darwin'
      ? { vibrancy: 'sidebar' as const }
      : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#111319' : '#fcfaf9' }),
    ...(appIcon ? { icon: appIcon } : {}),
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: join(MAIN_DIR, '../preload/index.mjs'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  if (is.dev) {
    mainWindow.loadURL(DEV_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(MAIN_DIR, '../renderer/index.html'))
  }
}

function send(channel: string, data?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

async function pickWorkspaceDirectory(): Promise<ConversationWorkspaceRef | null> {
  const options: OpenDialogOptions = {
    title: 'Open Workspace',
    properties: ['openDirectory'],
  }
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
  const [selectedPath] = result.filePaths
  if (result.canceled || !selectedPath) return null
  const path = resolve(selectedPath)
  return { id: path, path, label: basename(path) || path }
}

async function pickSkillDirectory(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Install Skill',
    buttonLabel: 'Install',
    properties: ['openDirectory'],
  }
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
  const [selectedPath] = result.filePaths
  if (result.canceled || !selectedPath) return null
  return resolve(selectedPath)
}

let runtimeWorkbench: ReturnType<typeof createDesktopRuntimeWorkbench> | null = null
let providerManagement: ProviderManagement | null = null

function getProviderManagement(): ProviderManagement {
  if (!providerManagement) throw new Error('Provider management is not initialized')
  return providerManagement
}

function initRuntimeWorkbench(): ReturnType<typeof createDesktopRuntimeWorkbench> {
  const providers = getProviderManagement()
  runtimeWorkbench ??= createDesktopRuntimeWorkbench({
    emit: send,
    logger: console,
    runtime: {
      modelRegistry: providers.modelRegistry,
      credentialResolver: providers.credentialResolver,
    },
  })
  return runtimeWorkbench
}

function getRuntimeWorkbench(): ReturnType<typeof createDesktopRuntimeWorkbench> {
  if (!runtimeWorkbench) throw new Error('Runtime workbench is not initialized')
  return runtimeWorkbench
}

async function shutdownRuntimeWorkbench(): Promise<void> {
  await runtimeWorkbench?.shutdown()
  await disposeMcpConnections()
}

function registerIpcHandlers(): void {
  const runtimeWorkbench = getRuntimeWorkbench()
  registerRuntimeWorkbenchIpcHandlers(ipcMain, runtimeWorkbench)

  async function reloadExtensions() {
    const runtimeReload = await runtimeWorkbench.reloadExtensions()
    const report = await getExtensionReport()
    return {
      toolCount: runtimeReload.toolCount,
      skillCount: report.skills.length,
      report,
    }
  }

  ipcMain.handle('images:save', (_event, bytes: ArrayBuffer, filename: string) =>
    saveImage(bytes, filename),
  )

  ipcMain.handle('chat:get-model-info', (_event, providerId: ProviderId, modelId: string) =>
    getModelInfo(providerId, modelId),
  )

  const packSettings = (settings: Settings) => getProviderManagement().state(settings)
  ipcMain.handle('settings:get', () => packSettings(loadSettings()))
  ipcMain.handle('settings:set', (_event, next: Settings) =>
    getProviderManagement().updateSettings(next),
  )
  ipcMain.handle('providers:save', (_event, input: SaveProviderConnectionInput) =>
    getProviderManagement().save(input),
  )
  ipcMain.handle('providers:remove', (_event, connectionId: ProviderId) =>
    getProviderManagement().remove(connectionId),
  )
  ipcMain.handle(
    'providers:import-account',
    (_event, connectionId: ProviderId, providerType: string) =>
      getProviderManagement().importAccount(connectionId, providerType),
  )
  ipcMain.handle('providers:test', (_event, input: ProviderConnectionEffectRequest) =>
    getProviderManagement().test(input),
  )
  ipcMain.handle('providers:discover', (_event, input: ProviderConnectionEffectRequest) =>
    getProviderManagement().discover(input),
  )
  ipcMain.handle('runtime:token-usage-stats', () => getTokenUsageStats())
  ipcMain.handle('workspaces:pick-directory', () => pickWorkspaceDirectory())
  ipcMain.handle('openrouter:list-models', () => getOpenRouterCatalog())
  ipcMain.handle('extensions:report', () => getExtensionReport())
  ipcMain.handle('extensions:reload', () => reloadExtensions())
  ipcMain.handle('extensions:integrations-list', () => listIntegrationDefinitions())
  ipcMain.handle('extensions:integration-save', async (_event, request: SaveIntegrationRequest) => {
    await saveIntegrationMcpServerConfig(request)
    return reloadExtensions()
  })
  ipcMain.handle('extensions:install-skill', async () => {
    const directory = await pickSkillDirectory()
    if (!directory) return null
    await installSkillFromDirectory(directory)
    return reloadExtensions()
  })
  ipcMain.handle('extensions:mcp-save', async (_event, request: SaveMcpServerRequest) => {
    await saveUserMcpServerConfig(request)
    return reloadExtensions()
  })
  ipcMain.handle('extensions:mcp-delete', async (_event, name: string) => {
    await deleteUserMcpServer(name)
    return reloadExtensions()
  })
  ipcMain.handle('extensions:mcp-set-enabled', async (_event, name: string, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    await setMcpServerEnabled(name, enabled)
    return reloadExtensions()
  })
  ipcMain.handle('extensions:mcp-test', (_event, name: string) => testConfiguredMcpServer(name))
  ipcMain.handle('extensions:mcp-test-draft', (_event, request: SaveMcpServerRequest) =>
    testMcpServerDraft(request),
  )
  ipcMain.handle('extensions:mcp-oauth-start', async (_event, name: string) => {
    await startMcpOAuthForServer(name, { openExternal: (url) => shell.openExternal(url) })
    await disposeMcpConnections()
    return reloadExtensions()
  })
  ipcMain.handle('extensions:mcp-oauth-clear', async (_event, name: string) => {
    await clearMcpOAuthForServer(name)
    await disposeMcpConnections()
    return reloadExtensions()
  })
}

void app
  .whenReady()
  .then(async () => {
    configureDataDir(is.dev ? DEV_DATA_DIR : app.getPath('userData'))
    console.log('[storage] data dir =', getDataDir())
    providerManagement = createProviderManagement(
      new ProviderCredentialStore(join(getDataDir(), 'provider-credentials.json')),
    )
    providerManagement.migrateLegacySecrets()
    const runtimeWorkbench = initRuntimeWorkbench()
    const recovered = await runtimeWorkbench
      .recoverInterruptedActivities('app restarted before this turn finished')
      .catch((error) => {
        console.warn('[startup] interrupted activity recovery failed:', error)
        return []
      })
    if (recovered.length > 0) {
      console.log(`[startup] recovered ${recovered.length} interrupted conversation activities`)
    }
    handleImageProtocol()
    handleWidgetProtocol()
    createWindow()
    registerIpcHandlers()

    // Warm MCP connections in the background so the first turn of a new session
    // doesn't pay the cold spawn + handshake cost inline. syncMcpConnections is
    // idempotent and skips already-connected servers, so the first send reuses
    // these instead of blocking on connect()/listTools().
    void loadMcpTools().catch((error) => {
      console.warn('[startup] MCP connection warm-up failed:', error)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((error) => {
    console.error('[startup] fatal initialization failure:', error)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (gracefulShutdownComplete) return
  event.preventDefault()
  if (gracefulShutdownStarted) return
  gracefulShutdownStarted = true
  void shutdownRuntimeWorkbench()
    .catch((error) => {
      console.warn('[shutdown] runtime workbench cleanup failed:', error)
    })
    .finally(() => {
      gracefulShutdownComplete = true
      app.quit()
    })
})
