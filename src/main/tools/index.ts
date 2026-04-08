import type { Tool } from '../agent-core/types'
import { createTavilyTools } from './tavily'
import type { ToolContext } from './types'

export { createCodingTools } from './built-in'

export function createCustomTools(ctx: ToolContext): Tool[] {
  return createTavilyTools(ctx)
}
