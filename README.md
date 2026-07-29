# Aila

> This project is still in a very early stage. Expect frequent breaking changes, rough edges, and incomplete functionality. It is not recommended for long-term or production use yet.

Aila is a fully open-source, local-first agent runtime and workbench for code,
documents, and personal workflows. `AgentRuntime` is the core agent engine;
Desktop owns workspace features such as docs, while TUI/CLI are lightweight
adapters over the shared runtime, tools, storage, and event contract.

The public runtime SDK entrypoint is `@aila/agent`; Node adapters live in
`@aila/agent-node`, and product-level persistence helpers live in
`@aila/agent-node/app`. Consumers should use these exported entrypoints instead
of importing workspace source files directly.

The runtime is split into explicit scopes, one module each under
`packages/agent/src/runtime/` (with `runtime.ts` as the public barrel:
api-types, workbench-host, clone, run-helpers, services, catalog,
session-engine, session-runtime, workbench-runtime):

- `WorkbenchRuntime` is the multi-session process facade. It creates, retains,
  routes, recovers, and shuts down session runtimes.
- `WorkbenchServices` is the process-scoped service container behind the
  facade. Store, host integrations, tool/skill caches, clocks, id factories,
  and the lifecycle-hook dispatcher are shared by every session.
- `ConversationCatalog` owns global conversation creation, lookup, listing, and
  restart recovery; it does not execute turns.
- `SessionRuntimeEngine` is bound to one durable conversation. It owns that
  session's turn lifecycle, phase, pending journal writes, context assembly,
  run controls, navigation, compaction, availability snapshots, and
  steer/follow-up/next-turn input queues. `WorkbenchRuntime` holds one engine
  per conversation.
- `AgentRuntime` orchestrates one model/tool loop, including queue timing and
  step policy.
- `RunMachine` is the pure durable execution state machine.

Hosts observe the runtime through `WorkbenchHost.hooks` and the
`session:availability` event; the invariants that bind all of this together
live in [CLAUDE.md](./CLAUDE.md).

Desktop, TUI, and CLI use the `Workbench` API. Code that wants a per-session
event feed can call `workbench.subscribeSession(id, listener)`.

## Interfaces

- Desktop: `bun run dev`
- TUI: `bun run tui`
- CLI: `bun run cli -- "your prompt"`

Desktop shows a `resume last turn` action when a conversation ends with a
persisted user message and no assistant response. TUI and CLI expose the same
runtime path through `--retry-last`.

The TUI is a full-screen Aila-tui adapter over the shared `AgentRuntime`.
Aila-tui is implemented in this repository under `apps/tui/src/aila-tui`: it owns the
terminal abstraction, component tree, overlays, editor, picker, markdown text
rendering, and key handling. It streams assistant output into a transcript,
shows tool calls, opens approval and selection overlays, persists conversations,
queues prompts while a turn is running, and supports abort with Ctrl+C / exit
with Ctrl+D. In non-TTY environments it falls back to a line-mode contract for
automation and tests.

Useful TUI options:

```sh
bun run tui -- --model openai:gpt-5.4
bun run tui -- --list
bun run tui -- --resume
bun run tui -- --resume --retry-last
bun run tui -- --conversation <conversation-id>
bun run tui -- --data-dir ~/.aila
```

Useful TUI commands:

```text
/help
/retry
/sessions
/extensions
/extensions reload
/model openai:gpt-5.4
/read package.json
/run git status --short
/write scratch.txt hello
/edit scratch.txt hello => hello world
```

The CLI is a non-interactive entrypoint for scripts and automation. It uses the
same `AgentRuntime`, persistence, tool registry, approval contract, and
event schema as Desktop and TUI.

Useful CLI commands:

```sh
bun run cli -- "summarize this repo"
cat task.txt | bun run cli
bun run cli -- --resume --json "continue from the last conversation"
bun run cli -- --resume --retry-last --json
bun run cli -- --events "emit runtime events as NDJSON"
bun run cli -- --yes "make the requested file changes"
bun run cli -- --extensions
```

CLI tool approvals are denied by default. Pass `--yes` only for runs where the
requested tool executions should be auto-approved.

By default TUI and CLI store data in `$AILA_DATA_DIR` or `~/.aila`. Desktop
stores data in the Electron app data directory, and in development uses
`.dev-data`. When `.dev-data` exists in the current repo, TUI and CLI use it by
default so local development shares the same settings and conversations as
Desktop.

## Checks

```sh
bun run lint
bun run typecheck
bun run build
```

There is deliberately no test suite. The architecture invariants that the
former contract scripts enforced are documented as binding rules in
[CLAUDE.md](./CLAUDE.md); verification is lint, typecheck, build, and manual
smoke runs.
