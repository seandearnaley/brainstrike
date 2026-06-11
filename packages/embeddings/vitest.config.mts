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
    exclude: ['**/node_modules/**', '**/dist/**'],
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
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
  },
  resolve: {
    alias: {
      // Fix workspace resolution in tests: point directly to source to avoid build artifact issues
      '@brainstrike/db': resolve(__dirname, '../db/src/index.ts'),
      '@brainstrike/embedding-worker': resolve(__dirname, '../embedding-worker/src/index.ts'),
      '@brainstrike/indexing-contract': resolve(__dirname, '../indexing-contract/src/index.ts'),
      '@brainstrike/platform-utils': resolve(__dirname, '../platform-utils/src/index.ts'),
      '@brainstrike/queue/browser': resolve(__dirname, '../queue/src/browser.ts'),
      '@brainstrike/queue': resolve(__dirname, '../queue/src/index.ts'),
      '@brainstrike/types': resolve(__dirname, '../types/src/index.ts'),
      '@brainstrike/utils/token-counting-runtime': resolve(
        __dirname,
        '../utils/src/token-counting-runtime.ts'
      ),
      '@brainstrike/utils/logger': resolve(__dirname, '../utils/src/logger.ts'),
      '@brainstrike/utils/safe-storage': resolve(__dirname, '../utils/src/safe-storage.ts'),
      '@brainstrike/utils': resolve(__dirname, '../utils/src'),
    },
  },
});
