import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps (@brainstrike/utils subpaths) from SOURCE, not dist.
    // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
  },
});
