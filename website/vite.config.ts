import react from '@vitejs/plugin-react'
import { defineConfig, lazyPlugins } from 'vite-plus'

export default defineConfig({
  plugins: lazyPlugins(() => [react()]),
  lint: {
    ignorePatterns: ['dist/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ['dist/**', 'styles.css'],
    singleQuote: true,
    semi: false,
    sortPackageJson: false,
  },
})
