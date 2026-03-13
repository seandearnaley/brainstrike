/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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
        find: '@brainstrike/utils/token-counting-runtime',
        replacement: resolve(__dirname, '../utils/src/token-counting-runtime.ts'),
      },
      {
        find: '@brainstrike/utils/logger',
        replacement: resolve(__dirname, '../utils/src/logger.ts'),
      },
      {
        find: '@brainstrike/utils/safe-storage',
        replacement: resolve(__dirname, '../utils/src/safe-storage.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: resolve(__dirname, '../utils/src/index.ts'),
      },
      {
        find: '@brainstrike/embeddings/runtime-config',
        replacement: resolve(__dirname, '../embeddings/src/runtime-config.ts'),
      },
      {
        find: '@brainstrike/embeddings/provider-core',
        replacement: resolve(__dirname, '../embeddings/src/provider-core.ts'),
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
      {
        find: '@brainstrike/agent/client',
        replacement: resolve(__dirname, '../agent/src/client.ts'),
      },
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
