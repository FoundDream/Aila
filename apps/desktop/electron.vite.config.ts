import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const CONFIG_DIR = dirname(fileURLToPath(import.meta.url))

const sharedAlias = [
  {
    find: '@aila/agent/internal',
    replacement: resolve(CONFIG_DIR, '../../packages/agent/src/internal.ts'),
  },
  {
    find: '@aila/agent/host',
    replacement: resolve(CONFIG_DIR, '../../packages/agent/src/host.ts'),
  },
  // `@aila/agent-node` has no root export — /app is its only entry point. These
  // are prefix matches, so the longer finds must stay ahead of '@aila/agent'.
  {
    find: '@aila/agent-node/app',
    replacement: resolve(CONFIG_DIR, '../../packages/agent-node/src/app/index.ts'),
  },
  { find: '@aila/agent', replacement: resolve(CONFIG_DIR, '../../packages/agent/src/index.ts') },
  { find: '@shared', replacement: resolve(CONFIG_DIR, 'src/shared') },
]

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      externalizeDeps: {
        exclude: ['@aila/agent', '@aila/agent-node', '@sinclair/typebox'],
      },
      rollupOptions: {
        external: ['bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      externalizeDeps: {
        exclude: ['@aila/agent', '@aila/agent-node'],
      },
    },
  },
  renderer: {
    root: resolve(CONFIG_DIR, 'src/renderer'),
    // Pinned off vite's default 5173: the website dev server binds it on IPv4
    // and a dual-stack split leaves Electron loading the wrong app.
    server: { port: 5183, host: '127.0.0.1' },
    resolve: {
      alias: [{ find: '@', replacement: resolve(CONFIG_DIR, 'src/renderer/src') }, ...sharedAlias],
    },
    plugins: [tailwindcss(), react()],
  },
})
