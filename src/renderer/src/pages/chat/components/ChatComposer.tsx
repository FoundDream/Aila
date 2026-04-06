import {
  type ChangeEvent,
  type ClipboardEventHandler,
  type CSSProperties,
  type DragEventHandler,
  type KeyboardEventHandler,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import { Button } from '@/components/Button'
import { ImageAttachmentStrip } from '@/pages/chat/components/ImageAttachmentStrip'
import { ModelSelector } from '@/pages/chat/components/ModelSelector'
import type { ImageAttachment, PromptDraftValue, QueuedPromptDraft } from '@/types/chat'

function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error(`Failed to read ${file.name}`))
        return
      }

      const commaIndex = result.indexOf(',')
      if (commaIndex === -1) {
        reject(new Error(`Invalid image data for ${file.name}`))
        return
      }

      resolve({
        id: `img-${crypto.randomUUID()}`,
        name: file.name,
        mimeType: file.type || 'image/png',
        data: result.slice(commaIndex + 1),
      })
    }
    reader.readAsDataURL(file)
  })
}

async function extractImageAttachments(files: Iterable<File>): Promise<ImageAttachment[]> {
  const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'))
  return await Promise.all(imageFiles.map(fileToImageAttachment))
}

function formatQueuedPromptLabel(prompt: QueuedPromptDraft): string {
  const text = prompt.text.trim()
  const imageCount = prompt.images.length

  if (text && imageCount > 0) {
    return `${text} · ${imageCount} image${imageCount === 1 ? '' : 's'}`
  }

  if (text) {
    return text
  }

  return `${imageCount} image${imageCount === 1 ? '' : 's'}`
}

export function ChatComposer({
  activeModelSupportsImages,
  isStreaming,
  queuedCount,
  queuedPrompts,
  onAbort,
  onEditQueuedPrompt,
  onRemoveQueuedPrompt,
  onSettingsClick,
  onSubmit,
}: {
  activeModelSupportsImages: boolean
  isStreaming: boolean
  queuedCount: number
  queuedPrompts: QueuedPromptDraft[]
  onAbort: () => void | Promise<void>
  onEditQueuedPrompt: (
    promptId: string,
    currentDraft: PromptDraftValue,
  ) => Promise<PromptDraftValue | null>
  onRemoveQueuedPrompt: (promptId: string) => void | Promise<void>
  onSettingsClick: () => void
  onSubmit: (draft: PromptDraftValue) => boolean | Promise<boolean>
}): ReactElement {
  const [input, setInput] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const hasDraft = input.trim().length > 0 || images.length > 0
  const canSubmit = hasDraft && (activeModelSupportsImages || images.length === 0)
  const [isTyping, setIsTyping] = useState(false)
  const [isDraggingImages, setIsDraggingImages] = useState(false)
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const prevInputRef = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const prevInput = prevInputRef.current
  const isAppend = input.length > prevInput.length && input.startsWith(prevInput)
  const animateFrom = isAppend ? prevInput.length : input.length

  useEffect(() => {
    prevInputRef.current = input
  }, [input])

  useEffect(() => {
    return () => {
      if (typingTimer.current) {
        clearTimeout(typingTimer.current)
      }
    }
  }, [])

  const handleChange = useCallback((value: string) => {
    setInput(value)
    setIsTyping(true)
    typingTimer.current && clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(() => setIsTyping(false), 600)
  }, [])

  const handleScroll = useCallback(() => {
    if (textareaRef.current && mirrorRef.current) {
      mirrorRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [])

  const appendImages = useCallback((nextImages: ImageAttachment[]) => {
    if (nextImages.length === 0) {
      return
    }

    setImages((current) => [...current, ...nextImages])
  }, [])

  const handlePickImages = useCallback(
    async (files: Iterable<File>) => {
      const nextImages = await extractImageAttachments(files)
      appendImages(nextImages)
    },
    [appendImages],
  )

  const handleSubmit = useCallback(async () => {
    if (images.length > 0 && !activeModelSupportsImages) {
      return
    }

    const submitted = await onSubmit({ text: input, images })
    if (!submitted) {
      return
    }

    setInput('')
    setImages([])
    prevInputRef.current = ''
  }, [activeModelSupportsImages, images, input, onSubmit])

  const handleKeyDown = useCallback<KeyboardEventHandler<HTMLTextAreaElement>>(
    (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        void handleSubmit()
      }
    },
    [handleSubmit],
  )

  const handlePaste = useCallback<ClipboardEventHandler<HTMLTextAreaElement>>(
    (event) => {
      if (!activeModelSupportsImages) {
        return
      }

      const files = Array.from(event.clipboardData.files)
      if (!files.some((file) => file.type.startsWith('image/'))) {
        return
      }

      event.preventDefault()
      void handlePickImages(files)
    },
    [activeModelSupportsImages, handlePickImages],
  )

  const handleDragEnter = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      if (!activeModelSupportsImages) {
        return
      }

      const hasImages = Array.from(event.dataTransfer.items).some((item) =>
        item.type.startsWith('image/'),
      )
      if (!hasImages) {
        return
      }

      event.preventDefault()
      setIsDraggingImages(true)
    },
    [activeModelSupportsImages],
  )

  const handleDragOver = useCallback<DragEventHandler<HTMLDivElement>>((event) => {
    const hasImages = Array.from(event.dataTransfer.items).some((item) =>
      item.type.startsWith('image/'),
    )
    if (!hasImages) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback<DragEventHandler<HTMLDivElement>>((event) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return
    }

    setIsDraggingImages(false)
  }, [])

  const handleDrop = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      setIsDraggingImages(false)
      if (!activeModelSupportsImages) {
        return
      }

      const files = Array.from(event.dataTransfer.files)
      if (!files.some((file) => file.type.startsWith('image/'))) {
        return
      }

      event.preventDefault()
      void handlePickImages(files)
    },
    [activeModelSupportsImages, handlePickImages],
  )

  const handleEditQueued = useCallback(
    async (promptId: string) => {
      const nextInput = await onEditQueuedPrompt(promptId, { text: input, images })
      if (nextInput === null) {
        return
      }

      setInput(nextInput.text)
      setImages(nextInput.images)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [images, input, onEditQueuedPrompt],
  )

  const handleSelectImages = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileInputChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files) {
        await handlePickImages(Array.from(event.target.files))
      }
      event.target.value = ''
    },
    [handlePickImages],
  )

  const handleRemoveImage = useCallback((index: number) => {
    setImages((current) => current.filter((_, currentIndex) => currentIndex !== index))
  }, [])

  return (
    <div className="px-4 pb-5 pt-2">
      <div className="mx-auto max-w-3xl">
        <div
          className={`composer-wrapper${isTyping ? ' is-typing' : ''}${
            isDraggingImages
              ? ' ring-1 ring-[var(--term-blue)] ring-offset-2 ring-offset-[var(--term-bg)]'
              : ''
          }`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="composer-inner rounded-lg bg-[var(--term-surface)]">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => void handleFileInputChange(event)}
            />

            <div className="px-3 pb-1 pt-3">
              {images.length > 0 && (
                <div className="mb-3">
                  <ImageAttachmentStrip
                    images={images}
                    onRemove={handleRemoveImage}
                    size="composer"
                  />
                </div>
              )}

              <div className="relative min-w-0 flex-1">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(event) => handleChange(event.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  onScroll={handleScroll}
                  placeholder={isStreaming ? 'queue another message' : 'type here'}
                  rows={1}
                  className="max-h-[120px] min-h-[20px] w-full resize-none bg-transparent p-0 text-[13px] text-transparent caret-[var(--term-blue)] outline-none placeholder:text-[var(--term-dim)]"
                  style={{ fieldSizing: 'content' } as CSSProperties}
                />

                {input.length > 0 && (
                  <div
                    ref={mirrorRef}
                    className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[13px] leading-[1.6] text-[var(--term-text)]"
                    aria-hidden="true"
                  >
                    <span>{input.slice(0, animateFrom)}</span>
                    {animateFrom < input.length && (
                      <span key={animateFrom} className="char-new">
                        {input.slice(animateFrom)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {queuedPrompts.length > 0 && (
              <div className="px-5 pb-2 sm:px-6">
                <div className="space-y-1.5">
                  {queuedPrompts.map((prompt) => (
                    <div
                      key={prompt.id}
                      className="queued-draft-card flex items-center gap-2 rounded-2xl border border-[var(--term-border)] bg-[var(--term-surface-soft)] px-3 py-2 text-[12px] text-[var(--term-text)]"
                    >
                      <span className="shrink-0 text-[11px] text-[var(--term-dim)]">↳</span>
                      <div
                        className="min-w-0 flex-1 truncate text-[12px] leading-[1.4]"
                        title={formatQueuedPromptLabel(prompt)}
                      >
                        {formatQueuedPromptLabel(prompt)}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <Button
                          type="button"
                          variant="quiet"
                          size="xs"
                          onClick={() => void handleEditQueued(prompt.id)}
                          title="Edit queued prompt"
                        >
                          edit
                        </Button>
                        <Button
                          type="button"
                          variant="quietDanger"
                          size="xs"
                          onClick={() => void onRemoveQueuedPrompt(prompt.id)}
                          title="Remove queued prompt"
                        >
                          remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="composer-footer flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0 max-w-[min(46%,18rem)] shrink">
                <ModelSelector onSettingsClick={onSettingsClick} variant="composer" />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="quiet"
                  size="xs"
                  onClick={handleSelectImages}
                  disabled={!activeModelSupportsImages}
                  title={
                    activeModelSupportsImages
                      ? 'Attach images'
                      : 'The current model does not support image input'
                  }
                >
                  image
                </Button>
                {queuedCount > 0 && (
                  <span className="hidden shrink-0 text-[11px] text-[var(--term-dim)] sm:inline">
                    {queuedCount} queued
                  </span>
                )}
                {isStreaming && (
                  <Button
                    type="button"
                    variant="dangerGhost"
                    size="xs"
                    onClick={onAbort}
                    title="Stop"
                  >
                    stop
                  </Button>
                )}
                <Button
                  type="button"
                  variant={canSubmit ? 'ghost' : 'quiet'}
                  size="xs"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit}
                  title={
                    images.length > 0 && !activeModelSupportsImages
                      ? 'Switch to a vision-capable model to send images'
                      : 'Send'
                  }
                >
                  enter
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
