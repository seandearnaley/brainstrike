import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    pool: 'threads',
    // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
    maxWorkers: 1,
    isolate: true,
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@brainstrike/workers': path.resolve(__dirname, '../workers'),
      '@brainstrike/workers/file-content-worker': path.resolve(
        __dirname,
        '../workers/file-content-worker.ts'
      ),
    },
  },
});
