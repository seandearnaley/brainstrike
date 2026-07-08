import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['*.test.ts', '__tests__/**/*.test.ts'],
    isolate: true,
    // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
    maxWorkers: 1,
    pool: 'threads',
    reporters: 'basic',
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    silent: true,
    testTimeout: 30_000,
  },
});
