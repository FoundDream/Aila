import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { type Static, Type } from '@sinclair/typebox'
import type { Tool } from '../../agent-core/types'

const schema = Type.Object({
  path: Type.String({
    description: 'Absolute or cwd-relative path to the file to create or overwrite.',
  }),
  content: Type.String({
    description: 'The full file contents to write. Overwrites any existing file.',
  }),
})

type Params = Static<typeof schema>

export function createWriteTool(cwd: string): Tool<typeof schema> {
  return {
    name: 'write',
    label: 'Write File',
    description:
      'Create a new file or overwrite an existing one. Parent directories are created as needed.',
    parameters: schema,
    promptSnippet:
      'Create new files or overwrite existing ones with fresh content. Prefer the edit tool for incremental updates.',
    promptGuidelines: [
      'Use write only when the entire file content is known; use edit for targeted changes',
      'Parent directories are created automatically',
      'Absolute paths are allowed; relative paths resolve against the current working directory',
    ],
    async execute({ path, content }: Params, _ctx) {
      const absolute = isAbsolute(path) ? path : resolve(cwd, path)

      try {
        await mkdir(dirname(absolute), { recursive: true })
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `write: cannot create parent directory for "${absolute}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
      }

      try {
        await writeFile(absolute, content, 'utf8')
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `write: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `write: wrote ${content.length} bytes to "${absolute}"`,
          },
        ],
        details: {
          path: absolute,
          bytes: content.length,
        },
      }
    },
  }
}
