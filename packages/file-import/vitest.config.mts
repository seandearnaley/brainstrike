import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasMap } from '../agent/config/browser-safe-subpath-aliases.mjs';

export default defineConfig({
  resolve: {
    alias: {
      ...createAgentBrowserSafeAliasMap(resolve(import.meta.dirname, '../agent')),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    pool: 'threads',
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    // Coverage consolidated at root vitest.config.mts
    coverage: {
      enabled: process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true',
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**'],
    },
  },
});
