# Aila Architecture Rules

These invariants were previously enforced by contract scripts under `scripts/`
(now deleted). Treat every rule below as binding when editing. Verification is
`bun run lint`, `bun run typecheck`, `bun run build`, and manual smoke runs —
there is deliberately no test suite (see AGENTS.md).

## Layering & Package Boundaries

- `@aila/agent` is Node-free: no `node:*`, `electron`, or `@aila/agent-node`
  imports. Filesystem paths flow through the host; use `TextEncoder`, never
  `Buffer`.
- Packages never import app source. Consumers use workspace exports only — no
  deep `packages/*/src` imports.
- The desktop renderer never imports `@aila/agent-node`. Preload and main may
  use `@aila/agent-node/app` (electron.vite aliases it).
- `@aila/agent-node` declares `@aila/agent` as `workspace:*`.
- No `pi-ai` dependency anywhere — Aila owns its model boundary and providers.
- `AgentRuntime` is the sole model/tool orchestrator over the pure `RunMachine`.
  The durable executor delegates to `defaultAgentRuntime` and never calls
  `runDurableRun` directly.
- `runDurableRun` / `advanceRun` are importable only via `@aila/agent/internal`;
  `createToolRegistry` / `executeTool` / `getToolDefinitions` only via
  `@aila/agent/host`.
- The root `@aila/agent` export must not re-expose internal machinery
  (`RunState`, `RunTransition`, `runDurableRun`, host-store internals).
- CLI and TUI import only `@aila/agent` and `@aila/agent-node/app`.

## Runtime & Persistence

- Host boundary: settings, model streaming, model info, attachments, transient
  and stable context, tool execution, images, web search, and shell all flow
  through `WorkbenchHost`. Runtime core stays Node-free.
- The store is injectable; optional store capabilities fail closed.
- The session journal is append-only and the single source of truth; run
  snapshots are accelerators, never authority. Entries are immutable once
  written (byte-identical duplicates are idempotent; any difference throws).
- Run events are schema-versioned, deduped by `eventId`, and replay
  deterministically; append order is stable at equal timestamps.
- `run.payload` entries are written in API vocabulary only (`model_request`,
  `model_response`, `tool_batch`, `tool_request`, `tool_result`, `compaction`,
  `inspection`). Legacy journal vocabulary (`provider_request`,
  `provider_response`, `context_compaction`) is normalized on read via
  `normalizeRunPayloadKind` and must never be written or compared raw.
- Session fork copies only the selected root-to-leaf semantic path.
- Structural session operations (navigate, fork, garbage-collect, compact)
  require the idle phase.
- Runs interrupted mid-tool are marked `manual_review` and must not auto-resume.
- Exactly one provider request per model step.
- Step mode pauses before tool steps; tool approval pauses before side effects
  (`safe` ⇒ ask on destructive writes, `yolo` ⇒ allow).
- Turn starts serialize per session; abort, delete, and shutdown persist their
  cancellation and never leak an active turn.

## Desktop

- The chat canvas stays full-width and contains no run controls or step-mode
  chrome — the debug workbench owns run inspection and control.
- The renderer hydrates conversations via the runtime lifecycle API only; no
  raw conversation reads from the store.
- Main constructs the workbench exclusively through
  `createDesktopRuntimeWorkbench` + `registerRuntimeWorkbenchIpcHandlers` —
  one construction path, one IPC registration path.
- ESM-safe paths only: resolve from `import.meta.url`, never `__dirname`.
- No embedded terminal (no PTY dependencies, no terminal IPC).
- The chat stream reducer is monotonic: finished messages are never downgraded
  or mutated by late or stale events; dropped conversations tombstone.
- Preload types re-export from `@aila/agent` (type-only re-exports from
  `@aila/agent-node/app` are allowed); hand-copied type duplicates are
  forbidden — they drift.

## CLI / TUI

- `--retry-last` never duplicates user messages and appends exactly one
  assistant message.
- `turn.interrupted` completes the adapters with an error and preserves
  partial text.
