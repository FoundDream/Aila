'use client'

import { useDraggable, useDropLine } from '@platejs/dnd'
import { GripVertical } from 'lucide-react'
import type { TElement } from 'platejs'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface BlockDraggableProps {
  element: TElement
  children: ReactNode
}

export function BlockDraggable({ element, children }: BlockDraggableProps) {
  const state = useDraggable({ element })
  const { dropLine } = useDropLine({ id: element.id as string | undefined })

  if (!state.nodeRef) {
    return <>{children}</>
  }

  return (
    <div
      ref={state.nodeRef}
      className={cn(
        'group/block-dnd relative -ml-8 pl-8',
        state.isDragging && 'opacity-40',
      )}
    >
      <span
        ref={state.handleRef}
        contentEditable={false}
        aria-label="Drag block"
        className={cn(
          'absolute top-1.5 left-0 z-10 hidden h-5 w-5 cursor-grab items-center justify-center rounded-sm text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] active:cursor-grabbing group-hover/block-dnd:flex',
        )}
      >
        <GripVertical size={14} />
      </span>
      {dropLine === 'top' && (
        <div className="pointer-events-none absolute -top-px right-0 left-8 h-0.5 bg-[var(--brand,#3b82f6)]" />
      )}
      {children}
      {dropLine === 'bottom' && (
        <div className="pointer-events-none absolute -bottom-px right-0 left-8 h-0.5 bg-[var(--brand,#3b82f6)]" />
      )}
    </div>
  )
}
