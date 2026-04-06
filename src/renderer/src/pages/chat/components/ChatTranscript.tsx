import type { ReactElement } from 'react'
import { useCallback, useRef } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

import { EmptyState } from '@/pages/chat/components/EmptyState'
import { MessageRow } from '@/pages/chat/components/MessageRow'
import type { Message } from '@/types/chat'

const FOLLOW_OUTPUT_THRESHOLD = 120

export function ChatTranscript({
  isStreaming,
  messages,
}: {
  isStreaming: boolean
  messages: Message[]
}): ReactElement {
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      if (isAtBottom || isStreaming) return 'smooth'
      return false
    },
    [isStreaming],
  )

  const renderItem = useCallback(
    (_index: number, message: Message) => (
      <div className="pb-4">
        <MessageRow
          message={message}
          isStreaming={isStreaming && message.role === 'assistant' && message.status === 'streaming'}
        />
      </div>
    ),
    [isStreaming],
  )

  if (messages.length === 0) {
    return (
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 [scrollbar-gutter:stable]">
        <EmptyState />
      </main>
    )
  }

  return (
    <Virtuoso
      ref={virtuosoRef}
      className="flex-1 [scrollbar-gutter:stable]"
      data={messages}
      initialTopMostItemIndex={messages.length - 1}
      followOutput={followOutput}
      atBottomThreshold={FOLLOW_OUTPUT_THRESHOLD}
      overscan={{ main: 600, reverse: 600 }}
      increaseViewportBy={{ top: 400, bottom: 400 }}
      itemContent={renderItem}
      components={{
        List: ListContainer,
        Item: ItemContainer,
      }}
    />
  )
}

function ListContainer({
  style,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div
      {...props}
      style={style}
      className="mx-auto w-full max-w-3xl px-4 pt-4"
    >
      {children}
    </div>
  )
}

function ItemContainer({ children, ...props }: React.HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div {...props}>{children}</div>
}
