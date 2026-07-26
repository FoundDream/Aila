import { readFile, writeFile } from 'node:fs/promises'
import type { ToolFileSystem, ToolWorkspaceRoot } from '@aila/agent'

export const nodeFileSystem: ToolFileSystem = {
  readTextFile: (path) => readFile(path, 'utf-8'),
  writeTextFile: (path, content) => writeFile(path, content, 'utf-8'),
}

export function nodeWorkspaceRoots(cwd = process.cwd()): ToolWorkspaceRoot[] {
  return [cwd]
}
