import { type KeyboardEvent, type ReactElement, useCallback, useState } from 'react'

interface ComposerProps {
  isStreaming: boolean
  onSubmit: (text: string) => Promise<void> | void
  onAbort: () => void
}

export function Composer({ isStreaming, onSubmit, onAbort }: ComposerProps): ReactElement {
  const [value, setValue] = useState('')

  const submit = useCallback(async () => {
    if (isStreaming) return
    const text = value
    if (!text.trim()) return
    setValue('')
    await onSubmit(text)
  }, [value, isStreaming, onSubmit])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        void submit()
      }
    },
    [submit],
  )

  return (
    <div className="shrink-0 border-t border-[var(--term-border)] bg-[var(--term-panel)] px-6 py-3">
      <div className="mx-auto flex max-w-2xl items-end gap-2">
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isStreaming ? 'Generating…' : 'Send a message (Enter to send, Shift+Enter for newline)'
          }
          rows={2}
          className="min-h-[40px] flex-1 resize-none rounded-md border border-[var(--term-border)] bg-[var(--term-surface)] px-3 py-2 text-sm text-[var(--term-text)] outline-none focus:border-[var(--term-border-strong)]"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onAbort}
            className="h-10 shrink-0 rounded-md border border-[var(--term-border)] bg-[var(--term-surface)] px-3 text-xs text-[var(--term-text-soft)] hover:border-[var(--term-border-strong)] hover:text-[var(--term-text)]"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!value.trim()}
            className="h-10 shrink-0 rounded-md bg-[var(--term-blue)] px-4 text-xs font-semibold text-white hover:bg-[var(--term-blue-strong)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
