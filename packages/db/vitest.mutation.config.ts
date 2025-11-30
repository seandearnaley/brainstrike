import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    silent: true,
    reporters: 'basic',
    setupFiles: ['./vitest.setup.ts'],
    include: ['__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    env: {
      TEST_PGLITE_MOCK: 'true',
    },
    pool: 'threads',
    // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
    maxWorkers: 1,
    isolate: true,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
