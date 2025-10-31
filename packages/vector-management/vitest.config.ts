/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

const poolConfig = {
  pool: 'forks' as const,
  poolOptions: {
    forks: {
      minForks: 1,
      maxForks: 4,
      execArgv: ['--max-old-space-size=8192'],
    },
  },
};

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['../test-utils/src/vitest.setup.ts', './src/__tests__/setup-mock-queue.tsx'],
    unstubGlobals: true,
    // Disable isolation for fast unit tests to eliminate 50-200ms overhead per test
    isolate: false,
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
      '@brainstrike/queue': resolve(__dirname, '../queue/src/index.ts'),
      '@brainstrike/agent/client': resolve(__dirname, '../agent/src/client.ts'),
      '@brainstrike/preferences': resolve(__dirname, '../preferences/src/index.ts'),
    },
  },
});
