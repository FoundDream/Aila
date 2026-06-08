import { readFile, writeFile } from 'node:fs/promises'
import type { ToolFileSystem, ToolWorkspaceRoot } from './tools'

export const fileSystem: ToolFileSystem = {
  readTextFile: (path) => readFile(path, 'utf-8'),
  writeTextFile: (path, content) => writeFile(path, content, 'utf-8'),
}

export function workspaceRoots(): ToolWorkspaceRoot[] {
  return [process.cwd()]
}
