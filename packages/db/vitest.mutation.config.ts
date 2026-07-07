import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      TEST_PGLITE_MOCK: 'true',
    },
    environment: 'jsdom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    hookTimeout: 30_000,
    include: ['__tests__/**/*.test.{ts,tsx}'],
    isolate: true,
    // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
    maxWorkers: 1,
    pool: 'threads',
    reporters: 'basic',
    setupFiles: ['./vitest.setup.ts'],
    silent: true,
    testTimeout: 30_000,
  },
});
