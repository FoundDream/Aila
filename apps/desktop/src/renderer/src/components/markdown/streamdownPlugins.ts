import { createMathPlugin } from '@streamdown/math'
import type { PluginConfig } from 'streamdown'

export const markdownPlugins = {
  math: createMathPlugin({
    singleDollarTextMath: true,
  }),
} satisfies PluginConfig
