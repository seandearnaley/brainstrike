import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@brainstrike/indexing-contract': resolve(import.meta.dirname, '../indexing-contract/src'),
    },
  },
  test: {
    // Coverage consolidated at root vitest.config.mts
    coverage: {
      enabled: process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true',
      exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      provider: 'v8',
    },
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    pool: 'threads',
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts'],
  },
});
