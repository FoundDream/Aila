import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolPath } from '@aila/agent'

export const nodePath: ToolPath = {
  basename,
  isAbsolute,
  relative,
  resolve,
  separator: sep,
}
