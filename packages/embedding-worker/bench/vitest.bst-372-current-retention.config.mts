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
    globals: true,
    include: ['bench/bst-372-current-retention.measurement.spec.ts'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
