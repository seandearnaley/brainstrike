import path from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
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
      // Registry fills the remaining workspace deps (types, hooks, storage,
      // platform-utils, file-explorer, test-utils, …) from SOURCE. Hand-rolled
      // entries above win by first-match. See workspace-src-aliases (#1066/#1207).
      ...workspaceSrcAliases(path.resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    isolate: true,
    // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
    maxWorkers: 1,
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    testTimeout: 30_000,
  },
});
