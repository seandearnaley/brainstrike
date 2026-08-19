import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps (indexing-contract, text-splitter, utils) from
    // SOURCE, not dist. See workspace-src-aliases (incident #1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['__tests__/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: 10_000,
  },
});
