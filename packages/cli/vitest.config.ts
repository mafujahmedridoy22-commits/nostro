import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    // Run against the sources so the CLI, the stores and the testkit share one copy of core.
    alias: {
      'nostro-testkit': source('../testkit/src/index.ts'),
      '@nostro-labs/server': source('../server/src/index.ts'),
      '@nostro-labs/store-postgres': source('../store-postgres/src/index.ts'),
      '@nostro-labs/store-sqlite': source('../store-sqlite/src/index.ts'),
      '@nostro-labs/nostro': source('../core/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // bin.ts only hands process.argv to main(); it is run, not imported.
      exclude: ['src/bin.ts'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
})
