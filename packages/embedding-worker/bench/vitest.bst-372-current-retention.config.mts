import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: workspaceSrcAliases(resolve(import.meta.dirname, '../..')),
  },
  test: {
    clearMocks: true,
    coverage: { enabled: false },
    environment: 'node',
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    include: ['bench/bst-372-current-retention.measurement.spec.ts'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
