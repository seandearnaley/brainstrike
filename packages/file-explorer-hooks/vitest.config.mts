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
    testTimeout: 30_000,
  },
  resolve: {
    alias: [
      {
        find: /^@brainstrike\/utils\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, '../utils/src/$1.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: path.resolve(import.meta.dirname, '../utils/src/index.ts'),
      },
      {
        find: /^@brainstrike\/file-system\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, '../file-system/src/$1.ts'),
      },
      {
        find: '@brainstrike/file-system',
        replacement: path.resolve(import.meta.dirname, '../file-system/src/index.ts'),
      },
      {
        find: '@brainstrike/workers',
        replacement: path.resolve(import.meta.dirname, '../workers'),
      },
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: path.resolve(import.meta.dirname, '../workers/file-content-worker.ts'),
      },
    ],
  },
});
