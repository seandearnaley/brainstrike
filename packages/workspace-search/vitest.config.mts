/// <reference types="vitest" />
import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // @brainstrike/workers has no src/ dir (worker files live at the package
      // root), so the registry skips it; alias it explicitly like the other
      // consumers do. Now reached transitively via the src-resolved
      // file-explorer-ui -> file-explorer-hooks file-content-processor.
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: resolve(import.meta.dirname, '../workers/file-content-worker.ts'),
      },
    ],
  },
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  },
});
