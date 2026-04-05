import type { ReactElement, RefObject } from 'react'

import { EmptyState } from '@/pages/chat/components/EmptyState'
import { MessageRow } from '@/pages/chat/components/MessageRow'
import type { Message } from '@/types/chat'

export function ChatTranscript({
  isStreaming,
  messages,
  scrollRef,
}: {
  isStreaming: boolean
  messages: Message[]
  scrollRef: RefObject<HTMLDivElement | null>
}): ReactElement {
  return (
    <main
      ref={scrollRef}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 [scrollbar-gutter:stable]"
    >
      {messages.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mx-auto w-full max-w-3xl">
          <div className="space-y-4">
            {messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                isStreaming={
                  isStreaming && message.role === 'assistant' && message.status === 'streaming'
                }
              />
            ))}
          </div>
        </div>
      )}
    </main>
  )
}
