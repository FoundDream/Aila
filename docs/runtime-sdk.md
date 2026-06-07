# Aila Runtime SDK

Aila's public runtime SDK lives at `src/runtime`. It is the boundary that
first-party adapters and future third-party apps should import from. Avoid
reaching into `src/main` directly unless you are changing the runtime
implementation itself.

## Entry Point

```ts
import {
  AgentRuntime,
  AILA_AGENT_EVENT_SCHEMA_VERSION,
  AILA_PROFILE_MANIFEST_SCHEMA_VERSION,
  AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION,
  AILA_RUNTIME_EVENT_SCHEMA_VERSION,
  AILA_CONVERSATION_META_SCHEMA_VERSION,
  AILA_PERSISTED_MESSAGE_SCHEMA_VERSION,
  configureDataDir,
  createConversation,
  getConversation,
  loadAgentProfilesFromDir,
  loadToolPacksFromDir,
  getExtensionReport,
  isRuntimeEventType,
  type AgentRuntimeEvent,
} from './src/runtime'
```

The SDK exposes:

- `AgentRuntime`: send, abort, delete conversations, and receive runtime events.
- Conversation storage: create, read, list, rename, delete, usage, event logs.
- Tool system: built-in tool packs, custom tool packs, metadata, profile
  filtering, execution, approval types.
- Profiles: built-in profiles plus local manifest profiles with inherited tool
  policy and custom instructions.
- Extension discovery: one SDK helper for validating and listing manifest
  profiles and tool packs from the active data directory.
- Settings and model catalog helpers.
- Stable runtime constants: `AILA_RUNTIME_SDK_VERSION`,
  `AILA_RUNTIME_EVENT_SCHEMA_VERSION`, `AILA_RUNTIME_EVENT_TYPES`,
  `AILA_CONVERSATION_META_SCHEMA_VERSION`, and
  `AILA_PERSISTED_MESSAGE_SCHEMA_VERSION`, and
  `AILA_AGENT_EVENT_SCHEMA_VERSION`.

Desktop docs are intentionally outside this SDK boundary. Desktop can keep its
workspace-specific docs storage and UI, but runtime adapters should treat docs
as ordinary files or adapter-owned context instead of depending on doc-specific
AgentRuntime hooks.

## Minimal Adapter

```ts
configureDataDir('/path/to/aila-data')

const conversation = await createConversation()
const runtime = new AgentRuntime({
  onEvent(event: AgentRuntimeEvent) {
    if (event.schemaVersion !== AILA_RUNTIME_EVENT_SCHEMA_VERSION) return
    // Route event.type to your UI, logs, or automation.
  },
  async onToolApproval(request) {
    // Return true to allow destructive tools such as bash/write/edit.
    return false
  },
})

await runtime.send({
  conversationId: conversation.id,
  userText: 'Inspect this repository',
  selection: { providerId: 'openrouter', modelId: 'minimax/minimax-m3' },
  requestedProfileId: 'coding',
})
```

Adapters are responsible for presenting approvals and routing events. The
runtime is responsible for the agent loop, tool dispatch, persistence,
conversation ordering, usage accounting, and abort cleanup.

## Runtime Events

Every `AgentRuntime` event is a versioned envelope:

```ts
type AgentRuntimeEvent = {
  schemaVersion: typeof AILA_RUNTIME_EVENT_SCHEMA_VERSION
  type: AilaRuntimeEventType
  data: unknown
}
```

Use `AILA_RUNTIME_EVENT_TYPES` for exhaustive routing and
`isRuntimeEventType(value)` when decoding external input. The payload type for
each event is defined by `AgentRuntimeEventMap`.

## Persistence Contract

Conversation metadata, persisted messages, and agent event log records are
versioned on write. Older unversioned conversations are normalized when read, so
Desktop, TUI, and SDK adapters can continue opening existing data directories.

```ts
const conversation = await createConversation()
console.log(conversation.schemaVersion === AILA_CONVERSATION_META_SCHEMA_VERSION)

const record = await getConversation(conversation.id)
for (const message of record.messages) {
  console.log(message.schemaVersion === AILA_PERSISTED_MESSAGE_SCHEMA_VERSION)
}
```

## Custom Tool Packs

Tool packs let adapters expose additional function-calling tools without
forking the built-in tool registry.

```ts
import { AgentRuntime, type ToolPack } from './src/runtime'

const projectToolPack: ToolPack = {
  id: 'project',
  name: 'Project',
  description: 'Project-specific automation.',
  tools: [
    {
      spec: {
        type: 'function',
        function: {
          name: 'project_status',
          description: 'Return a short project status summary.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
        metadata: {
          name: 'project_status',
          readOnly: true,
          destructive: false,
          requiresApproval: false,
          access: ['read'],
          scope: ['workspace'],
          allowedProfiles: ['coding', 'research'],
        },
      },
      async run() {
        return 'No project status provider configured.'
      },
    },
  ],
}

const runtime = new AgentRuntime({
  toolPacks: [projectToolPack],
})
```

Built-in packs are always registered first. Tool names must be unique across
the built-in packs and any custom packs.

## Manifest Tool Packs

Adapters can also load local tool packs from a data directory:

```text
tool-packs/
  project/
    aila-tool-pack.json
    index.mjs
```

`aila-tool-pack.json`:

```json
{
  "schemaVersion": 1,
  "id": "project",
  "name": "Project",
  "entry": "index.mjs"
}
```

`index.mjs` exports a `ToolPack`, a `toolPack`, or a `createToolPack()` factory:

```js
export default {
  id: 'project',
  name: 'Project',
  tools: [
    {
      spec: {
        type: 'function',
        function: {
          name: 'project_status',
          description: 'Return a short project status summary.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
        metadata: {
          name: 'project_status',
          readOnly: true,
          destructive: false,
          requiresApproval: false,
          access: ['read'],
          scope: ['workspace'],
          allowedProfiles: ['coding'],
        },
      },
      async run() {
        return 'ok'
      },
    },
  ],
}
```

```ts
const loaded = await loadToolPacksFromDir()
const runtime = new AgentRuntime({
  toolPacks: loaded.map((pack) => pack.toolPack),
})
```

For adapters that want lazy loading and reload support, pass a loader function:

```ts
const runtime = new AgentRuntime({
  loadToolPacks: async () => (await loadToolPacksFromDir()).map((pack) => pack.toolPack),
})

await runtime.reloadToolPacks()
```

The manifest schema is versioned with
`AILA_TOOL_PACK_MANIFEST_SCHEMA_VERSION`. Entries must stay inside their tool
pack directory, and disabled manifests (`"enabled": false`) are skipped.
Reload support reflects changes to the tool pack source directory, including
relative modules imported by the entry file.

See `examples/tool-packs/repo-inspector` for a copyable manifest tool pack that
is loaded by the runtime contract tests. Use `bun run cli -- --extensions` to
validate the tool packs and profiles in the active data directory.

## Manifest Profiles

Adapters can load local profile manifests from `<data-dir>/profiles/*.json`.
Profile manifests inherit tool policy from a built-in base profile and may add
instructions that are injected as a system message.

```json
{
  "schemaVersion": 1,
  "id": "code-reviewer",
  "label": "Code Reviewer",
  "description": "Review code with a conservative engineering stance.",
  "baseProfileId": "coding",
  "instructions": "Prioritize bugs, regressions, and missing tests."
}
```

```ts
const runtime = new AgentRuntime({
  loadProfiles: async () => (await loadAgentProfilesFromDir()).map((p) => p.profile),
})
```

The profile manifest schema is versioned with
`AILA_PROFILE_MANIFEST_SCHEMA_VERSION`. Disabled profile manifests
(`"enabled": false`) are skipped.

See `examples/profiles/code-reviewer.json` for a copyable profile manifest that
is loaded by the runtime contract tests. `bun run cli -- --extensions --json`
prints a machine-readable validation report.

## Extension Reports

Adapters that need an extension status view can call `getExtensionReport()`.
It validates enabled manifest profiles and tool packs from the active data
directory, returns structured paths and tool names, and keeps loader errors
separate for profiles and tool packs.

```ts
const report = await getExtensionReport()
if (!report.ok) {
  for (const error of report.errors) console.error(error.kind, error.message)
}
```

The CLI uses this for `bun run cli -- --extensions --json`, and the TUI uses it
for `/extensions`. In an interactive adapter, call `runtime.reloadProfiles()`
and `runtime.reloadToolPacks()` after installing or editing extension files.
