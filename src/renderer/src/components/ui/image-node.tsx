'use client'

import type { TImageElement } from 'platejs'
import {
  PlateElement,
  type PlateElementProps,
  useEditorRef,
  useReadOnly,
  useSelected,
} from 'platejs/react'
import { type PointerEvent as ReactPointerEvent, useCallback, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const MIN_WIDTH = 80
const MAX_WIDTH = 760

type ImageNode = TImageElement & {
  url?: string
  alt?: string
  width?: number
}

export function ImageElement(props: PlateElementProps<TImageElement>) {
  const editor = useEditorRef()
  const selected = useSelected()
  const readOnly = useReadOnly()

  const node = props.element as ImageNode
  const url = typeof node.url === 'string' ? node.url : undefined
  const alt = typeof node.alt === 'string' ? node.alt : ''
  const persistedWidth = typeof node.width === 'number' ? node.width : undefined

  const [width, setWidth] = useState<number | undefined>(persistedWidth)
  const figureRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (readOnly) return
      event.preventDefault()
      event.stopPropagation()
      const handle = event.currentTarget
      const measured = figureRef.current?.getBoundingClientRect().width ?? 0
      dragRef.current = {
        startX: event.clientX,
        startW: width ?? measured,
      }
      handle.setPointerCapture(event.pointerId)
    },
    [readOnly, width],
  )

  const onResizeMove = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const next = Math.max(
      MIN_WIDTH,
      Math.min(MAX_WIDTH, drag.startW + (event.clientX - drag.startX)),
    )
    setWidth(next)
  }, [])

  const onResizeEnd = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (!dragRef.current) return
      event.currentTarget.releasePointerCapture(event.pointerId)
      dragRef.current = null
      const path = editor.api.findPath(props.element)
      if (path && width !== undefined) {
        editor.tf.setNodes({ width } as Partial<ImageNode>, { at: path })
      }
    },
    [editor, props.element, width],
  )

  const onAltChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const path = editor.api.findPath(props.element)
      if (path) {
        editor.tf.setNodes({ alt: event.target.value } as Partial<ImageNode>, { at: path })
      }
    },
    [editor, props.element],
  )

  return (
    <PlateElement {...props} className="my-3">
      <figure
        ref={figureRef}
        contentEditable={false}
        className={cn(
          'group/image relative inline-block max-w-full select-none align-top',
          selected && 'ring-2 ring-[var(--brand,#3b82f6)] ring-offset-2',
        )}
        style={width !== undefined ? { width } : undefined}
      >
        {url ? (
          <img
            src={url}
            alt={alt}
            className="block h-auto w-full rounded-md"
            draggable={false}
          />
        ) : (
          <div className="flex h-32 w-full items-center justify-center rounded-md border border-dashed border-[var(--border)] text-sm text-[var(--text-dim)]">
            Loading…
          </div>
        )}
        {!readOnly && url && (
          <span
            role="separator"
            aria-orientation="vertical"
            className="absolute top-1/2 right-[-6px] z-10 h-12 w-2 -translate-y-1/2 cursor-ew-resize rounded-full bg-[var(--brand,#3b82f6)] opacity-0 transition-opacity group-hover/image:opacity-80"
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
          />
        )}
      </figure>
      {!readOnly && selected && url && (
        <input
          contentEditable={false}
          value={alt}
          onChange={onAltChange}
          placeholder="Alt text"
          className="mt-1 block w-full max-w-[760px] bg-transparent text-[12px] text-[var(--text-dim)] outline-none placeholder:text-[var(--text-dim)]"
        />
      )}
      {props.children}
    </PlateElement>
  )
}
