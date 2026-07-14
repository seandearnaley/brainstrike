/// <reference types="vitest" />
import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps (queue, utils) from SOURCE, not dist.
    // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
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
