export default {
  id: 'repo-inspector',
  name: 'Repo Inspector',
  description: 'Example read-only tool pack for repository-oriented adapters.',
  tools: [
    {
      spec: {
        type: 'function',
        function: {
          name: 'repo_context',
          description: 'Return basic repository context for an Aila adapter.',
          parameters: {
            type: 'object',
            properties: {
              focus: {
                type: 'string',
                description: 'Optional area of the repository the caller wants to inspect.',
              },
            },
            additionalProperties: false,
          },
        },
        metadata: {
          name: 'repo_context',
          readOnly: true,
          destructive: false,
          requiresApproval: false,
          access: ['read'],
          scope: ['workspace'],
          allowedProfiles: ['coding', 'research'],
          maxResultBytes: 4096,
        },
      },
      async run(args) {
        return JSON.stringify(
          {
            cwd: process.cwd(),
            focus: typeof args.focus === 'string' ? args.focus : null,
            message:
              'This example tool pack is loaded from a manifest and can be replaced with project-specific logic.',
          },
          null,
          2,
        )
      },
    },
  ],
}
