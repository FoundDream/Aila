'use client'

import {
  Code2,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  ListIcon,
  ListOrdered,
  PilcrowIcon,
  Quote,
  Square,
} from 'lucide-react'
import { KEYS, type Path, PathApi, type TComboboxInputElement } from 'platejs'
import { PlateElement, type PlateEditor, type PlateElementProps } from 'platejs/react'
import * as React from 'react'

import { pickImageFiles } from '@/components/editor/plugins/media-kit'
import { insertBlock } from '@/components/editor/transforms'

import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
} from './inline-combobox'

type Group = {
  group: string
  items: {
    icon: React.ReactNode
    value: string
    onSelect: (editor: PlateEditor, value: string) => void
    className?: string
    focusEditor?: boolean
    keywords?: string[]
    label?: string
  }[]
}

async function insertImageFromPicker(editor: PlateEditor): Promise<void> {
  const block = editor.api.block()
  const insertAt: Path | undefined = block ? PathApi.next(block[1]) : undefined

  const files = await pickImageFiles()
  if (!files) return
  const insert = (
    editor.tf as unknown as {
      insert?: { imageFromFiles?: (files: FileList, options?: { at?: Path }) => void }
    }
  ).insert?.imageFromFiles
  insert?.(files, insertAt ? { at: insertAt } : undefined)
}

const groups: Group[] = [
  {
    group: 'Basic blocks',
    items: [
      { icon: <PilcrowIcon />, keywords: ['paragraph'], label: 'Text', value: KEYS.p },
      { icon: <Heading1Icon />, keywords: ['title', 'h1'], label: 'Heading 1', value: KEYS.h1 },
      { icon: <Heading2Icon />, keywords: ['subtitle', 'h2'], label: 'Heading 2', value: KEYS.h2 },
      { icon: <Heading3Icon />, keywords: ['subtitle', 'h3'], label: 'Heading 3', value: KEYS.h3 },
      { icon: <ListIcon />, keywords: ['unordered', 'ul', '-'], label: 'Bulleted list', value: KEYS.ul },
      { icon: <ListOrdered />, keywords: ['ordered', 'ol', '1'], label: 'Numbered list', value: KEYS.ol },
      { icon: <Square />, keywords: ['checklist', 'task', 'checkbox', '[]'], label: 'To-do list', value: KEYS.listTodo },
      { icon: <Code2 />, keywords: ['```'], label: 'Code Block', value: KEYS.codeBlock },
      { icon: <Quote />, keywords: ['citation', 'blockquote', 'quote', '>'], label: 'Blockquote', value: KEYS.blockquote },
    ].map((item) => ({
      ...item,
      onSelect: (editor, value) => {
        insertBlock(editor, value, { upsert: true })
      },
    })) as Group['items'],
  },
  {
    group: 'Media',
    items: [
      {
        icon: <ImageIcon />,
        keywords: ['image', 'picture', 'photo', 'img'],
        label: 'Image',
        value: KEYS.img,
        onSelect: (editor) => {
          void insertImageFromPicker(editor)
        },
      },
    ],
  },
]

export function SlashInputElement(props: PlateElementProps<TComboboxInputElement>) {
  const { editor, element } = props

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox element={element} trigger="/">
        <InlineComboboxInput />

        <InlineComboboxContent>
          <InlineComboboxEmpty>No results</InlineComboboxEmpty>

          {groups.map(({ group, items }) => (
            <InlineComboboxGroup key={group}>
              <InlineComboboxGroupLabel>{group}</InlineComboboxGroupLabel>

              {items.map(({ focusEditor, icon, keywords, label, value, onSelect }) => (
                <InlineComboboxItem
                  key={value}
                  value={value}
                  onClick={() => onSelect(editor, value)}
                  label={label}
                  focusEditor={focusEditor}
                  group={group}
                  keywords={keywords}
                >
                  <div className="mr-2 text-muted-foreground">{icon}</div>
                  {label ?? value}
                </InlineComboboxItem>
              ))}
            </InlineComboboxGroup>
          ))}
        </InlineComboboxContent>
      </InlineCombobox>

      {props.children}
    </PlateElement>
  )
}
