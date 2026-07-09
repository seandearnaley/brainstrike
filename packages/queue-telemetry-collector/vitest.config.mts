/// <reference types="vitest" />
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@brainstrike/queue': resolve(import.meta.dirname, '../queue/src/index.ts'),
      '@brainstrike/utils': resolve(import.meta.dirname, '../utils/src'),
      '@brainstrike/utils/logger': resolve(import.meta.dirname, '../utils/src/logger.ts'),
      '@brainstrike/utils/token-counting-runtime': resolve(
        import.meta.dirname,
        '../utils/src/token-counting-runtime.ts'
      ),
    },
  },
  test: {
    clearMocks: true,
    coverage: {
      enabled: process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true',
      exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      provider: 'v8',
    },
    environment: 'node',
    exclude: ['dist', 'node_modules'],
    globals: true,
    include: ['test/**/*.spec.ts'],
    restoreMocks: true,
  },
});
