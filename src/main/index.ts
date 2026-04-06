import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { AgentService } from './agent'
import {
  PreferenceMemoryService,
  type PreferenceMemoryUpdateInput,
} from './memory/preference-memory-service'
import { ConfigService } from './providers/config-service'
import { ProviderRegistry } from './providers/registry'

const DEV_RENDERER_URL = 'http://localhost:5173'

// Initialize config service and provider registry
const configService = new ConfigService()
configService.init()
const registry = new ProviderRegistry(configService)

let mainWindow: BrowserWindow | null = null
let agentService: AgentService | null = null
let memoryService: PreferenceMemoryService | null = null

function isAppUrl(url: string): boolean {
  if (url.startsWith('file://')) {
    return true
  }

  if (is.dev) {
    return url.startsWith(DEV_RENDERER_URL)
  }

  return false
}

async function openExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url)

  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported external URL protocol: ${parsed.protocol}`)
  }

  await shell.openExternal(parsed.toString())
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d1117',
    trafficLightPosition: { x: 16, y: 10 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) {
      void openExternalUrl(url).catch((error) => {
        console.error('Failed to open external URL from new window request:', error)
      })
      return { action: 'deny' }
    }

    return { action: 'allow' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault()
      void openExternalUrl(url).catch((error) => {
        console.error('Failed to open external URL from navigation request:', error)
      })
    }
  })

  if (is.dev) {
    mainWindow.loadURL(DEV_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function ensureAgentService(): AgentService {
  if (!memoryService) {
    memoryService = new PreferenceMemoryService()
  }
  if (!agentService && mainWindow) {
    agentService = new AgentService(mainWindow, registry, configService, memoryService)
  }
  if (!agentService) {
    throw new Error('Agent service is unavailable before the main window is created')
  }
  return agentService
}

function getActiveModelSupportsImages(): boolean {
  const model = registry.createActiveModel()
  if ('error' in model) {
    return false
  }

  return model.input.includes('image')
}

function registerIpcHandlers(): void {
  // --- Agent session handlers (existing) ---

  ipcMain.handle(
    'agent:prompt',
    async (
      _event,
      sessionId: string,
      prompt: {
        text: string
        images?: Array<{ id: string; data: string; mimeType: string; name?: string }>
      },
    ) => {
      try {
        return await ensureAgentService().prompt(sessionId, prompt.text, prompt.images ?? [])
      } catch (err) {
        mainWindow?.webContents.send('agent:error', {
          sessionId,
          message: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
  )

  ipcMain.handle('agent:abort', async (_event, sessionId: string) => {
    return await ensureAgentService().abort(sessionId)
  })

  ipcMain.handle('agent:new-session', async () => {
    return await ensureAgentService().createSession()
  })

  ipcMain.handle('agent:list-sessions', async () => {
    return await ensureAgentService().listSessions()
  })

  ipcMain.handle(
    'agent:open-session',
    async (_event, target: { runtimeId?: string | null; path?: string | null }) => {
      return await ensureAgentService().openSession(target)
    },
  )

  ipcMain.handle('agent:get-session-state', async (_event, sessionId: string) => {
    return ensureAgentService().getSessionState(sessionId)
  })

  ipcMain.handle(
    'agent:edit-queued-prompt',
    async (
      _event,
      sessionId: string,
      promptId: string,
      currentDraft: {
        text: string
        images: Array<{ id: string; data: string; mimeType: string; name?: string }>
      },
    ) => {
      return ensureAgentService().editQueuedPrompt(sessionId, promptId, currentDraft)
    },
  )

  ipcMain.handle(
    'agent:remove-queued-prompt',
    async (_event, sessionId: string, promptId: string) => {
      return ensureAgentService().removeQueuedPrompt(sessionId, promptId)
    },
  )

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    await openExternalUrl(url)
  })

  ipcMain.handle(
    'agent:delete-session',
    async (_event, target: { runtimeId?: string | null; path?: string | null }) => {
      return await ensureAgentService().deleteSession(target)
    },
  )

  ipcMain.handle('agent:get-config', () => {
    return {
      hasApiKey: configService.getProviders().some((p) => p.apiKey),
      activeModelSupportsImages: getActiveModelSupportsImages(),
    }
  })

  // --- Provider management handlers ---

  ipcMain.handle('provider:get-all', () => {
    return configService.getProviders().map(({ apiKey, ...provider }) => ({
      ...provider,
      hasApiKey: Boolean(apiKey),
    }))
  })

  ipcMain.handle('provider:save', (_event, provider) => {
    // Validate required fields
    if (!provider.id || !provider.api) {
      throw new Error('Provider must have id and api fields')
    }
    if (!provider.isBuiltIn && !provider.baseUrl) {
      throw new Error('Custom providers must have a base URL')
    }
    const existing = configService.getProvider(provider.id)
    const nextApiKey =
      typeof provider.apiKey === 'string' && provider.apiKey.trim()
        ? provider.apiKey.trim()
        : existing?.apiKey || ''

    configService.saveProvider({
      ...existing,
      ...provider,
      apiKey: nextApiKey,
    })
    void agentService?.refreshProviderConfig(provider.id)
    mainWindow?.webContents.send('provider:config-changed')
  })

  ipcMain.handle('provider:delete', (_event, providerId: string) => {
    configService.deleteProvider(providerId)
    void agentService?.refreshProviderConfig(providerId)
    mainWindow?.webContents.send('provider:config-changed')
  })

  ipcMain.handle('websearch:get-config', () => {
    const { tavilyApiKey } = configService.getWebSearchConfig()
    return {
      hasTavilyApiKey: Boolean(tavilyApiKey),
    }
  })

  ipcMain.handle('websearch:save-config', (_event, webSearch) => {
    const existing = configService.getWebSearchConfig()
    const nextApiKey =
      typeof webSearch?.tavilyApiKey === 'string' && webSearch.tavilyApiKey.trim()
        ? webSearch.tavilyApiKey.trim()
        : existing.tavilyApiKey

    configService.saveWebSearchConfig({
      tavilyApiKey: nextApiKey,
    })
  })

  ipcMain.handle('provider:test-connection', async (_event, providerId: string) => {
    const provider = configService.getProvider(providerId)
    if (!provider) throw new Error('Provider not found')
    if (!provider.apiKey) throw new Error('No API key configured')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    try {
      let url: string
      const headers: Record<string, string> = {}

      if (provider.api === 'openai-completions') {
        url = `${provider.baseUrl}/models`
        headers.Authorization = `Bearer ${provider.apiKey}`
      } else if (provider.api === 'anthropic-messages') {
        url = `${provider.baseUrl}/v1/messages`
        headers['x-api-key'] = provider.apiKey
        headers['anthropic-version'] = '2023-06-01'
        headers['content-type'] = 'application/json'
      } else if (provider.api === 'google-generative-ai') {
        url = `${provider.baseUrl}/v1beta/models?key=${provider.apiKey}`
      } else if (provider.api === 'google-vertex') {
        url = `${provider.baseUrl}/v1beta1/models?key=${provider.apiKey}`
      } else {
        url = `${provider.baseUrl}/models`
        headers.Authorization = `Bearer ${provider.apiKey}`
      }

      const fetchOptions: RequestInit = {
        method: provider.api === 'anthropic-messages' ? 'POST' : 'GET',
        headers,
        signal: controller.signal,
      }

      if (provider.api === 'anthropic-messages') {
        fetchOptions.body = JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'test' }],
        })
      }

      const response = await fetch(url, fetchOptions)

      if (response.ok) {
        return { success: true }
      }

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: 'Invalid API key' }
      }

      return { success: false, error: `API returned status ${response.status}` }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, error: 'Connection timed out (10s)' }
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      }
    } finally {
      clearTimeout(timeout)
    }
  })

  ipcMain.handle('provider:get-models', () => {
    return registry.getAvailableModels().map(({ provider, models }) => ({
      providerId: provider.id,
      providerName: provider.displayName,
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        toolUse: m.toolUse,
        reasoning: m.reasoning,
        supportsImageInput: Boolean(m.supportsImageInput),
        contextWindow: m.contextWindow,
      })),
    }))
  })

  ipcMain.handle('model:get-active', () => {
    return configService.getActiveModelId()
  })

  ipcMain.handle('model:set-active', async (_event, providerId: string, modelId: string) => {
    const modelKey = `${providerId}/${modelId}`
    configService.setActiveModel(modelKey)

    const agent = ensureAgentService()
    await agent.switchModel(providerId, modelId)

    mainWindow?.webContents.send('provider:config-changed')
  })

  ipcMain.handle('memory:list', () => {
    ensureAgentService()
    return memoryService?.listManageablePreferences() ?? []
  })

  ipcMain.handle('memory:update', (_event, input: PreferenceMemoryUpdateInput) => {
    if (!memoryService) {
      throw new Error('Memory service unavailable')
    }
    memoryService.updatePreference(input)
  })

  ipcMain.handle('memory:delete', (_event, id: string) => {
    if (!memoryService) {
      throw new Error('Memory service unavailable')
    }
    memoryService.deletePreference(id)
  })
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
  agentService?.destroy()
  memoryService?.destroy()
})
