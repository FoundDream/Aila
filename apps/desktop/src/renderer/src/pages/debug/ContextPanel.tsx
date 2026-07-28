import { ChevronDownIcon, MinusIcon, PlusIcon } from 'lucide-react'
import { type ReactElement, useState } from 'react'
import type { ChatMessage } from '../../types'
import type { InjectedContextMode, InjectedContextState } from './playgroundState'

interface ContextPanelProps {
  injected: InjectedContextState
  onChange: (injected: InjectedContextState) => void
}

type EditableRole = 'system' | 'user' | 'assistant'

function rowContent(message: ChatMessage): string {
  return 'content' in message ? message.content : ''
}

function rowRole(message: ChatMessage): EditableRole {
  return message.role === 'tool' ? 'system' : message.role
}

function makeRow(role: EditableRole, content: string): ChatMessage {
  return role === 'assistant' ? { role, content } : { role, content }
}

/**
 * Per-run injected context (the llm-space "Variables/System prompt" analogue
 * within v1 reach): overrides the host's workspace context for runs started
 * from the playground. Local-only state — verify the effect in the run's
 * model_request payload.
 */
export function ContextPanel({ injected, onChange }: ContextPanelProps): ReactElement {
  const [expanded, setExpanded] = useState(false)

  const summary =
    injected.mode === 'default'
      ? 'Default (workspace context)'
      : injected.mode === 'cleared'
        ? 'Cleared (no injected context)'
        : `Override · ${injected.messages.length} ${injected.messages.length === 1 ? 'message' : 'messages'}`

  const setMode = (mode: InjectedContextMode): void => {
    onChange({ ...injected, mode })
  }
  const updateRow = (index: number, patch: { role?: EditableRole; content?: string }): void => {
    const messages = injected.messages.map((message, currentIndex) =>
      currentIndex === index
        ? makeRow(patch.role ?? rowRole(message), patch.content ?? rowContent(message))
        : message,
    )
    onChange({ ...injected, messages })
  }

  return (
    <section className="shrink-0 border-t border-[var(--border)] bg-[var(--bg)] px-4 py-1.5">
      <div className="mx-auto w-full max-w-[1080px]">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-[var(--surface-hover)]"
        >
          <span className="text-[10.5px] font-semibold text-[var(--text-soft)]">
            Injected context
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[9.5px] font-medium ${
              injected.mode === 'default'
                ? 'bg-[var(--bg-soft)] text-[var(--text-dim)]'
                : 'bg-[var(--warning-soft)] text-[var(--warning)]'
            }`}
          >
            {summary}
          </span>
          <ChevronDownIcon
            className={`ml-auto size-3.5 text-[var(--text-dim)] transition-transform ${
              expanded ? '' : '-rotate-90'
            }`}
          />
        </button>

        {expanded && (
          <div className="pb-2 pt-1">
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg bg-[var(--bg-soft)] p-0.5">
                {(
                  [
                    ['default', 'Default'],
                    ['override', 'Override'],
                    ['cleared', 'Cleared'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setMode(mode)}
                    className={`rounded-md px-2.5 py-1 text-[10.5px] font-medium transition-colors ${
                      injected.mode === mode
                        ? 'bg-[var(--bg)] text-[var(--text)] shadow-[var(--shadow-xs)]'
                        : 'text-[var(--text-dim)] hover:text-[var(--text-soft)]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-[var(--text-dim)]">
                Applies to runs started from the playground; replaces the workspace context for that
                run. Verify in the run's model_request payload.
              </p>
            </div>

            {injected.mode === 'override' && (
              <div className="mt-2 space-y-1.5">
                {injected.messages.map((message, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional editors
                    key={index}
                    className="flex items-start gap-1.5"
                  >
                    <select
                      value={rowRole(message)}
                      onChange={(event) =>
                        updateRow(index, { role: event.target.value as EditableRole })
                      }
                      className="h-7 shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[10.5px] text-[var(--text-soft)] focus:outline-none"
                    >
                      <option value="system">system</option>
                      <option value="user">user</option>
                      <option value="assistant">assistant</option>
                    </select>
                    <textarea
                      value={rowContent(message)}
                      onChange={(event) => updateRow(index, { content: event.target.value })}
                      rows={Math.min(6, Math.max(1, rowContent(message).split('\n').length))}
                      placeholder="Context message content"
                      className="block min-h-7 flex-1 resize-y rounded-md border border-[var(--border)] bg-[var(--textarea)] px-2 py-1 text-[11.5px] leading-relaxed text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--border-strong)] focus:outline-none"
                    />
                    <button
                      type="button"
                      aria-label="Remove context message"
                      onClick={() =>
                        onChange({
                          ...injected,
                          messages: injected.messages.filter(
                            (_, currentIndex) => currentIndex !== index,
                          ),
                        })
                      }
                      className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--error)]"
                    >
                      <MinusIcon className="size-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      ...injected,
                      messages: [...injected.messages, makeRow('system', '')],
                    })
                  }
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-[var(--border-strong)] px-2 text-[10.5px] font-medium text-[var(--text-dim)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text)]"
                >
                  <PlusIcon className="size-3" />
                  Add context message
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
