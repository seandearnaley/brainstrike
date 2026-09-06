import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import LostTestFileReporter from './vitest-lost-file-reporter.mjs';
// Relative import (not the package self-reference) — this IS @brainstrike/test-utils.
import { workspaceSrcAliases } from './workspace-src-aliases.mjs';

export default defineConfig({
  resolve: {
    // Resolve workspace deps (@brainstrike/types) from SOURCE, not built dist.
    // See ./workspace-src-aliases.mjs (incident #1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}', '__tests__/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['src/vitest.setup.ts'],
  },
});
