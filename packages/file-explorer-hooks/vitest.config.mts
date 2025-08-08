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
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
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
