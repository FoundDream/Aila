import { mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { ConversationWorkspaceRef, ProviderId } from '@aila/agent'
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
} from 'electron'
import { getModelInfo } from './agent'
import { rewriteDocRefs as rewritePersistedDocRefs } from './conversations'
import { sweepOrphanedDocConversations } from './doc-conversation-cleanup'
import type { DocPatch } from './docs'
import {
  configureDocConversationRefRewriter,
  createDoc,
  createFolder,
  deleteDoc,
  deleteFolder,
  getDoc,
  listAll,
  moveFolder,
  renameFolder,
  updateDoc,
} from './docs'
import { getExtensionReport, installSkillFromDirectory } from './extensions'
import { saveImage } from './image-store'
import { handleImageProtocol, registerImageProtocolScheme } from './images'
import { disposeMcpConnections } from './mcp-connection-manager'
import {
  deleteUserMcpServer,
  type SaveMcpServerRequest,
  saveUserMcpServerConfig,
  setMcpServerEnabled,
  testConfiguredMcpServer,
  testMcpServerDraft,
} from './mcp-management'
import { getOpenRouterCatalog } from './openrouter-catalog'
import { configureDataDir, getDataDir } from './paths'
import {
  createDesktopRuntimeWorkbench,
  registerRuntimeWorkbenchIpcHandlers,
} from './runtime-workbench'
import { configuredProviders, loadSettings, type Settings, saveSettings } from './settings'
import {
  createTerminalSessionManager,
  registerTerminalIpcHandlers,
  type TerminalSessionManager,
} from './terminal'
import { handleWidgetProtocol, registerWidgetProtocolScheme } from './widget-protocol'

dotenv.config()

const APP_NAME = 'Aila'
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

// electron-vite injects the renderer dev server's *actual* URL here. Don't
// hardcode the port: if another Vite app already holds 5173, our renderer
// falls back to 5174 and a hardcoded 5173 would load the wrong app (or fail).
const DEV_RENDERER_URL = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'

let mainWindow: BrowserWindow | null = null
let gracefulShutdownStarted = false
let gracefulShutdownComplete = false

function getDevelopmentAppIcon(): NativeImage | undefined {
  if (!is.dev) return undefined

  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build/icon.png'))
  return icon.isEmpty() ? undefined : icon
}

function createWindow(): void {
  // The renderer is light-only; pin the native appearance so the sidebar
  // vibrancy material stays light when the OS switches to dark mode.
  nativeTheme.themeSource = 'light'
  const appIcon = getDevelopmentAppIcon()

  if (process.platform === 'darwin' && app.dock && appIcon) app.dock.setIcon(appIcon)

  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    show: false,
    titleBarStyle: 'hiddenInset',
    // macOS: the renderer leaves the window background transparent so the
    // sidebar shows the native translucent material; the content pane paints
    // its own opaque white. Elsewhere fall back to a solid background.
    ...(process.platform === 'darwin'
      ? { vibrancy: 'sidebar' as const }
      : { backgroundColor: '#f7f7f7' }),
    ...(appIcon ? { icon: appIcon } : {}),
    trafficLightPosition: { x: 6, y: 10 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  if (is.dev) {
    mainWindow.loadURL(DEV_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
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

const runtimeWorkbench = createDesktopRuntimeWorkbench({ emit: send, logger: console })
let terminalManager: TerminalSessionManager | null = null

function getTerminalManager(): TerminalSessionManager {
  terminalManager ??= createTerminalSessionManager(send)
  return terminalManager
}

configureDocConversationRefRewriter(async (rewrites) => {
  const summaries = await rewritePersistedDocRefs(rewrites.map((rewrite) => ({ ...rewrite })))
  for (const summary of summaries) send('conversations:updated', summary)
  return summaries
})

async function shutdownRuntimeWorkbench(): Promise<void> {
  terminalManager?.shutdown()
  await runtimeWorkbench.shutdown()
  await disposeMcpConnections()
}

function registerIpcHandlers(): void {
  registerRuntimeWorkbenchIpcHandlers(ipcMain, runtimeWorkbench)
  registerTerminalIpcHandlers(ipcMain, getTerminalManager())

  async function reloadExtensions() {
    const runtimeReload = await runtimeWorkbench.reloadExtensions()
    const report = await getExtensionReport()
    return {
      toolCount: runtimeReload.toolCount,
      skillCount: report.skills.length,
      report,
    }
  }

  ipcMain.handle('docs:list', () => listAll())
  ipcMain.handle('docs:get', (_event, docPath: string) => getDoc(docPath))
  ipcMain.handle('docs:create', (_event, folderPath?: string | null) =>
    createDoc(folderPath ?? null),
  )
  ipcMain.handle('docs:update', (_event, docPath: string, patch: DocPatch) =>
    updateDoc(docPath, patch),
  )

  ipcMain.handle('folders:create', (_event, parentPath: string | null, name: string) =>
    createFolder(parentPath, name),
  )
  ipcMain.handle('folders:rename', (_event, path: string, newName: string) =>
    renameFolder(path, newName),
  )
  ipcMain.handle('folders:move', (_event, path: string, newParentPath: string | null) =>
    moveFolder(path, newParentPath),
  )

  ipcMain.handle('docs:delete', async (_event, docPath: string) => {
    await deleteDoc(docPath)
    await sweepOrphanedDocConversations({
      listConversations: () => runtimeWorkbench.listConversations(),
      deleteConversation: (id) => runtimeWorkbench.deleteConversation(id),
    })
  })

  ipcMain.handle('folders:delete', async (_event, path: string) => {
    await deleteFolder(path)
    await sweepOrphanedDocConversations({
      listConversations: () => runtimeWorkbench.listConversations(),
      deleteConversation: (id) => runtimeWorkbench.deleteConversation(id),
    })
  })

  ipcMain.handle('images:save', (_event, bytes: ArrayBuffer, filename: string) =>
    saveImage(bytes, filename),
  )

  ipcMain.handle('chat:get-model-info', (_event, providerId: ProviderId, modelId: string) =>
    getModelInfo(providerId, modelId),
  )

  function packSettings(settings: Settings): {
    settings: Settings
    configuredProviders: ProviderId[]
  } {
    return { settings, configuredProviders: configuredProviders(settings) }
  }
  ipcMain.handle('settings:get', () => packSettings(loadSettings()))
  ipcMain.handle('settings:set', (_event, next: Settings) => packSettings(saveSettings(next)))
  ipcMain.handle('workspaces:pick-directory', () => pickWorkspaceDirectory())
  ipcMain.handle('openrouter:list-models', () => getOpenRouterCatalog())
  ipcMain.handle('extensions:report', () => getExtensionReport())
  ipcMain.handle('extensions:reload', () => reloadExtensions())
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
}

app.whenReady().then(async () => {
  configureDataDir(is.dev ? DEV_DATA_DIR : app.getPath('userData'))
  console.log('[storage] data dir =', getDataDir())
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
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
