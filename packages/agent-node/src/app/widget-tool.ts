import { getGuidelines, type ToolRegistration, WIDGET_MODULES } from '@aila/agent'

/**
 * Native replacement for CodePilot's `codepilot_load_widget_guidelines` MCP
 * tool. The model calls this before its first widget to load detailed design
 * specs for the requested module(s); the handler returns the guideline text,
 * which the agent loop feeds back as a tool result. No MCP involved.
 */
export const WIDGET_TOOL: ToolRegistration = {
  spec: {
    type: 'function',
    function: {
      name: 'load_widget_guidelines',
      description:
        'Load detailed design guidelines for generating visual widgets. Call this before generating your first widget. Available modules: interactive (HTML controls), chart (Chart.js), mockup (UI mockups), art (SVG illustrations), diagram (flowcharts/timelines/hierarchies).',
      parameters: {
        type: 'object',
        properties: {
          modules: {
            type: 'array',
            items: { type: 'string', enum: WIDGET_MODULES },
            description: 'Which guideline modules to load.',
          },
        },
        required: ['modules'],
        additionalProperties: false,
      },
    },
    metadata: {
      name: 'load_widget_guidelines',
      readOnly: true,
      destructive: false,
      requiresApproval: false,
      access: [],
      scope: [],
    },
  },
  run: async (args) => {
    const modules = Array.isArray(args.modules) ? (args.modules as string[]) : []
    return getGuidelines(modules)
  },
}
