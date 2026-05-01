import { AutoformatKit } from '@/components/editor/plugins/autoformat-kit'
import { BasicBlocksKit } from '@/components/editor/plugins/basic-blocks-kit'
import { BasicMarksKit } from '@/components/editor/plugins/basic-marks-kit'
import { CodeBlockKit } from '@/components/editor/plugins/code-block-kit'
import { FixedToolbarKit } from '@/components/editor/plugins/fixed-toolbar-kit'
import { FloatingToolbarKit } from '@/components/editor/plugins/floating-toolbar-kit'
import { LinkKit } from '@/components/editor/plugins/link-kit'
import { ListKit } from '@/components/editor/plugins/list-kit'
import { MarkdownKit } from '@/components/editor/plugins/markdown-kit'
import { SlashKit } from '@/components/editor/plugins/slash-kit'

export const NoteEditorKit = [
  ...BasicBlocksKit,
  ...BasicMarksKit,
  ...ListKit,
  ...LinkKit,
  ...CodeBlockKit,
  ...MarkdownKit,
  ...AutoformatKit,
  ...SlashKit,
  ...FixedToolbarKit,
  ...FloatingToolbarKit,
]
