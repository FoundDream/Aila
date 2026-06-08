import { join } from 'node:path'
import type { ProviderId } from '@aila/agent'
import { is } from '@electron-toolkit/utils'
import * as dotenv from 'dotenv'
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
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
import { getExtensionReport } from './extensions'
import { saveImage } from './image-store'
import { handleImageProtocol, registerImageProtocolScheme } from './images'
import { getOpenRouterCatalog } from './openrouter-catalog'
import { configureDataDir, getDataDir } from './paths'
import {
  createDesktopRuntimeWorkbench,
  registerRuntimeWorkbenchIpcHandlers,
} from './runtime-workbench'
import { configuredProviders, loadSettings, type Settings, saveSettings } from './settings'

dotenv.config()

// Custom schemes must be registered before the app `ready` event fires.
registerImageProtocolScheme()

// electron-vite injects the renderer dev server's *actual* URL here. Don't
// hardcode the port: if another Vite app already holds 5173, our renderer
// falls back to 5174 and a hardcoded 5173 would load the wrong app (or fail).
const DEV_RENDERER_URL = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'

let mainWindow: BrowserWindow | null = null
let gracefulShutdownStarted = false
let gracefulShutdownComplete = false

function createWindow(): void {
  // The renderer is light-only; pin the native appearance so the sidebar
  // vibrancy material stays light when the OS switches to dark mode.
  nativeTheme.themeSource = 'light'

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

const runtimeWorkbench = createDesktopRuntimeWorkbench({ emit: send, logger: console })
configureDocConversationRefRewriter(async (rewrites) => {
  const summaries = await rewritePersistedDocRefs(rewrites.map((rewrite) => ({ ...rewrite })))
  for (const summary of summaries) send('conversations:updated', summary)
  return summaries
})

async function shutdownRuntimeWorkbench(): Promise<void> {
  await runtimeWorkbench.shutdown()
}

function registerIpcHandlers(): void {
  registerRuntimeWorkbenchIpcHandlers(ipcMain, runtimeWorkbench)

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
  ipcMain.handle('openrouter:list-models', () => getOpenRouterCatalog())
  ipcMain.handle('extensions:report', () => getExtensionReport())
  ipcMain.handle('extensions:reload', async () => {
    const [runtimeReload, report] = await Promise.all([
      runtimeWorkbench.reloadExtensions(),
      getExtensionReport(),
    ])
    return {
      toolPackCount: runtimeReload.toolPackCount,
      toolCount: runtimeReload.toolCount,
      skillCount: report.skills.length,
      report,
    }
  })
}

app.whenReady().then(async () => {
  configureDataDir(is.dev ? join(app.getAppPath(), '.dev-data') : app.getPath('userData'))
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
