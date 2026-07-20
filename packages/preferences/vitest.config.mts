import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@brainstrike\/assistant-contract\/(.*)$/,
        replacement: resolve(import.meta.dirname, '../assistant-contract/src/$1.ts'),
      },
      {
        find: '@brainstrike/assistant-contract',
        replacement: resolve(import.meta.dirname, '../assistant-contract/src/index.ts'),
      },
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
      // Registry fills the remaining workspace deps reached transitively from the
      // src-resolved graph (platform-utils via storage, context-actions via
      // hooks, queue via db, …). Hand-rolled entries above win by first-match.
      // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    coverage: {
      enabled: coverageEnabled,
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
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        branches: 60,
        functions: 60,
        lines: 70,
        statements: 70,
      },
    },
    environment: 'jsdom',
    globals: true,
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    pool: 'threads',
    setupFiles: [],
    testTimeout: 15_000, // UI component tests with async operations
  },
});
