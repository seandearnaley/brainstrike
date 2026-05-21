/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasEntries } from '../agent/config/browser-safe-subpath-aliases.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

// Vitest 4: use maxWorkers instead of poolOptions
const poolConfig = {
  pool: 'forks' as const,
  // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
  maxWorkers: process.env['CI'] ? '50%' : '100%',
};

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['../test-utils/src/vitest.setup.ts', './src/__tests__/setup-mock-queue.tsx'],
    unstubGlobals: true,
    ...poolConfig,
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
        '**/vector-status.tsx', // Large UI component - business logic tested via extracted hooks
        '**/vector-status-with-dialog.tsx', // Wrapper component - tested via integration
        'src/embedding-set-management/**', // UI dialog components - tested via integration
      ],
      thresholds: {
        lines: 70,
        functions: 60,
        branches: 60,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: [
      {
        find: '@brainstrike/workers/report-generation-worker',
        replacement: resolve(__dirname, '../workers/report-generation-worker.ts'),
      },
      {
        find: '@brainstrike/hooks',
        replacement: resolve(__dirname, '../hooks/src/index.ts'),
      },
      {
        find: '@brainstrike/ui',
        replacement: resolve(__dirname, '../ui/src/index.ts'),
      },
      {
        find: '@brainstrike/utils/create-debounce',
        replacement: resolve(__dirname, '../utils/src/create-debounce.ts'),
      },
      {
        find: '@brainstrike/utils/collator',
        replacement: resolve(__dirname, '../utils/src/collator.ts'),
      },
      {
        find: '@brainstrike/utils/file-utils',
        replacement: resolve(__dirname, '../utils/src/file-utils.ts'),
      },
      {
        find: '@brainstrike/utils/filter-utils',
        replacement: resolve(__dirname, '../utils/src/filter-utils.ts'),
      },
      {
        find: '@brainstrike/utils/quick-filter-utils',
        replacement: resolve(__dirname, '../utils/src/quick-filter-utils.ts'),
      },
      {
        find: '@brainstrike/utils/report-generator',
        replacement: resolve(__dirname, '../utils/src/report-generator.ts'),
      },
      {
        find: '@brainstrike/utils/token-counting-runtime',
        replacement: resolve(__dirname, '../utils/src/token-counting-runtime.ts'),
      },
      {
        find: '@brainstrike/utils/logger',
        replacement: resolve(__dirname, '../utils/src/logger.ts'),
      },
      {
        find: '@brainstrike/utils/logging-preferences',
        replacement: resolve(__dirname, '../utils/src/logging-preferences.ts'),
      },
      {
        find: '@brainstrike/utils/env-utils',
        replacement: resolve(__dirname, '../utils/src/env-utils.ts'),
      },
      {
        find: '@brainstrike/utils/safe-storage',
        replacement: resolve(__dirname, '../utils/src/safe-storage.ts'),
      },
      {
        find: /^@brainstrike\/utils\/(.*)$/,
        replacement: resolve(__dirname, '../utils/src/$1.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: resolve(__dirname, '../utils/src'),
      },
      {
        find: '@brainstrike/embeddings/runtime-config',
        replacement: resolve(__dirname, '../embeddings/src/runtime-config.ts'),
      },
      {
        find: '@brainstrike/indexing-contract',
        replacement: resolve(__dirname, '../indexing-contract/src'),
      },
      {
        find: '@brainstrike/embeddings/backend',
        replacement: resolve(__dirname, '../embeddings/src/backend-entry.ts'),
      },
      {
        find: '@brainstrike/embeddings/factory',
        replacement: resolve(__dirname, '../embeddings/src/factory-entry.ts'),
      },
      {
        find: '@brainstrike/embeddings/service',
        replacement: resolve(__dirname, '../embeddings/src/service-entry.ts'),
      },
      {
        find: '@brainstrike/embeddings/worker',
        replacement: resolve(__dirname, '../embeddings/src/worker-entry.ts'),
      },
      {
        find: '@brainstrike/queue/browser',
        replacement: resolve(__dirname, '../queue/src/browser.ts'),
      },
      {
        find: '@brainstrike/queue',
        replacement: resolve(__dirname, '../queue/src/index.ts'),
      },
      ...createAgentBrowserSafeAliasEntries(resolve(__dirname, '../agent')),
      {
        find: /^@brainstrike\/preferences\/(.*)$/,
        replacement: resolve(__dirname, '../preferences/src/$1'),
      },
      {
        find: '@brainstrike/preferences',
        replacement: resolve(__dirname, '../preferences/src/index.ts'),
      },
    ],
  },
});
