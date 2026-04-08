import type { Tool } from '../../agent-core/types'
import { createBashTool } from './bash'
import { createEditTool } from './edit'
import { createReadTool } from './read'
import { createWriteTool } from './write'

/**
 * Return the four built-in coding tools bound to a working directory.
 * Drop-in replacement for pi-coding-agent's `createCodingTools(cwd)`.
 */
export function createCodingTools(cwd: string): Tool[] {
  return [createReadTool(cwd), createBashTool(cwd), createEditTool(cwd), createWriteTool(cwd)]
}

export { createBashTool, createEditTool, createReadTool, createWriteTool }
