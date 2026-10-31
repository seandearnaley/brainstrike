import { resolve } from 'node:path';
import { testBase } from '@brainstrike/test-utils/vitest.base';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import type { InlineConfig } from 'vitest';
import { defineConfig } from 'vitest/config';
// NOTE: TypeScript can get confused about Vitest type identities under pnpm workspaces.
// Casting `test` here avoids noisy editor errors without affecting runtime behavior.

export default defineConfig({
  plugins: [reactCompiler()],
  resolve: {
    alias: [
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
        find: /^@brainstrike\/utils\/(.*)$/u,
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
        find: /^@brainstrike\/context-actions$/u,
        replacement: resolve(import.meta.dirname, '../context-actions/src/index.ts'),
      },
      // @brainstrike/workers has no src/ dir (worker files at the package root),
      // so the registry skips it; alias its remaining subpath explicitly.
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: resolve(import.meta.dirname, '../workers/file-content-worker.ts'),
      },
    ],
  },
  // Cast mitigates TS2769 type identity noise in some editors
  test: {
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    ...testBase,
    // Default to happy-dom for speed; jsdom-only suites should annotate at file top
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    // Keep isolation to avoid cross-file state until a deeper audit completes
    isolate: true,
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: [
      ...(testBase.setupFiles ?? []),
      resolve(import.meta.dirname, './src/__tests__/setup/suppress-token-utils-warnings.ts'),
    ],
    testTimeout: 30_000,
  } as InlineConfig,
});
