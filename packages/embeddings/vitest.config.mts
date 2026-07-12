import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  resolve: {
    alias: {
      // Fix workspace resolution in tests: point directly to source to avoid build artifact issues
      '@brainstrike/db': resolve(__dirname, '../db/src/index.ts'),
      '@brainstrike/embedding-worker': resolve(__dirname, '../embedding-worker/src/index.ts'),
      '@brainstrike/indexing-contract': resolve(__dirname, '../indexing-contract/src/index.ts'),
      '@brainstrike/platform-utils': resolve(__dirname, '../platform-utils/src/index.ts'),
      '@brainstrike/queue': resolve(__dirname, '../queue/src/index.ts'),
      '@brainstrike/queue/browser': resolve(__dirname, '../queue/src/browser.ts'),
      '@brainstrike/types': resolve(__dirname, '../types/src/index.ts'),
      '@brainstrike/utils': resolve(__dirname, '../utils/src'),
      '@brainstrike/utils/logger': resolve(__dirname, '../utils/src/logger.ts'),
      '@brainstrike/utils/token-counting-runtime': resolve(
        __dirname,
        '../utils/src/token-counting-runtime.ts'
      ),
    },
  },
  test: {
    coverage: {
      enabled: coverageEnabled,
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/dist/**',
        '**/node_modules/**',
        'src/cli/**',
        'bin/**',
      ],
      include: ['src/**/*.{ts,tsx}'],
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      reportsDirectory: './coverage',
    },
    environment: 'node',
    // Exclude integration tests by default (they require model downloads)
    exclude: ['**/node_modules/**', '**/dist/**'],
    // PGlite WASM init + migrate inside beforeEach hooks exceeds the 10s
    // default under loaded CI runners (embedding-worker-db-completion.test.ts
    // failed this way twice on whole-repo Unit runs); 30s matches
    // packages/db's heavy-lane precedent (vitest.config.mts hookTimeout).
    hookTimeout: 30_000,
    // Allow running integration tests with --run integration
    // Use: npx vitest run --reporter=verbose --testNamePattern="integration"
    // Or set environment variable: VITEST_RUN_INTEGRATION=true
    include: process.env.VITEST_RUN_INTEGRATION
      ? ['**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}']
      : ['**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', '!**/*.integration.test.*'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    // Use forks pool with parallelization for better performance
    pool: 'forks',
    testTimeout: 30_000,
  },
});
