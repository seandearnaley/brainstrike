import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // Use threads with single worker to avoid Tinypool EPIPE under Node 22 in CI
    pool: 'threads',
    // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
    maxWorkers: 1,
    // Coverage consolidated at root vitest.config.mts
    coverage: {
      enabled: process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true',
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        '**/*.d.ts',
        '**/*.config.*',
        '**/dist/**',
        'src/index.ts',
        'src/constants/index.ts',
        'src/types/store-types.ts',
      ],
    },
  },
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
    ],
  },
});
