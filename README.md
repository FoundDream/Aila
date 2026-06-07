# Aila

> This project is still in a very early stage. Expect frequent breaking changes, rough edges, and incomplete functionality. It is not recommended for long-term or production use yet.

Aila is a fully open-source, local-first agent runtime and workbench for code,
documents, and personal workflows. `AgentRuntime` is the core agent engine;
Desktop owns workspace features such as docs, while TUI/CLI are lightweight
adapters over the shared runtime, tools, storage, and event contract.

The public runtime SDK entrypoint is `src/runtime`; see
[`docs/runtime-sdk.md`](docs/runtime-sdk.md) before building new adapters or
tooling on top of Aila.

## Interfaces

- Desktop: `bun run dev`
- TUI: `bun run tui`
- CLI: `bun run cli -- "your prompt"`

Desktop shows a `resume last turn` action when a conversation ends with a
persisted user message and no assistant response. TUI and CLI expose the same
runtime path through `--retry-last`.

The TUI is a full-screen Aila-tui adapter over the shared `AgentRuntime`.
Aila-tui is implemented in this repository under `src/tui/aila-tui`: it owns the
terminal abstraction, component tree, overlays, editor, picker, markdown text
rendering, and key handling. It streams assistant output into a transcript,
shows tool calls, opens approval and selection overlays, persists conversations,
queues prompts while a turn is running, and supports abort with Ctrl+C / exit
with Ctrl+D. In non-TTY environments it falls back to a line-mode contract for
automation and tests.

Useful TUI options:

```sh
bun run tui -- --profile coding
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
/profile coding
/model openai:gpt-5.4
/read package.json
/run git status --short
/write scratch.txt hello
/edit scratch.txt hello => hello world
```

The CLI is a non-interactive entrypoint for scripts and automation. It uses the
same `AgentRuntime`, persistence, profiles, tool packs, approval contract, and
event schema as Desktop and TUI.

Useful CLI commands:

```sh
bun run cli -- "summarize this repo"
cat task.txt | bun run cli -- --profile coding
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

Desktop, TUI, and CLI all load enabled manifest tool packs from
`<data-dir>/tool-packs`.
They also load enabled manifest profiles from `<data-dir>/profiles`.

## Checks

```sh
bun run lint
bun run typecheck
bun run test
bun run build
```

`bun run test` runs the runtime contract suite plus CLI/TUI contract coverage
for extension validation, local TUI commands, removed doc adapter commands, and
retry-last recovery.
