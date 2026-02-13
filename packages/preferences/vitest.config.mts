import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  resolve: {
    alias: {
      '@brainstrike/agent/client': resolve(import.meta.dirname, '../agent/src/client.ts'),
      '@brainstrike/ui': resolve(import.meta.dirname, '../ui/src/index.ts'),
      '@brainstrike/hooks': resolve(import.meta.dirname, '../hooks/src/index.ts'),
      '@brainstrike/utils': resolve(import.meta.dirname, '../utils/src/index.ts'),
      '@brainstrike/db': resolve(import.meta.dirname, '../db/src/index.ts'),
      '@brainstrike/embeddings': resolve(import.meta.dirname, '../embeddings/src/index.ts'),
      '@brainstrike/storage': resolve(import.meta.dirname, '../storage/src/index.ts'),
      '@brainstrike/types': resolve(import.meta.dirname, '../types/src/index.ts'),
      '@brainstrike/workers/report-generation-worker': resolve(
        import.meta.dirname,
        '../workers/report-generation-worker.ts'
      ),
      '@brainstrike/file-system': resolve(import.meta.dirname, '../file-system/src/index.ts'),
    },
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
