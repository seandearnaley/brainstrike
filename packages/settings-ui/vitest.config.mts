import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

export default defineConfig({
  resolve: {
    alias: workspaceSrcAliases(resolve(import.meta.dirname, '..')),
  },
  test: {
    coverage: {
      enabled: coverageEnabled,
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        'src/**/__tests__/**',
        '**/index.ts',
        'src/settings/models/model-selection-page.tsx',
      ],
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        branches: 60,
        functions: 60,
        lines: 70,
        statements: 70,
      },
    },
    environment: 'jsdom',
    globals: true,
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    pool: 'threads',
    setupFiles: [],
    testTimeout: 15_000,
  },
});
