---
name: electron-binary-mirror
description: Installing Electron on this machine needs ELECTRON_MIRROR (GitHub download fails); bun ignores .npmrc electron_mirror
metadata:
  type: project
---

On this machine's network, downloading the Electron binary from GitHub releases fails (`TypeError: terminated` mid-download). After `bun install` (or any clean install / CI), the Electron binary is missing (`node_modules/electron/dist` and `path.txt` absent) and `electron-vite dev` throws `Error: Electron uninstall`.

Fix — fetch the binary via the npmmirror mirror:
```
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

**Why:** bun does not auto-run electron's binary-download install script reliably, and the default GitHub source is blocked/throttled here.
**How to apply:** Use the `ELECTRON_MIRROR` **env var** — verified that bun does NOT forward `.npmrc`'s `electron_mirror=` key to lifecycle scripts, so a project `.npmrc` mirror entry does nothing under bun. For a permanent fix, `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` in `~/.zshrc`.
