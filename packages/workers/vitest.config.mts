import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

export default defineConfig({
  resolve: {
    // Resolve workspace deps (file-system, types, utils, test-utils) from SOURCE,
    // not dist. See @brainstrike/test-utils/workspace-src-aliases (#1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    coverage: {
      enabled: coverageEnabled,
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__tests__/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/*.config.*',
        '**/vitest.*',
        'stryker.config.js',
        'test-helpers.ts',
      ],
    },
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: true,
    // Anchor the __tests__ glob at the package root — this package is flat (no
    // src/), matching vitest.mutation.config.ts. The leading '**/' is the escape
    // mechanism: '**/__tests__/**' walks the pnpm symlink farm under node_modules
    // and picks up third-party and sibling-workspace specs (394 files here)
    // whenever the exclude list stops matching, so the include must not be the
    // only guard.
    include: ['*.test.ts', '*.test.tsx', '__tests__/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  },
});
