import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const CONFIG_DIR = dirname(fileURLToPath(import.meta.url))

const sharedAlias = [
  {
    find: '@aila/agent/host',
    replacement: resolve(CONFIG_DIR, '../../packages/agent/src/host.ts'),
  },
  {
    find: '@aila/agent-node/app',
    replacement: resolve(CONFIG_DIR, '../../packages/agent-node/src/app/index.ts'),
  },
  {
    find: '@aila/agent-node',
    replacement: resolve(CONFIG_DIR, '../../packages/agent-node/src/index.ts'),
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
  },
  renderer: {
    root: resolve(CONFIG_DIR, 'src/renderer'),
    resolve: {
      alias: [{ find: '@', replacement: resolve(CONFIG_DIR, 'src/renderer/src') }, ...sharedAlias],
      // CodeMirror 6 packages share a singleton @codemirror/state. Two copies
      // would silently break view.dispatch with cryptic state-mismatch errors.
      dedupe: [
        '@codemirror/state',
        '@codemirror/view',
        '@codemirror/language',
        '@codemirror/commands',
      ],
    },
    plugins: [tailwindcss(), react()],
  },
})
