import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { environment: 'happy-dom', setupFiles: ['tests/setup.ts'], include: ['tests/**/*.test.{ts,tsx}'], globals: false },
})
