import { resolve } from 'node:path';
import { testBase } from '@brainstrike/test-utils/vitest.base';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    ...testBase,
    // Keep jsdom for this package for now; revisit after verification
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // Switch to threads to reduce memory/startup overhead
    pool: 'threads',
    // Retain isolation and timeout until flaky cases are audited
    isolate: true,
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@brainstrike/types': resolve(__dirname, '../types/src'),
      '@brainstrike/ui': resolve(__dirname, '../ui/src'),
      '@brainstrike/utils': resolve(__dirname, '../utils/src'),
      '@brainstrike/file-explorer': resolve(__dirname, '../file-explorer/src'),
      '@brainstrike/file-explorer-ui': resolve(__dirname, './src'),
    },
  },
});
