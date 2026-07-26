import { type ReactElement, useEffect, useState } from 'react'

interface AiEditToastProps {
  // Bumps each time an AI edit is applied; toast fades out after a delay.
  // null means hidden. The string content describes what just happened.
  message: string | null
  onDismiss: () => void
}

const DISMISS_MS = 2400

export function AiEditToast({ message, onDismiss }: AiEditToastProps): ReactElement | null {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!message) {
      setVisible(false)
      return
    }
    setVisible(true)
    const t = setTimeout(() => {
      setVisible(false)
      // Give the fade transition a beat before clearing parent state.
      setTimeout(onDismiss, 200)
    }, DISMISS_MS)
    return () => clearTimeout(t)
  }, [message, onDismiss])

  if (!message) return null

  return (
    <div
      className={`pointer-events-none fixed bottom-6 left-6 z-50 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12px] text-[var(--text-soft)] shadow-sm transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
      <span>{message}</span>
      <span className="text-[var(--text-dim)]">·</span>
      <span className="text-[var(--text-dim)]">⌘Z to undo</span>
    </div>
  )
}
