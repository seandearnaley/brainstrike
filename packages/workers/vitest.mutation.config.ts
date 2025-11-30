import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    silent: true,
    reporters: 'basic',
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['*.test.ts', '__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    pool: 'threads',
    // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
    maxWorkers: 1,
    isolate: true,
    testTimeout: 30_000,
  },
});
