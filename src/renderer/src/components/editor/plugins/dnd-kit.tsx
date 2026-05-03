'use client'

import { DndPlugin } from '@platejs/dnd'
import { BlockDraggable } from '@/components/ui/block-draggable'

export const DndKit = () => [
  DndPlugin.configure({
    render: {
      aboveNodes: ({ editor, element, path }) => {
        // Top-level blocks only — skip inline nodes and nested children.
        if (!path || path.length !== 1) return undefined
        if (editor.api.isInline(element)) return undefined
        return ({ children }) => <BlockDraggable element={element}>{children}</BlockDraggable>
      },
    },
  }),
]
