/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isCoverageRun =
  process.env.COVERAGE === 'true' ||
  process.env.VITEST_COVERAGE === 'true' ||
  process.argv.includes('--coverage');

const poolConfig = isCoverageRun
  ? {
      pool: 'threads' as const,
      poolOptions: {
        threads: {
          maxWorkers: 1,
          minWorkers: 1,
        },
      },
    }
  : {
      pool: 'forks' as const,
      poolOptions: {
        forks: {
          singleFork: false,
        },
      },
    };

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['../test-utils/src/vitest.setup.ts', './src/__tests__/setup-mock-queue.tsx'],
    unstubGlobals: true,
    ...poolConfig,
    coverage: {
      enabled: process.env.COVERAGE === 'true',
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
    },
  },
});
