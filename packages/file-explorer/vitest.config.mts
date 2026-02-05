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
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**'],
    },
  },
  resolve: {
    alias: {
      '@brainstrike/storage': path.resolve(import.meta.dirname, '../storage/src'),
      '@brainstrike/file-system': path.resolve(import.meta.dirname, '../file-system/src'),
      '@brainstrike/utils': path.resolve(import.meta.dirname, '../utils/src'),
      '@brainstrike/types': path.resolve(import.meta.dirname, '../types/src'),
      '@brainstrike/platform-utils': path.resolve(import.meta.dirname, '../platform-utils/src'),
    },
  },
});
