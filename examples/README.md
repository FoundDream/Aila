# Aila Extension Examples

These examples are copyable manifests for local Aila data directories. They are
also loaded by the runtime contract tests, so they stay aligned with the current
manifest schemas.

## Profile

Copy a profile manifest into `<data-dir>/profiles`:

```sh
mkdir -p ~/.aila/profiles
cp examples/profiles/code-reviewer.json ~/.aila/profiles/
```

Then select the profile in Desktop, TUI, or CLI:

```sh
bun run cli -- --data-dir ~/.aila --extensions
bun run cli -- --profile code-reviewer "review the current changes"
```

## Tool Pack

Copy a tool pack directory into `<data-dir>/tool-packs`:

```sh
mkdir -p ~/.aila/tool-packs
cp -R examples/tool-packs/repo-inspector ~/.aila/tool-packs/
```

The next Desktop/TUI/CLI runtime load will include the manifest tool pack.
During development, use `AILA_DATA_DIR` to point at a temporary data directory:

```sh
AILA_DATA_DIR=/tmp/aila-dev bun run cli -- --profile coding "use repo inspector"
```

Use `--extensions --json` when you want a machine-readable validation report:

```sh
bun run cli -- --data-dir ~/.aila --extensions --json
```
