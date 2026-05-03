'use client'

import { ImageIcon } from 'lucide-react'
import { type Path, PathApi } from 'platejs'
import { useEditorRef } from 'platejs/react'
import type * as React from 'react'

import { pickImageFiles } from '@/components/editor/plugins/media-kit'
import { ToolbarButton } from './toolbar'

export function ImageToolbarButton(props: React.ComponentProps<typeof ToolbarButton>) {
  const editor = useEditorRef()

  const onClick = (): void => {
    const block = editor.api.block()
    const insertAt: Path | undefined = block ? PathApi.next(block[1]) : undefined

    void (async () => {
      const files = await pickImageFiles()
      if (!files) return
      const insert = (
        editor.tf as unknown as {
          insert?: { imageFromFiles?: (files: FileList, options?: { at?: Path }) => void }
        }
      ).insert?.imageFromFiles
      insert?.(files, insertAt ? { at: insertAt } : undefined)
    })()
  }

  return (
    <ToolbarButton {...props} onClick={onClick} tooltip="Image">
      <ImageIcon />
    </ToolbarButton>
  )
}
