import type { ReactElement } from 'react'
import { SessionList } from '@/components/chat/SessionList'

export function HeaderBar({
  onNewSession,
  onSettingsClick,
  onResumeSession,
  onDeleteSession,
  currentSessionPath,
}: {
  onNewSession?: () => void
  onSettingsClick: () => void
  onResumeSession?: (sessionPath: string) => void
  onDeleteSession?: (sessionPath: string) => void
  currentSessionPath?: string | null
}): ReactElement {
  return (
    <header className="flex items-center gap-3 border-b border-[#2a2a2a] px-4 py-2 pl-20 text-xs [-webkit-app-region:drag] select-none">
      <div className="ml-auto flex items-center gap-2 [-webkit-app-region:no-drag]">
        {onResumeSession && onDeleteSession && (
          <SessionList
            onResume={onResumeSession}
            onDelete={onDeleteSession}
            currentSessionPath={currentSessionPath ?? null}
          />
        )}

        <button
          type="button"
          onClick={onSettingsClick}
          className="rounded p-1.5 text-[#666] transition hover:bg-[#1e1e1e] hover:text-[#ccc]"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>

        {onNewSession && (
          <button
            type="button"
            onClick={onNewSession}
            className="rounded px-2.5 py-1 text-[11px] text-[#666] transition hover:bg-[#1e1e1e] hover:text-[#ccc]"
          >
            + new
          </button>
        )}
      </div>
    </header>
  )
}
