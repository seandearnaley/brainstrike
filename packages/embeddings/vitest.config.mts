import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    environment: 'node',
    // Exclude integration tests by default (they require model downloads)
    // Also exclude CLI tests from unit runs; they are exercised separately.
    exclude: ['**/node_modules/**', '**/dist/**', '**/src/__tests__/cli.*.test.*'],
    // Set a reasonable timeout for unit tests
    testTimeout: 10_000,
    // Allow running integration tests with --run integration
    // Use: npx vitest run --reporter=verbose --testNamePattern="integration"
    // Or set environment variable: VITEST_RUN_INTEGRATION=true
    include: process.env.VITEST_RUN_INTEGRATION
      ? ['**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}']
      : ['**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', '!**/*.integration.test.*'],
    coverage: {
      enabled: coverageEnabled,
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'lcov', 'json'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/dist/**',
        '**/node_modules/**',
        'src/cli/**',
        'bin/**',
      ],
    },
    // Use forks pool with parallelization for better performance
    pool: 'forks',
    // Vitest 4: use maxWorkers instead of poolOptions.forks.maxForks
    maxWorkers: 4,
  },
  resolve: {
    alias: {
      '@brainstrike/db': resolve(__dirname, '../db/src/index.ts'),
      '@brainstrike/embedding-worker': resolve(__dirname, '../embedding-worker/src/index.ts'),
      '@brainstrike/queue': resolve(__dirname, '../queue/src/index.ts'),
      '@brainstrike/types': resolve(__dirname, '../types/src/index.ts'),
      '@brainstrike/utils': resolve(__dirname, '../utils/src/index.ts'),
    },
  },
});
