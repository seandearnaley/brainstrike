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
        find: '@brainstrike/storage',
        replacement: path.resolve(import.meta.dirname, '../storage/src'),
      },
      {
        find: '@brainstrike/file-system',
        replacement: path.resolve(import.meta.dirname, '../file-system/src'),
      },
      {
        find: '@brainstrike/logging',
        replacement: path.resolve(import.meta.dirname, '../logging/src/index.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: path.resolve(import.meta.dirname, '../utils/src'),
      },
      {
        find: '@brainstrike/types',
        replacement: path.resolve(import.meta.dirname, '../types/src'),
      },
      {
        find: '@brainstrike/platform-utils',
        replacement: path.resolve(import.meta.dirname, '../platform-utils/src'),
      },
      ...workspaceSrcAliases(path.resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    // Coverage consolidated at root vitest.config.mts
    coverage: {
      enabled:
        process.env['COVERAGE'] !== 'false' &&
        (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true'),
      exclude: [
        '**/*.d.ts',
        '**/*.config.*',
        '**/dist/**',
        'src/index.ts',
        'src/constants/index.ts',
        'src/types/store-types.ts',
      ],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      provider: 'v8',
    },
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
    maxWorkers: 1,
    // Use threads with single worker to avoid Tinypool EPIPE under Node 22 in CI
    pool: 'threads',
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  },
});
