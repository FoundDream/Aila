import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import * as dotenv from 'dotenv'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { ProviderId } from '../shared/models'
import { getModelInfo, type ModelSelection } from './agent'
import type { AgentProfileId } from './agent-profile'
import {
  createConversation,
  getConversation,
  listConversations,
  listDocConversations,
  renameConversation,
} from './conversations'
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
import { saveImage } from './image-store'
import { handleImageProtocol, registerImageProtocolScheme } from './images'
import { getOpenRouterCatalog } from './openrouter-catalog'
import { configureDataDir, getDataDir } from './paths'
import { loadAgentProfilesFromDir } from './profile-loader'
import { AgentRuntime } from './runtime'
import { configuredProviders, loadSettings, type Settings, saveSettings } from './settings'
import { loadToolPacksFromDir } from './tool-pack-loader'
import type { ToolApprovalRequest } from './tools'
import { buildDesktopWorkspaceContext, getDesktopWorkspaceRoots } from './workspace-context'

dotenv.config()

// Custom schemes must be registered before the app `ready` event fires.
registerImageProtocolScheme()

// electron-vite injects the renderer dev server's *actual* URL here. Don't
// hardcode the port: if another Vite app already holds 5173, our renderer
// falls back to 5174 and a hardcoded 5173 would load the wrong app (or fail).
const DEV_RENDERER_URL = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'

let mainWindow: BrowserWindow | null = null

const TOOL_APPROVAL_TIMEOUT_MS = 60_000

interface PendingToolApproval {
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingToolApprovals = new Map<string, PendingToolApproval>()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f4f7fb',
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

function requestToolApproval(req: ToolApprovalRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      if (pendingToolApprovals.delete(requestId)) resolve(false)
    }, TOOL_APPROVAL_TIMEOUT_MS)
    pendingToolApprovals.set(requestId, { resolve, timer })
    send('tools:approval-request', {
      requestId,
      name: req.name,
      args: req.args,
      metadata: req.metadata,
    })
  })
}

const agentRuntime = new AgentRuntime({
  onEvent: (event) => send(event.type, event.data),
  onToolApproval: requestToolApproval,
  loadProfiles: async () => (await loadAgentProfilesFromDir()).map((profile) => profile.profile),
  loadToolPacks: async () => (await loadToolPacksFromDir()).map((pack) => pack.toolPack),
  workspaceRoots: getDesktopWorkspaceRoots,
})

async function sweepOrphanedDocConversations(): Promise<void> {
  const [{ docs }, conversations] = await Promise.all([listAll(), listConversations()])
  const liveDocPaths = new Set(docs.map((doc) => doc.path))
  const orphans = conversations.filter(
    (conversation) => conversation.docId && !liveDocPaths.has(conversation.docId),
  )
  await Promise.all(orphans.map((orphan) => agentRuntime.deleteConversation(orphan.id)))
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
      const transientContext = await buildDesktopWorkspaceContext(conversationId)
      return agentRuntime.send({
        conversationId,
        userText,
        selection,
        requestedProfileId,
        transientContext,
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
      const transientContext = await buildDesktopWorkspaceContext(conversationId)
      return agentRuntime.retryLastUserMessage({
        conversationId,
        selection,
        requestedProfileId,
        transientContext,
      })
    },
  )

  ipcMain.handle('chat:abort', (_event, conversationId: string) => {
    agentRuntime.abort(conversationId)
  })

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
      const pending = pendingToolApprovals.get(payload.requestId)
      if (!pending) return
      pendingToolApprovals.delete(payload.requestId)
      clearTimeout(pending.timer)
      pending.resolve(payload.approved)
    },
  )

  ipcMain.handle('docs:delete', async (_event, docPath: string) => {
    await deleteDoc(docPath)
    await sweepOrphanedDocConversations()
  })

  ipcMain.handle('folders:delete', async (_event, path: string) => {
    await deleteFolder(path)
    await sweepOrphanedDocConversations()
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

  ipcMain.handle('conversations:list', () => listConversations())
  ipcMain.handle('conversations:get', (_event, id: string) => getConversation(id))
  ipcMain.handle('conversations:create', (_event, docPath?: string) => createConversation(docPath))
  ipcMain.handle('conversations:list-for-doc', (_event, docPath: string) =>
    listDocConversations(docPath),
  )
  ipcMain.handle('conversations:rename', (_event, id: string, title: string) =>
    renameConversation(id, title),
  )
  ipcMain.handle('conversations:delete', (_event, id: string) =>
    agentRuntime.deleteConversation(id),
  )
}

app.whenReady().then(() => {
  configureDataDir(is.dev ? join(app.getAppPath(), '.dev-data') : app.getPath('userData'))
  console.log('[storage] data dir =', getDataDir())
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

app.on('before-quit', () => {
  agentRuntime.abortAll()
  for (const [requestId, pending] of pendingToolApprovals) {
    pendingToolApprovals.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(false)
  }
})
