import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Stryker mutation lane: resolve workspace deps (test-utils, types) from SOURCE, not
    // dist. See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    environment: 'node',
    exclude: [
      'node_modules',
      'dist',
      // Exclude the merge-coverage-script test as it depends on external scripts
      // that are not available in the Stryker sandbox environment
      'src/__tests__/merge-coverage-script.test.ts',
    ],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    reporters: 'basic',
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    silent: true,
  },
});
