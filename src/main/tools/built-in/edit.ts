import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { type Static, Type } from '@sinclair/typebox'
import type { Tool } from '../../agent-core/types'

const schema = Type.Object({
  path: Type.String({
    description: 'Absolute or cwd-relative path to the file to edit.',
  }),
  oldString: Type.String({
    description:
      'The exact text to replace. Must appear EXACTLY once in the file (whitespace and indentation included).',
  }),
  newString: Type.String({
    description: 'The replacement text.',
  }),
  replaceAll: Type.Optional(
    Type.Boolean({
      description:
        'If true, replace every occurrence of oldString instead of requiring exactly one match.',
    }),
  ),
})

type Params = Static<typeof schema>

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let pos = 0
  while (true) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) break
    count += 1
    pos = idx + needle.length
  }
  return count
}

export function createEditTool(cwd: string): Tool<typeof schema> {
  return {
    name: 'edit',
    label: 'Edit File',
    description:
      'Perform an exact string replacement in a file. Requires `oldString` to match exactly once unless `replaceAll` is true. Fails if the file does not exist or the match is ambiguous.',
    parameters: schema,
    promptSnippet:
      'Edit files by specifying an exact string to replace. Always read the file first to make sure the oldString is unique.',
    promptGuidelines: [
      'The oldString must match the file exactly, including whitespace and indentation',
      'If the oldString appears more than once, include enough surrounding context to make it unique, or use replaceAll',
      'oldString and newString must differ; empty newString deletes the match',
      'Use the write tool instead of edit when creating a brand-new file',
    ],
    async execute({ path, oldString, newString, replaceAll }: Params, _ctx) {
      const absolute = isAbsolute(path) ? path : resolve(cwd, path)

      if (oldString === newString) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'edit: oldString and newString are identical; nothing to do',
            },
          ],
        }
      }

      let original: string
      try {
        original = await readFile(absolute, 'utf8')
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `edit: cannot read "${absolute}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
      }

      if (oldString === '') {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'edit: oldString must not be empty (use the write tool to create a file)',
            },
          ],
        }
      }

      const occurrences = countOccurrences(original, oldString)
      if (occurrences === 0) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `edit: oldString was not found in "${absolute}"`,
            },
          ],
        }
      }
      if (occurrences > 1 && !replaceAll) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `edit: oldString matches ${occurrences} locations in "${absolute}"; provide more surrounding context or set replaceAll: true`,
            },
          ],
        }
      }

      const updated = replaceAll
        ? original.split(oldString).join(newString)
        : original.replace(oldString, newString)

      try {
        await writeFile(absolute, updated, 'utf8')
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `edit: failed to write "${absolute}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `edit: replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in "${absolute}"`,
          },
        ],
        details: {
          path: absolute,
          replacements: occurrences,
        },
      }
    },
  }
}
