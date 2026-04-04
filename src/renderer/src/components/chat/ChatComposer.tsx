import {
  type CSSProperties,
  type KeyboardEventHandler,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { ModelSelector } from '@/components/settings/ModelSelector'
import type { QueuedPromptDraft } from '@/types/chat'

export function ChatComposer({
  input,
  isStreaming,
  queuedCount,
  queuedPrompts,
  onAbort,
  onChange,
  onEditQueuedPrompt,
  onKeyDown,
  onRemoveQueuedPrompt,
  onSettingsClick,
  onSubmit,
}: {
  input: string
  isStreaming: boolean
  queuedCount: number
  queuedPrompts: QueuedPromptDraft[]
  onAbort: () => void | Promise<void>
  onChange: (value: string) => void
  onEditQueuedPrompt: (promptId: string) => void
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>
  onRemoveQueuedPrompt: (promptId: string) => void
  onSettingsClick: () => void
  onSubmit: () => void | Promise<void>
}): ReactElement {
  const hasInput = input.trim().length > 0
  const [isTyping, setIsTyping] = useState(false)
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const prevInputRef = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)

  // Detect appended text so only new chars animate
  const prevInput = prevInputRef.current
  const isAppend = input.length > prevInput.length && input.startsWith(prevInput)
  const animateFrom = isAppend ? prevInput.length : input.length

  useEffect(() => {
    prevInputRef.current = input
  }, [input])

  const handleChange = useCallback(
    (value: string) => {
      onChange(value)
      setIsTyping(true)
      typingTimer.current && clearTimeout(typingTimer.current)
      typingTimer.current = setTimeout(() => setIsTyping(false), 600)
    },
    [onChange],
  )

  const handleScroll = useCallback(() => {
    if (textareaRef.current && mirrorRef.current) {
      mirrorRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [])

  const handleEditQueued = useCallback(
    (promptId: string) => {
      onEditQueuedPrompt(promptId)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [onEditQueuedPrompt],
  )

  return (
    <div className="px-4 pb-5 pt-2">
      <div className="mx-auto max-w-3xl">
        <div className={`composer-wrapper${isTyping ? ' is-typing' : ''}`}>
          <div className="composer-inner rounded-lg bg-[var(--term-surface)]">
            <div className="composer-toolbar flex min-w-0 items-center gap-3 px-3 py-2">
              <ModelSelector onSettingsClick={onSettingsClick} variant="composer" />
              {queuedCount > 0 && (
                <span className="hidden shrink-0 text-[11px] text-[var(--term-dim)] sm:inline">
                  {queuedCount} queued
                </span>
              )}
            </div>

            {queuedPrompts.length > 0 && (
              <div className="px-3 pb-1">
                <div className="space-y-1.5">
                  {queuedPrompts.map((prompt) => (
                    <div
                      key={prompt.id}
                      className="queued-draft-card flex items-center gap-2 px-0.5 py-0.5 text-[12px] text-[var(--term-text)]"
                    >
                      <span className="shrink-0 text-[11px] text-[var(--term-dim)]">↳</span>
                      <div
                        className="min-w-0 flex-1 truncate text-[12px] leading-[1.4]"
                        title={prompt.text}
                      >
                        {prompt.text}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          className="rounded px-1 py-0.5 text-[11px] text-[var(--term-dim)] transition hover:text-[var(--term-text)]"
                          onClick={() => handleEditQueued(prompt.id)}
                          title="Edit queued prompt"
                        >
                          edit
                        </button>
                        <button
                          type="button"
                          className="rounded px-1 py-0.5 text-[11px] text-[var(--term-dim)] transition hover:text-[var(--term-red)]"
                          onClick={() => onRemoveQueuedPrompt(prompt.id)}
                          title="Remove queued prompt"
                        >
                          remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-end gap-2 px-3 py-2">
              <div className="relative min-w-0 flex-1">
                {/* Real textarea — text transparent, caret visible */}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => handleChange(e.target.value)}
                  onKeyDown={onKeyDown}
                  onScroll={handleScroll}
                  placeholder={isStreaming ? 'queue another message' : 'type here'}
                  rows={1}
                  className="max-h-[120px] min-h-[20px] w-full resize-none bg-transparent p-0 text-[13px] text-transparent caret-[var(--term-blue)] outline-none placeholder:text-[var(--term-dim)]"
                  style={{ fieldSizing: 'content' } as CSSProperties}
                />

                {/* Mirror overlay — renders animated characters */}
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

              <div className="flex shrink-0 items-center gap-2">
                {isStreaming && (
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-[11px] text-[var(--term-red)] transition hover:bg-[var(--term-surface-soft)]"
                    onClick={onAbort}
                    title="Stop"
                  >
                    stop
                  </button>
                )}
                <button
                  type="button"
                  className={`rounded px-2 py-1 text-[11px] transition ${
                    hasInput
                      ? 'text-[var(--term-blue)] hover:bg-[var(--term-surface-soft)]'
                      : 'text-[var(--term-dim)]'
                  }`}
                  onClick={onSubmit}
                  disabled={!hasInput}
                  title="Send"
                >
                  enter
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
