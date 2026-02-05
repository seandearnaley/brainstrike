import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  resolve: {
    alias: {
      '@brainstrike/agent/client': resolve(__dirname, '../agent/src/client.ts'),
      '@brainstrike/ui': resolve(__dirname, '../ui/src/index.ts'),
      '@brainstrike/hooks': resolve(__dirname, '../hooks/src/index.ts'),
      '@brainstrike/utils': resolve(__dirname, '../utils/src/index.ts'),
      '@brainstrike/db': resolve(__dirname, '../db/src/index.ts'),
      '@brainstrike/embeddings': resolve(__dirname, '../embeddings/src/index.ts'),
      '@brainstrike/storage': resolve(__dirname, '../storage/src/index.ts'),
      '@brainstrike/types': resolve(__dirname, '../types/src/index.ts'),
      '@brainstrike/workers/report-generation-worker': resolve(
        __dirname,
        '../workers/report-generation-worker.ts'
      ),
      '@brainstrike/file-system': resolve(__dirname, '../file-system/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [],
    testTimeout: 15_000, // UI component tests with async operations
    pool: 'threads',
    // Vitest 4: use maxWorkers instead of poolOptions.threads.maxThreads
    maxWorkers: 4,
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
