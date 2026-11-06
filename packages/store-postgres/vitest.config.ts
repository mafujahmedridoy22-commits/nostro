import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Run against core's source so the store, testkit and tests share one copy of every class.
    alias: {
      'nostro-testkit': fileURLToPath(new URL('../testkit/src/index.ts', import.meta.url)),
      '@nostro-labs/nostro': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Each test gets its own schema, but they share one database; keep files serial.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
})
