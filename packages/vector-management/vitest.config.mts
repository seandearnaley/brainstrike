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
    alias: {
      '@brainstrike/utils': resolve(__dirname, '../utils/src/index.ts'),
      '@brainstrike/embeddings/runtime-config': resolve(
        __dirname,
        '../embeddings/src/runtime-config.ts'
      ),
      '@brainstrike/embeddings/provider-core': resolve(
        __dirname,
        '../embeddings/src/provider-core.ts'
      ),
      '@brainstrike/embeddings/backend': resolve(__dirname, '../embeddings/src/backend-entry.ts'),
      '@brainstrike/embeddings/factory': resolve(__dirname, '../embeddings/src/factory-entry.ts'),
      '@brainstrike/embeddings/service': resolve(__dirname, '../embeddings/src/service-entry.ts'),
      '@brainstrike/embeddings/worker': resolve(__dirname, '../embeddings/src/worker-entry.ts'),
      '@brainstrike/queue/browser': resolve(__dirname, '../queue/src/browser.ts'),
      '@brainstrike/queue': resolve(__dirname, '../queue/src/index.ts'),
      '@brainstrike/agent/client': resolve(__dirname, '../agent/src/client.ts'),
      '@brainstrike/preferences': resolve(__dirname, '../preferences/src/index.ts'),
    },
  },
});
