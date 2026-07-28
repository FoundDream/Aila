# Development Rules

Architecture invariants live in [CLAUDE.md](./CLAUDE.md); this file covers
process only.

## Communication

- Keep responses concise, direct, and technical.
- Answer questions before making edits or running implementation commands.
- When responding to feedback or analysis, state whether you agree or disagree before describing changes.

## Code Quality

- Read relevant files in full before broad changes, audits, or editing unfamiliar files. Do not rely on search snippets alone.
- Check dependency source and types instead of guessing external APIs.
- Ask before removing functionality or code that appears intentional.
- Avoid `any` unless it is necessary.

## Commands

- Do not run tests unless the user explicitly asks.
- Do not commit unless the user explicitly asks.
- Treat dependency and lockfile changes as reviewed code.

## Git

- Preserve unrelated and pre-existing work.
- Stage only files changed for the current task, using explicit paths.
- Before committing, verify with `git status` that only intended files are staged.
- Never use `git add .`, `git add -A`, `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git commit --no-verify`, or force push.
- Resolve conflicts only in files changed for the current task. If a conflict touches another file, stop and ask.

## Pull Requests

- Do not switch the worktree to a PR branch unless the user explicitly asks.
- Inspect PRs without changing branches, using `gh pr view`, `gh pr diff`, `gh api`, or `git show`.
