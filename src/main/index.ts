import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import * as dotenv from 'dotenv'
import { app, BrowserWindow, ipcMain } from 'electron'
import { type ChatMessage, streamChat } from './agent'
import type { PersistedMessage } from './conversations'
import {
  appendMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
} from './conversations'
import type { DocRecord } from './docs'
import { createDoc, deleteDoc, getDoc, listDocs, updateDoc } from './docs'

dotenv.config()

const DEV_RENDERER_URL = 'http://localhost:5173'

let mainWindow: BrowserWindow | null = null
let activeStream: AbortController | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f4f7fb',
    trafficLightPosition: { x: 16, y: 10 },
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

function registerIpcHandlers(): void {
  ipcMain.handle('chat:send', async (_event, messages: ChatMessage[]) => {
    activeStream?.abort()
    const controller = new AbortController()
    activeStream = controller

    await streamChat(messages, controller.signal, {
      onTextDelta: (delta) => send('chat:text-delta', delta),
      onReasoningDelta: (delta) => send('chat:reasoning-delta', delta),
      onToolCallStart: (event) => send('chat:tool-call-start', event),
      onToolCallResult: (event) => send('chat:tool-call-result', event),
      onDone: (full) => {
        if (activeStream === controller) activeStream = null
        send('chat:done', full)
      },
      onError: (message) => {
        if (activeStream === controller) activeStream = null
        send('chat:error', message)
      },
    })
  })

  ipcMain.handle('chat:abort', () => {
    activeStream?.abort()
    activeStream = null
  })

  ipcMain.handle('docs:list', () => listDocs())
  ipcMain.handle('docs:get', (_event, id: string) => getDoc(id))
  ipcMain.handle('docs:create', () => createDoc())
  ipcMain.handle(
    'docs:update',
    (_event, id: string, patch: Partial<Pick<DocRecord, 'title' | 'content'>>) =>
      updateDoc(id, patch),
  )
  ipcMain.handle('docs:delete', (_event, id: string) => deleteDoc(id))

  ipcMain.handle('conversations:list', () => listConversations())
  ipcMain.handle('conversations:get', (_event, id: string) => getConversation(id))
  ipcMain.handle('conversations:create', () => createConversation())
  ipcMain.handle('conversations:append', (_event, id: string, message: PersistedMessage) =>
    appendMessage(id, message),
  )
  ipcMain.handle('conversations:rename', (_event, id: string, title: string) =>
    renameConversation(id, title),
  )
  ipcMain.handle('conversations:delete', (_event, id: string) => deleteConversation(id))
}

app.whenReady().then(() => {
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
  activeStream?.abort()
})
