import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasEntries } from '../agent/config/browser-safe-subpath-aliases.mjs';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@brainstrike/embeddings/provider-core',
        replacement: resolve(import.meta.dirname, '../embeddings/src/provider-core.ts'),
      },
      {
        find: '@brainstrike/embeddings/service',
        replacement: resolve(import.meta.dirname, '../embeddings/src/service-entry.ts'),
      },
      {
        find: '@brainstrike/embeddings/factory',
        replacement: resolve(import.meta.dirname, '../embeddings/src/factory-entry.ts'),
      },
      ...createAgentBrowserSafeAliasEntries(resolve(import.meta.dirname, '../agent')),
      {
        find: '@brainstrike/ui',
        replacement: resolve(import.meta.dirname, '../ui/src/index.ts'),
      },
      {
        find: '@brainstrike/hooks',
        replacement: resolve(import.meta.dirname, '../hooks/src/index.ts'),
      },
      {
        find: '@brainstrike/indexing-contract',
        replacement: resolve(import.meta.dirname, '../indexing-contract/src/index.ts'),
      },
      {
        find: '@brainstrike/utils/token-counting-runtime',
        replacement: resolve(import.meta.dirname, '../utils/src/token-counting-runtime.ts'),
      },
      {
        find: '@brainstrike/utils/create-debounce',
        replacement: resolve(import.meta.dirname, '../utils/src/create-debounce.ts'),
      },
      {
        find: '@brainstrike/utils/collator',
        replacement: resolve(import.meta.dirname, '../utils/src/collator.ts'),
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
        find: '@brainstrike/utils/logging-preferences',
        replacement: resolve(import.meta.dirname, '../utils/src/logging-preferences.ts'),
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
        find: '@brainstrike/utils/env-utils',
        replacement: resolve(import.meta.dirname, '../utils/src/env-utils.ts'),
      },
      {
        find: '@brainstrike/utils/file-utils',
        replacement: resolve(import.meta.dirname, '../utils/src/file-utils.ts'),
      },
      {
        find: '@brainstrike/utils/safe-storage',
        replacement: resolve(import.meta.dirname, '../utils/src/safe-storage.ts'),
      },
      {
        find: /^@brainstrike\/utils\/(.*)$/,
        replacement: resolve(import.meta.dirname, '../utils/src/$1.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: resolve(import.meta.dirname, '../utils/src'),
      },
      {
        find: '@brainstrike/db',
        replacement: resolve(import.meta.dirname, '../db/src/index.ts'),
      },
      {
        find: '@brainstrike/embeddings',
        replacement: resolve(import.meta.dirname, '../embeddings/src/index.ts'),
      },
      {
        find: '@brainstrike/storage',
        replacement: resolve(import.meta.dirname, '../storage/src/index.ts'),
      },
      {
        find: '@brainstrike/types',
        replacement: resolve(import.meta.dirname, '../types/src/index.ts'),
      },
      {
        find: '@brainstrike/workers/report-generation-worker',
        replacement: resolve(import.meta.dirname, '../workers/report-generation-worker.ts'),
      },
      {
        find: '@brainstrike/file-system',
        replacement: resolve(import.meta.dirname, '../file-system/src/index.ts'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [],
    testTimeout: 15_000, // UI component tests with async operations
    pool: 'threads',
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    coverage: {
      enabled: coverageEnabled,
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData/**',
        'src/**/__tests__/**',
        '**/index.ts', // Barrel files - re-exports are tested via their sources
        // Complex UI components with Radix primitives - tested via app-level integration tests
        'src/settings/models/model-selection-page.tsx',
        'src/settings/secrets/llm-keys-settings.tsx',
      ],
      thresholds: {
        lines: 70,
        functions: 60,
        branches: 60,
        statements: 70,
      },
    },
  },
});
