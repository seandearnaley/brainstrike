import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/vitest.config.*',
        '**/vitest.mutation.config.*',
        '**/stryker.config.js',
        '**/tsup.config.ts',
        '**/.stryker-tmp/**',
        '**/src/index.ts', // Re-export file
      ],
      thresholds: {
        lines: 79,
        functions: 79,
        branches: 79,
        statements: 79,
      },
    },
  },
  resolve: {
    alias: {
      '@brainstrike/storage': path.resolve(__dirname, '../storage/src'),
      '@brainstrike/file-system': path.resolve(__dirname, '../file-system/src'),
    },
  },
});
