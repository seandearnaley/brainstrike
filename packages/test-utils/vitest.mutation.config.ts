import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
// Relative import (not the package self-reference) — this IS @brainstrike/test-utils.
import { workspaceSrcAliases } from './workspace-src-aliases.mjs';

export default defineConfig({
  resolve: {
    // Stryker mutation lane: resolve workspace deps from SOURCE, not dist.
    // See ./workspace-src-aliases.mjs (incident #1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    environment: 'jsdom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}', '__tests__/**/*.test.{ts,tsx}'],
    isolate: true,
    // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
    maxWorkers: 1,
    pool: 'threads',
    reporters: [['default', { summary: false }]],
    setupFiles: ['src/vitest.setup.ts'],
    silent: true,
    testTimeout: 30_000,
  },
});
