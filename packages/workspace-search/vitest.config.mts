/// <reference types="vitest" />
import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps (db, storage, types, ui, utils, file-explorer-ui
    // subpaths, preferences stores) from SOURCE, not built dist.
    // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
    alias: [
      // @brainstrike/workers has no src/ dir (worker files live at the package
      // root), so the registry skips it; alias it explicitly like the other
      // consumers do. Now reached transitively via the src-resolved
      // file-explorer-ui -> file-explorer-hooks file-content-processor.
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: resolve(import.meta.dirname, '../workers/file-content-worker.ts'),
      },
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  },
});
