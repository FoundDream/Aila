import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { type Static, Type } from '@sinclair/typebox'
import type { Tool } from '../../agent-core/types'

const DEFAULT_MAX_LINES = 2000
const DEFAULT_LINE_TRUNCATE = 2000

const schema = Type.Object({
  path: Type.String({
    description: 'Absolute or cwd-relative path to the file to read.',
  }),
  offset: Type.Optional(
    Type.Number({
      description:
        'Line number (1-based) to start reading from. Used together with `limit` to read a slice of a large file.',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of lines to return. Default: 2000.',
    }),
  ),
})

type Params = Static<typeof schema>

function truncateLine(line: string): string {
  if (line.length <= DEFAULT_LINE_TRUNCATE) return line
  return `${line.slice(0, DEFAULT_LINE_TRUNCATE)}… [line truncated, ${line.length - DEFAULT_LINE_TRUNCATE} more chars]`
}

function formatWithLineNumbers(lines: string[], startLine: number): string {
  return lines
    .map((line, i) => `${String(startLine + i).padStart(6)}\t${truncateLine(line)}`)
    .join('\n')
}

function isLikelyBinary(buffer: Buffer, sampleSize = 512): boolean {
  const len = Math.min(buffer.length, sampleSize)
  for (let i = 0; i < len; i++) {
    const byte = buffer[i]
    if (byte === 0) return true
  }
  return false
}

export function createReadTool(cwd: string): Tool<typeof schema> {
  return {
    name: 'read',
    label: 'Read File',
    description:
      'Read the contents of a file on disk. Returns the file content with 1-based line numbers prefixed. Use `offset` and `limit` to page through large files.',
    parameters: schema,
    promptSnippet:
      'Read files from the local filesystem when you need to inspect existing code, configuration, or documentation.',
    promptGuidelines: [
      'Prefer reading a file before editing it so the change fits the surrounding context',
      'Use offset/limit to page through files larger than 2000 lines instead of reading the whole file at once',
      'Absolute paths are allowed; relative paths resolve against the current working directory',
    ],
    async execute({ path, offset, limit }: Params, _ctx) {
      const absolute = isAbsolute(path) ? path : resolve(cwd, path)

      let fileStat: Awaited<ReturnType<typeof stat>>
      try {
        fileStat = await stat(absolute)
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `read: cannot stat "${absolute}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
      }

      if (fileStat.isDirectory()) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `read: "${absolute}" is a directory, not a file`,
            },
          ],
        }
      }

      let raw: Buffer
      try {
        raw = await readFile(absolute)
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `read: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
      }

      if (isLikelyBinary(raw)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `read: "${absolute}" looks like a binary file (contains NUL bytes); refusing to return its contents as text`,
            },
          ],
        }
      }

      const text = raw.toString('utf8')
      const allLines = text.split('\n')
      const totalLines = allLines.length

      const startLine = Math.max(1, offset ?? 1)
      const maxLines = Math.max(1, limit ?? DEFAULT_MAX_LINES)
      const slice = allLines.slice(startLine - 1, startLine - 1 + maxLines)

      const formatted = formatWithLineNumbers(slice, startLine)
      const truncated = startLine - 1 + slice.length < totalLines

      const parts: string[] = [formatted]
      if (truncated) {
        parts.push(
          `… [showing ${slice.length} of ${totalLines} lines starting at line ${startLine}; use offset/limit to read more]`,
        )
      }

      return {
        content: [{ type: 'text', text: parts.join('\n') }],
        details: {
          path: absolute,
          totalLines,
          returnedLines: slice.length,
          startLine,
        },
      }
    },
  }
}
