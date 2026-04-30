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

  const canSend = !isStreaming && value.trim().length > 0

  return (
    <div className="shrink-0 px-8 pb-8 pt-2">
      <div className="mx-auto max-w-[680px]">
        <div className="flex items-end gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 transition-colors focus-within:border-[var(--border-strong)]">
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? 'Generating…' : 'Ask anything'}
            rows={1}
            className="min-h-[24px] max-h-[200px] flex-1 resize-none bg-transparent text-[15px] leading-[1.6] text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onAbort}
              className="h-7 shrink-0 rounded-md px-3 text-xs text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              className="h-7 shrink-0 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-[var(--accent-fg)] transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
            >
              Send
            </button>
          )}
        </div>
        <p
          className="mt-2 text-center text-[11px] italic text-[var(--text-dim)]"
          style={{ fontFamily: 'var(--font-serif)' }}
        >
          {isStreaming
            ? 'Press Stop to interrupt.'
            : 'Press Enter to send · Shift + Enter for newline'}
        </p>
      </div>
    </div>
  )
}
