import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import * as dotenv from 'dotenv'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { ProviderId } from '../shared/models'
import { getModelInfo, type ModelSelection } from './agent'
import type { AgentProfileId } from './agent-profile'
import { sweepOrphanedDocConversations } from './doc-conversation-cleanup'
import type { DocPatch } from './docs'
import {
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
import { cleanupConversationImages, saveImage } from './image-store'
import { handleImageProtocol, registerImageProtocolScheme } from './images'
import { getOpenRouterCatalog } from './openrouter-catalog'
import { configureDataDir, getDataDir } from './paths'
import { loadAgentProfilesFromDir } from './profile-loader'
import { AgentRuntime } from './runtime'
import { configuredProviders, loadSettings, type Settings, saveSettings } from './settings'
import { ToolApprovalStore } from './tool-approvals'
import { loadToolPacksFromDir } from './tool-pack-loader'
import type { ToolApprovalRequest } from './tools'
import {
  buildDesktopWorkspaceContextFromRecord,
  getDesktopWorkspaceRoots,
} from './workspace-context'

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

const TOOL_APPROVAL_TIMEOUT_MS = 60_000

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f7f7',
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

const toolApprovals = new ToolApprovalStore({
  timeoutMs: TOOL_APPROVAL_TIMEOUT_MS,
  recordAgentEvent: async (_conversationId, event) => {
    await agentRuntime.recordAgentEvent(event)
    return undefined
  },
  onRequest: (payload) => send('tools:approval-request', payload),
  onResolved: (payload) => send('tools:approval-resolved', payload),
  logger: console,
})

function requestToolApproval(req: ToolApprovalRequest): Promise<boolean> {
  return toolApprovals.request(req)
}

async function cancelConversationApprovals(conversationId: string): Promise<void> {
  const resolved = toolApprovals.resolveForConversation(conversationId, false, 'cancelled')
  if (resolved > 0) await toolApprovals.flushActivity()
}

const agentRuntime = new AgentRuntime({
  host: {
    onEvent: (event) => send(event.type, event.data),
    onToolApproval: requestToolApproval,
    onConversationAbort: cancelConversationApprovals,
    cleanupConversationAssets: cleanupConversationImages,
    loadProfiles: async () => (await loadAgentProfilesFromDir()).map((profile) => profile.profile),
    loadToolPacks: async () => (await loadToolPacksFromDir()).map((pack) => pack.toolPack),
    loadTransientContext: ({ record }) => buildDesktopWorkspaceContextFromRecord(record),
    workspaceRoots: getDesktopWorkspaceRoots,
  },
})

async function shutdownRuntimeWorkbench(): Promise<void> {
  await agentRuntime.abortAll('shutdown')
  await toolApprovals.shutdown()
}

function registerIpcHandlers(): void {
  ipcMain.handle(
    'chat:send',
    async (
      _event,
      conversationId: string,
      userText: string,
      selection: ModelSelection,
      requestedProfileId?: AgentProfileId,
    ) => {
      return agentRuntime.send({
        conversationId,
        userText,
        selection,
        requestedProfileId,
      })
    },
  )

  ipcMain.handle(
    'chat:retry-last',
    async (
      _event,
      conversationId: string,
      selection: ModelSelection,
      requestedProfileId?: AgentProfileId,
    ) => {
      return agentRuntime.retryLastUserMessage({
        conversationId,
        selection,
        requestedProfileId,
      })
    },
  )

  ipcMain.handle('chat:abort', (_event, conversationId: string) =>
    agentRuntime.abort(conversationId),
  )
  ipcMain.handle('chat:list-active-streams', () => agentRuntime.listActiveStreams())

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
  ipcMain.on(
    'tools:approval-response',
    (_event, payload: { requestId: string; approved: boolean }) => {
      toolApprovals.resolve(payload.requestId, payload.approved, 'user')
    },
  )
  ipcMain.handle('tools:list-pending-approvals', () => toolApprovals.list())

  ipcMain.handle('docs:delete', async (_event, docPath: string) => {
    await deleteDoc(docPath)
    await sweepOrphanedDocConversations({
      listConversations: () => agentRuntime.listConversations(),
      deleteConversation: (id) => agentRuntime.deleteConversation(id),
    })
  })

  ipcMain.handle('folders:delete', async (_event, path: string) => {
    await deleteFolder(path)
    await sweepOrphanedDocConversations({
      listConversations: () => agentRuntime.listConversations(),
      deleteConversation: (id) => agentRuntime.deleteConversation(id),
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
  ipcMain.handle('profiles:list', async () =>
    Array.from((await agentRuntime.getProfiles()).values()),
  )
  ipcMain.handle('extensions:report', () => getExtensionReport())
  ipcMain.handle('extensions:reload', async () => {
    const [profiles, registry, report] = await Promise.all([
      agentRuntime.reloadProfiles(),
      agentRuntime.reloadToolPacks(),
      getExtensionReport(),
    ])
    return {
      profileCount: profiles.size,
      toolPackCount: registry.toolPacks.length,
      toolCount: registry.specs.length,
      report,
    }
  })

  ipcMain.handle('conversations:list', () => agentRuntime.listConversations({ docId: null }))
  ipcMain.handle('conversations:get', (_event, id: string) => agentRuntime.getConversation(id))
  ipcMain.handle('conversations:list-events', (_event, id: string) =>
    agentRuntime.listAgentEvents(id),
  )
  ipcMain.handle('conversations:create', (_event, docPath?: string) =>
    agentRuntime.createConversation({ docId: docPath ?? null }),
  )
  ipcMain.handle('conversations:list-for-doc', (_event, docPath: string) =>
    agentRuntime.listConversations({ docId: docPath }),
  )
  ipcMain.handle('conversations:rename', (_event, id: string, title: string) =>
    agentRuntime.renameConversation(id, title),
  )
  ipcMain.handle('conversations:delete', (_event, id: string) =>
    agentRuntime.deleteConversation(id),
  )
}

app.whenReady().then(async () => {
  configureDataDir(is.dev ? join(app.getAppPath(), '.dev-data') : app.getPath('userData'))
  console.log('[storage] data dir =', getDataDir())
  const recovered = await agentRuntime
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
