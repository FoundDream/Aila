import { AutoformatKit } from '@/components/editor/plugins/autoformat-kit'
import { BasicBlocksKit } from '@/components/editor/plugins/basic-blocks-kit'
import { BasicMarksKit } from '@/components/editor/plugins/basic-marks-kit'
import { CodeBlockKit } from '@/components/editor/plugins/code-block-kit'
import { DndKit } from '@/components/editor/plugins/dnd-kit'
import { FixedToolbarKit } from '@/components/editor/plugins/fixed-toolbar-kit'
import { FloatingToolbarKit } from '@/components/editor/plugins/floating-toolbar-kit'
import { LinkKit } from '@/components/editor/plugins/link-kit'
import { ListKit } from '@/components/editor/plugins/list-kit'
import { MarkdownKit } from '@/components/editor/plugins/markdown-kit'
import { MediaKit } from '@/components/editor/plugins/media-kit'
import { SlashKit } from '@/components/editor/plugins/slash-kit'

// Plate v53 mutates plugin objects during editor resolution. Re-using the same
// configured plugin in a second editor silently drops its inputRules, which
// disables every Markdown shortcut on remount. Build a fresh kit per editor.
export function createNoteEditorKit() {
  return [
    ...BasicBlocksKit(),
    ...BasicMarksKit(),
    ...ListKit(),
    ...LinkKit(),
    ...CodeBlockKit(),
    ...MediaKit(),
    ...MarkdownKit(),
    ...AutoformatKit(),
    ...SlashKit(),
    ...DndKit(),
    ...FixedToolbarKit(),
    ...FloatingToolbarKit(),
  ]
}
