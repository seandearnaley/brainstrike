import { resolve } from 'node:path';
import { testBase } from '@brainstrike/test-utils/vitest.base';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import type { InlineConfig } from 'vitest';
import { defineConfig } from 'vitest/config';
// NOTE: TypeScript can get confused about Vitest type identities under pnpm workspaces.
// Casting `test` here avoids noisy editor errors without affecting runtime behavior.

export default defineConfig({
  resolve: {
    alias: [
      {
        // Anchored exact-match: a bare-string find PREFIX-matches every
        // subpath ('@brainstrike/db/react' would resolve inside index.ts —
        // review #2164). Subpaths fall through to workspaceSrcAliases, which
        // derives them from the exports map.
        find: /^@brainstrike\/db$/,
        replacement: resolve(import.meta.dirname, '../db/src/index.ts'),
      },
      {
        find: '@brainstrike/types',
        replacement: resolve(import.meta.dirname, '../types/src'),
      },
      {
        find: '@brainstrike/ui',
        replacement: resolve(import.meta.dirname, '../ui/src'),
      },
      {
        find: '@brainstrike/utils/crypto',
        replacement: resolve(import.meta.dirname, '../utils/src/crypto.ts'),
      },
      {
        find: /^@brainstrike\/utils\/(.*)$/,
        replacement: resolve(import.meta.dirname, '../utils/src/$1.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: resolve(import.meta.dirname, '../utils/src'),
      },
      {
        find: '@brainstrike/storage',
        replacement: resolve(import.meta.dirname, '../storage/src/index.ts'),
      },
      {
        find: '@brainstrike/file-explorer',
        replacement: resolve(import.meta.dirname, '../file-explorer/src'),
      },
      {
        find: '@brainstrike/file-explorer-hooks',
        replacement: resolve(import.meta.dirname, '../file-explorer-hooks/src/index.ts'),
      },
      {
        find: '@brainstrike/hooks',
        replacement: resolve(import.meta.dirname, '../hooks/src/index.ts'),
      },
      {
        find: '@brainstrike/test-utils',
        replacement: resolve(import.meta.dirname, '../test-utils/src'),
      },
      {
        find: '@testing-library/react',
        replacement: resolve(import.meta.dirname, 'node_modules/@testing-library/react'),
      },
      {
        find: '@brainstrike/file-explorer-ui',
        replacement: resolve(import.meta.dirname, './src'),
      },
      {
        // Anchored: a bare-string find would also capture the
        // './commands' subpath export, which the registry spread resolves.
        find: /^@brainstrike\/context-actions$/,
        replacement: resolve(import.meta.dirname, '../context-actions/src/index.ts'),
      },
      // @brainstrike/workers has no src/ dir (worker files at the package root),
      // so the registry skips it; alias its remaining subpath explicitly.
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: resolve(import.meta.dirname, '../workers/file-content-worker.ts'),
      },
      // Registry fills the remaining workspace deps (file-system,
      // token-cache, file-tree-worker, workers, platform-utils transitively, …)
      // from SOURCE. Hand-rolled entries above win by first-match ordering.
      // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  // Cast mitigates TS2769 type identity noise in some editors
  test: {
    ...testBase,
    // Default to happy-dom for speed; jsdom-only suites should annotate at file top
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    // Keep isolation to avoid cross-file state until a deeper audit completes
    isolate: true,
    // Switch to threads to reduce memory/startup overhead
    pool: 'threads',
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: [
      ...(testBase.setupFiles ?? []),
      resolve(import.meta.dirname, './src/__tests__/setup/suppress-token-utils-warnings.ts'),
    ],
    testTimeout: 30_000,
  } as InlineConfig,
});
