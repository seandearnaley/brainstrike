import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps (@brainstrike/test-utils, @brainstrike/types, and
    // this package's own @brainstrike/utils subpaths) from SOURCE, not dist.
    // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    coverage: {
      exclude: ['src/__tests__/**', 'dist/**', 'node_modules/**'],
      include: ['src/**/*.{ts,tsx}'],
    },
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    hookTimeout: 15_000,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
    testTimeout: 30_000,
  },
});
