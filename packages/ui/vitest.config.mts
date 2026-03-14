import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@brainstrike/utils/create-debounce',
        replacement: resolve(import.meta.dirname, '../utils/src/create-debounce.ts'),
      },
      {
        find: '@brainstrike/utils/collator',
        replacement: resolve(import.meta.dirname, '../utils/src/collator.ts'),
      },
      {
        find: '@brainstrike/utils/env-utils',
        replacement: resolve(import.meta.dirname, '../utils/src/env-utils.ts'),
      },
      {
        find: '@brainstrike/utils/file-utils',
        replacement: resolve(import.meta.dirname, '../utils/src/file-utils.ts'),
      },
      {
        find: '@brainstrike/utils/filter-utils',
        replacement: resolve(import.meta.dirname, '../utils/src/filter-utils.ts'),
      },
      {
        find: '@brainstrike/utils/logger',
        replacement: resolve(import.meta.dirname, '../utils/src/logger.ts'),
      },
      {
        find: '@brainstrike/utils/quick-filter-utils',
        replacement: resolve(import.meta.dirname, '../utils/src/quick-filter-utils.ts'),
      },
      {
        find: '@brainstrike/utils/report-generator',
        replacement: resolve(import.meta.dirname, '../utils/src/report-generator.ts'),
      },
      {
        find: '@brainstrike/utils/safe-storage',
        replacement: resolve(import.meta.dirname, '../utils/src/safe-storage.ts'),
      },
      {
        find: '@brainstrike/hooks',
        replacement: resolve(import.meta.dirname, '../hooks/src/index.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: resolve(import.meta.dirname, '../utils/src/index.ts'),
      },
    ],
  },
  test: {
    // Standardize to happy-dom for unit/integration UI tests (2025 baseline)
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/__tests__/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    pool: 'threads',
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    coverage: {
      // Only include actual source files (not type declarations or dist)
      include: ['src/**/*.{ts,tsx}'],
      // Exclude pure type-definition files and test infrastructure
      // These contain only TypeScript types with no runtime code to test
      exclude: [
        '**/__tests__/**',
        '**/*.d.ts',
        '**/types.ts',
        '**/types/**',
        '**/dist/**',
        '**/index.ts', // Re-export files have no logic to test
      ],
    },
  },
});
