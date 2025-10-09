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
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    isolate: true,
    testTimeout: 30000,
  },
});
