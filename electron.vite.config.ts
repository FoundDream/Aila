import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const sharedAlias = {
  '@shared': resolve(__dirname, 'src/shared'),
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      externalizeDeps: {
        exclude: ['@sinclair/typebox'],
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
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        ...sharedAlias,
      },
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
