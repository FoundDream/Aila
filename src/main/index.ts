import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { ProviderId } from '@shared/models'
import * as dotenv from 'dotenv'
import { app, BrowserWindow, ipcMain } from 'electron'
import {
  type ChatMessage,
  getModelInfo,
  type ModelSelection,
  streamChat,
  type ToolCall,
} from './agent'
import {
  appendMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  type PersistedImageBlock,
  type PersistedMessage,
  type PersistedTextBlock,
  type PersistedToolCallBlock,
  renameConversation,
  setConversationUsage,
} from './conversations'
import type { DocRecord } from './docs'
import { createDoc, deleteDoc, getDoc, listDocs, updateDoc } from './docs'
import {
  handleImageProtocol,
  imageNameFromUrl,
  registerImageProtocolScheme,
  saveImage,
} from './images'
import { getOpenRouterCatalog } from './openrouter-catalog'
import { getDataDir, getImagesDir } from './paths'
import { configuredProviders, loadSettings, type Settings, saveSettings } from './settings'

dotenv.config()

// Custom schemes must be registered before the app `ready` event fires.
registerImageProtocolScheme()

const DEV_RENDERER_URL = 'http://localhost:5173'

let mainWindow: BrowserWindow | null = null

interface StreamSlot {
  controller: AbortController
  cleanup: Promise<void>
}

// One slot per conversation. The cleanup promise resolves only after the
// stream's persistence side-effects have written to disk — chat:send awaits
// it so a fresh user message can never land on disk before the previous
// (possibly aborted) assistant message.
const activeStreams = new Map<string, StreamSlot>()

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
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function send(channel: string, data?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

// Reconstructs LLM-format ChatMessage[] from persisted blocks. Reasoning is
// dropped (providers don't accept it as input). Each tool_call block produces
// both a `tool_calls` entry on the parent assistant message and a following
// role:'tool' message carrying its result.
function persistedToChatMessages(messages: PersistedMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const content = message.blocks
        .filter((b): b is PersistedTextBlock => b.type === 'text')
        .map((b) => b.content)
        .join('')
      if (content) out.push({ role: 'user', content })
      continue
    }

    const text = message.blocks
      .filter((b): b is PersistedTextBlock => b.type === 'text')
      .map((b) => b.content)
      .join('')
    const toolCalls = message.blocks.filter(
      (b): b is PersistedToolCallBlock => b.type === 'tool_call',
    )

    if (text || toolCalls.length > 0) {
      const assistant: ChatMessage = {
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 && {
          tool_calls: toolCalls.map(
            (tc): ToolCall => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments || '{}' },
            }),
          ),
        }),
      }
      out.push(assistant)
    }

    for (const tc of toolCalls) {
      out.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: tc.result ?? '',
      })
    }
  }
  return out
}

async function persistAndAnnounce(
  conversationId: string,
  message: PersistedMessage,
): Promise<void> {
  const summary = await appendMessage(conversationId, message)
  send('conversations:updated', summary)
}

function registerIpcHandlers(): void {
  ipcMain.handle(
    'chat:send',
    async (_event, conversationId: string, userText: string, selection: ModelSelection) => {
      // Wait for any prior stream on this conversation to fully clean up
      // (including its persisted error/done message) before we touch the log.
      // The renderer's queue runner already serializes per-conversation, but
      // an abort+immediate-resend flow would otherwise race.
      const previous = activeStreams.get(conversationId)
      if (previous) await previous.cleanup.catch(() => {})

      const userMessage: PersistedMessage = {
        id: randomUUID(),
        role: 'user',
        blocks: [{ type: 'text', content: userText }],
        status: 'done',
      }
      await persistAndAnnounce(conversationId, userMessage)

      const assistantMessageId = randomUUID()
      const controller = new AbortController()
      let resolveCleanup: () => void = () => {}
      const cleanup = new Promise<void>((resolve) => {
        resolveCleanup = resolve
      })
      activeStreams.set(conversationId, { controller, cleanup })

      const record = await getConversation(conversationId)
      const messages = persistedToChatMessages(record.messages)

      void (async () => {
        try {
          await streamChat(
            {
              conversationId,
              assistantMessageId,
              messages,
              selection,
              signal: controller.signal,
            },
            {
              onTextDelta: (event) => send('chat:text-delta', event),
              onReasoningDelta: (event) => send('chat:reasoning-delta', event),
              onToolCallStart: (event) => send('chat:tool-call-start', event),
              onToolCallResult: (event) => send('chat:tool-call-result', event),
              onImageBlock: (event) => send('chat:image-block', event),
              onDone: async (event) => {
                await persistAndAnnounce(conversationId, event.message)
                if (event.usage) {
                  const summary = await setConversationUsage(conversationId, event.usage)
                  send('conversations:updated', summary)
                }
                send('chat:done', event)
              },
              onError: async (event) => {
                await persistAndAnnounce(conversationId, event.message)
                send('chat:error', event)
              },
            },
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[chat] unexpected stream error:', message)
          const errored: PersistedMessage = {
            id: assistantMessageId,
            role: 'assistant',
            blocks: [],
            status: 'error',
            error: message,
            model: selection,
          }
          await persistAndAnnounce(conversationId, errored).catch(() => {})
          send('chat:error', {
            conversationId,
            messageId: assistantMessageId,
            error: message,
            message: errored,
          })
        } finally {
          if (activeStreams.get(conversationId)?.controller === controller) {
            activeStreams.delete(conversationId)
          }
          resolveCleanup()
        }
      })()

      return { userMessage, assistantMessageId }
    },
  )

  // Don't remove from the map here — the stream's finally{} block handles
  // that after persisting the partial message. Keeping the slot ensures any
  // subsequent chat:send awaits the cleanup before writing.
  ipcMain.handle('chat:abort', (_event, conversationId: string) => {
    activeStreams.get(conversationId)?.controller.abort()
  })

  ipcMain.handle('docs:list', () => listDocs())
  ipcMain.handle('docs:get', (_event, id: string) => getDoc(id))
  ipcMain.handle('docs:create', (_event, parentId?: string | null) => createDoc(parentId ?? null))
  ipcMain.handle(
    'docs:update',
    (_event, id: string, patch: Partial<Pick<DocRecord, 'parentId' | 'title' | 'content'>>) =>
      updateDoc(id, patch),
  )
  ipcMain.handle('docs:delete', (_event, id: string) => deleteDoc(id))

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

  ipcMain.handle('conversations:list', () => listConversations())
  ipcMain.handle('conversations:get', (_event, id: string) => getConversation(id))
  ipcMain.handle('conversations:create', () => createConversation())
  ipcMain.handle('conversations:rename', (_event, id: string, title: string) =>
    renameConversation(id, title),
  )
  ipcMain.handle('conversations:delete', async (_event, id: string) => {
    const slot = activeStreams.get(id)
    if (slot) {
      slot.controller.abort()
      await slot.cleanup.catch(() => {})
    }
    // Sweep image files referenced by this conversation before dropping the log.
    try {
      const record = await getConversation(id)
      const imagesDir = getImagesDir()
      const filenames = record.messages.flatMap((m) =>
        m.blocks
          .filter((b): b is PersistedImageBlock => b.type === 'image')
          .map((b) => imageNameFromUrl(b.url))
          .filter((n): n is string => n !== null),
      )
      await Promise.all(filenames.map((name) => unlink(join(imagesDir, name)).catch(() => {})))
    } catch (err) {
      console.warn('[conversations:delete] image cleanup failed:', err)
    }
    return deleteConversation(id)
  })
}

app.whenReady().then(() => {
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
  for (const slot of activeStreams.values()) slot.controller.abort()
})
