import path from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@brainstrike\/utils\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, '../utils/src/$1.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: path.resolve(import.meta.dirname, '../utils/src'),
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
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    isolate: true,
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    testTimeout: 30_000,
  },
});
