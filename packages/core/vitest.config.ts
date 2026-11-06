import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The shared testkit imports `nostro`; point it at this package's source
    // so tests, testkit and coverage all see one copy of every class.
    alias: {
      'nostro-testkit': fileURLToPath(new URL('../testkit/src/index.ts', import.meta.url)),
      '@nostro-labs/nostro': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
        // Every downstream amount and record passes through these; hold them high.
        'src/money/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/model/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/store/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
})
