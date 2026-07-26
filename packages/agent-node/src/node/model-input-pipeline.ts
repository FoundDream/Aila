import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ChatMessage,
  type ModelCallExecutor,
  type ModelDescriptor,
  type ModelSelection,
  modelSupportsVision,
  type RunEventType,
  type Settings,
  type UserContentPart,
} from '@aila/agent'
import { type NodeAuthInput, requireApiKey } from './auth'
import { imageNameFromUrl } from './image-store'
import type { ModelRegistry } from './model-registry'
import type { ModelStreamUsage } from './model-stream'

const VISION_BRIDGE_SYSTEM_PROMPT =
  'You inspect image attachments for a downstream text-only model. ' +
  'Return concise, factual Markdown. Include visible text/OCR, important objects, layout, ' +
  'tables/charts/UI structure, and details that could matter for answering the user.'
const VISION_BRIDGE_PROMPT_VERSION = 1
const VISION_ANALYSIS_CACHE_SCHEMA_VERSION = 1

type RunEventEmitter = (type: RunEventType, data?: Record<string, unknown>) => void

export interface ModelInputPipelineInput {
  messages: ChatMessage[]
  descriptor: ModelDescriptor
  selection: ModelSelection
  settings: Settings
  modelRegistry: ModelRegistry
  modelCallExecutor: ModelCallExecutor
  authInput: NodeAuthInput
  signal: AbortSignal
  emitRunEvent: RunEventEmitter
  dataDir?: string
  imageDir?: string
}

export interface ModelInputPipelineResult {
  messages: ChatMessage[]
  usage: ModelStreamUsage[]
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Applies model capability fallbacks before the durable Agent loop begins. */
export async function prepareModelInput(
  input: ModelInputPipelineInput,
): Promise<ModelInputPipelineResult> {
  const imageMessageIndex = lastUserImageMessageIndex(input.messages)
  if (imageMessageIndex < 0 || modelSupportsVision(input.descriptor)) {
    return { messages: clone(input.messages), usage: [] }
  }

  const mode = input.settings.visionFallbackMode ?? 'auto'
  if (mode === 'disabled' || mode === 'ask') {
    return replaceImagesWithText(
      input.messages,
      mode === 'ask'
        ? 'Vision fallback is set to ask before analyzing images.'
        : 'Vision fallback is disabled.',
    )
  }

  const visionSelection = input.settings.defaultVisionModel
  if (!visionSelection) {
    throw new Error(
      `Model ${input.selection.providerId}:${input.selection.modelId} cannot inspect image attachments. Configure a Default Vision Model or choose a vision-capable chat model.`,
    )
  }

  const visionDescriptor = input.modelRegistry.resolve(visionSelection)
  if (!modelSupportsVision(visionDescriptor)) {
    throw new Error(
      `Default Vision Model ${visionSelection.providerId}:${visionSelection.modelId} is not marked as vision-capable.`,
    )
  }
  const visionApiKey = requireApiKey(visionDescriptor, {
    ...input.authInput,
    settings: input.settings,
  })
  const imageCount = latestImageCount(input.messages[imageMessageIndex])

  input.emitRunEvent('vision.bridge.started', {
    providerId: visionSelection.providerId,
    modelId: visionSelection.modelId,
    provider: visionDescriptor.provider,
    api: visionDescriptor.api,
    sourceProviderId: input.selection.providerId,
    sourceModelId: input.selection.modelId,
    imageCount,
  })

  const usage: ModelStreamUsage[] = []
  let cacheHitCount = 0
  let analyzedImageCount = 0
  const messages: ChatMessage[] = []
  try {
    for (const [index, message] of input.messages.entries()) {
      if (message.role !== 'user' || typeof message.content === 'string') {
        messages.push(clone(message))
        continue
      }
      if (index !== imageMessageIndex) {
        messages.push(replaceUserImagesWithText(message, 'Previous image is not re-analyzed.'))
        continue
      }
      messages.push({
        role: 'user',
        content: await analyzeUserImageParts({
          parts: message.content,
          visionDescriptor,
          visionApiKey,
          modelCallExecutor: input.modelCallExecutor,
          signal: input.signal,
          usage,
          dataDir: input.dataDir,
          imageDir: input.imageDir,
          onCacheHit: () => {
            cacheHitCount += 1
          },
          onAnalyzed: () => {
            analyzedImageCount += 1
          },
        }),
      })
    }
  } catch (error) {
    input.emitRunEvent('vision.bridge.failed', {
      providerId: visionSelection.providerId,
      modelId: visionSelection.modelId,
      provider: visionDescriptor.provider,
      api: visionDescriptor.api,
      imageCount,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  input.emitRunEvent('vision.bridge.completed', {
    providerId: visionSelection.providerId,
    modelId: visionSelection.modelId,
    provider: visionDescriptor.provider,
    api: visionDescriptor.api,
    imageCount,
    usageCount: usage.length,
    cacheHitCount,
    analyzedImageCount,
  })

  return { messages, usage }
}

async function analyzeUserImageParts(input: {
  parts: UserContentPart[]
  visionDescriptor: ModelDescriptor
  visionApiKey: string
  modelCallExecutor: ModelCallExecutor
  signal: AbortSignal
  usage: ModelStreamUsage[]
  dataDir?: string
  imageDir?: string
  onCacheHit?: () => void
  onAnalyzed?: () => void
}): Promise<string> {
  const textContext = input.parts
    .filter((part): part is Extract<UserContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
    .trim()
  const sections: string[] = []
  if (textContext) sections.push(textContext)

  let imageIndex = 0
  for (const part of input.parts) {
    if (part.type === 'text') continue
    imageIndex += 1
    const analysis = await analyzeImagePart({
      image: part,
      imageIndex,
      textContext,
      visionDescriptor: input.visionDescriptor,
      visionApiKey: input.visionApiKey,
      modelCallExecutor: input.modelCallExecutor,
      signal: input.signal,
      usage: input.usage,
      dataDir: input.dataDir,
      imageDir: input.imageDir,
    })
    if (analysis.cacheHit) input.onCacheHit?.()
    else input.onAnalyzed?.()
    sections.push(
      [
        `<image-analysis index="${imageIndex}" source="${escapeVisionAttribute(part.url)}" mime="${escapeVisionAttribute(part.mime)}">`,
        analysis.text,
        '</image-analysis>',
      ].join('\n'),
    )
  }

  return sections.join('\n\n')
}

async function analyzeImagePart(input: {
  image: Extract<UserContentPart, { type: 'image' }>
  imageIndex: number
  textContext: string
  visionDescriptor: ModelDescriptor
  visionApiKey: string
  modelCallExecutor: ModelCallExecutor
  signal: AbortSignal
  usage: ModelStreamUsage[]
  dataDir?: string
  imageDir?: string
}): Promise<{ text: string; cacheHit: boolean }> {
  const cache = await prepareVisionAnalysisCache({
    dataDir: input.dataDir,
    imageDir: input.imageDir,
    image: input.image,
    textContext: input.textContext,
    visionDescriptor: input.visionDescriptor,
  })
  if (cache?.cached) return { text: cache.cached.analysis, cacheHit: true }

  const prompt = [
    `Analyze image ${input.imageIndex} for a downstream text-only model.`,
    input.textContext ? `User/request context:\n${input.textContext}` : '',
    'Return only the image analysis. Do not answer the user directly.',
  ]
    .filter(Boolean)
    .join('\n\n')
  const result = await input.modelCallExecutor.execute({
    descriptor: input.visionDescriptor,
    apiKey: input.visionApiKey,
    messages: [
      { role: 'system', content: VISION_BRIDGE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }, clone(input.image)],
      },
    ],
    tools: [],
    signal: input.signal,
    stepIndex: -1,
    requireImages: true,
  })
  input.usage.push(...result.stepUsage)
  if (result.totalUsage) input.usage.push(result.totalUsage)
  if (result.outcome !== 'completed') {
    throw new Error(
      `Vision model failed to inspect image ${input.imageIndex}: ${result.error ?? result.outcome}`,
    )
  }

  const analysis = result.text.trim()
  const text = analysis || '[Vision model returned no image analysis.]'
  await cache?.write(text)
  return { text, cacheHit: false }
}

interface VisionAnalysisCacheFile {
  schemaVersion: typeof VISION_ANALYSIS_CACHE_SCHEMA_VERSION
  createdAt: number
  imageHash: string
  imageMime: string
  promptVersion: typeof VISION_BRIDGE_PROMPT_VERSION
  textContextHash: string
  visionProvider: string
  visionModelId: string
  analysis: string
}

async function prepareVisionAnalysisCache(input: {
  dataDir?: string
  imageDir?: string
  image: Extract<UserContentPart, { type: 'image' }>
  textContext: string
  visionDescriptor: ModelDescriptor
}): Promise<{
  cached?: VisionAnalysisCacheFile
  write: (analysis: string) => Promise<void>
} | null> {
  if (!input.dataDir || !input.imageDir) return null
  const imageHash = await hashImageFile(input.image, input.imageDir)
  const textContextHash = sha256(input.textContext)
  const key = sha256(
    JSON.stringify({
      imageHash,
      imageMime: input.image.mime,
      promptVersion: VISION_BRIDGE_PROMPT_VERSION,
      textContextHash,
      visionProvider: input.visionDescriptor.provider,
      visionModelId: input.visionDescriptor.modelId,
    }),
  )
  const cacheDir = join(input.dataDir, 'vision-analysis')
  const cachePath = join(cacheDir, `${key}.json`)
  const cached = await readVisionAnalysisCache(cachePath)
  return {
    ...(cached ? { cached } : {}),
    write: async (analysis: string) => {
      await mkdir(cacheDir, { recursive: true })
      const record: VisionAnalysisCacheFile = {
        schemaVersion: VISION_ANALYSIS_CACHE_SCHEMA_VERSION,
        createdAt: Date.now(),
        imageHash,
        imageMime: input.image.mime,
        promptVersion: VISION_BRIDGE_PROMPT_VERSION,
        textContextHash,
        visionProvider: input.visionDescriptor.provider,
        visionModelId: input.visionDescriptor.modelId,
        analysis,
      }
      await writeFile(cachePath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8')
    },
  }
}

async function hashImageFile(
  image: Extract<UserContentPart, { type: 'image' }>,
  imageDir: string,
): Promise<string> {
  const name = imageNameFromUrl(image.url)
  if (!name) throw new Error(`Unable to load attached image ${image.url}: unrecognized image url`)
  try {
    return sha256(await readFile(join(imageDir, name)))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to load attached image ${image.url}: ${detail}`)
  }
}

async function readVisionAnalysisCache(path: string): Promise<VisionAnalysisCacheFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<VisionAnalysisCacheFile>
    if (
      parsed.schemaVersion !== VISION_ANALYSIS_CACHE_SCHEMA_VERSION ||
      typeof parsed.analysis !== 'string' ||
      !parsed.analysis.trim()
    ) {
      return null
    }
    return parsed as VisionAnalysisCacheFile
  } catch {
    return null
  }
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function replaceImagesWithText(messages: ChatMessage[], reason: string): ModelInputPipelineResult {
  return {
    messages: messages.map((message) => {
      if (message.role !== 'user' || typeof message.content === 'string') {
        return clone(message)
      }
      return replaceUserImagesWithText(message, reason)
    }),
    usage: [],
  }
}

function replaceUserImagesWithText(
  message: Extract<ChatMessage, { role: 'user' }>,
  reason: string,
): ChatMessage {
  if (typeof message.content === 'string') return clone(message)
  const sections = message.content.map((part) =>
    part.type === 'text'
      ? part.text
      : `[Attached image omitted: ${reason} The image was not inspected; do not describe or infer its visual contents. Source: ${part.url}; MIME: ${part.mime}.]`,
  )
  return { role: 'user', content: sections.filter(Boolean).join('\n\n') }
}

function lastUserImageMessageIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message?.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image')
    ) {
      return index
    }
  }
  return -1
}

function latestImageCount(message: ChatMessage | undefined): number {
  if (!message || message.role !== 'user' || typeof message.content === 'string') return 0
  return message.content.filter((part) => part.type === 'image').length
}

function escapeVisionAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
