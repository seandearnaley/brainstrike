import { resolve } from 'node:path';
import { testBase } from '@brainstrike/test-utils/vitest.base';
import type { InlineConfig } from 'vitest';
import { defineConfig } from 'vitest/config';
// NOTE: TypeScript can get confused about Vitest type identities under pnpm workspaces.
// Casting `test` here avoids noisy editor errors without affecting runtime behavior.

export default defineConfig({
  // Cast mitigates TS2769 type identity noise in some editors
  test: {
    ...testBase,
    setupFiles: [
      ...(testBase.setupFiles ?? []),
      resolve(import.meta.dirname, './src/__tests__/setup/suppress-token-utils-warnings.ts'),
    ],
    // Default to happy-dom for speed; jsdom-only suites should annotate at file top
    environment: 'happy-dom',
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // Switch to threads to reduce memory/startup overhead
    pool: 'threads',
    // Keep isolation to avoid cross-file state until a deeper audit completes
    isolate: true,
    testTimeout: 30_000,
  } as InlineConfig,
  resolve: {
    alias: [
      {
        find: /^@brainstrike\/preferences\/(.*)$/,
        replacement: resolve(import.meta.dirname, '../preferences/src/$1'),
      },
      {
        find: '@brainstrike/preferences',
        replacement: resolve(import.meta.dirname, '../preferences/src/index.ts'),
      },
      {
        find: '@brainstrike/db',
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
        find: '@brainstrike/utils/token-counting-runtime',
        replacement: resolve(import.meta.dirname, '../utils/src/token-counting-runtime.ts'),
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
        find: '@brainstrike/utils/logger',
        replacement: resolve(import.meta.dirname, '../utils/src/logger.ts'),
      },
      {
        find: '@brainstrike/utils/safe-storage',
        replacement: resolve(import.meta.dirname, '../utils/src/safe-storage.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: resolve(import.meta.dirname, '../utils/src'),
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
        find: '@brainstrike/context-actions',
        replacement: resolve(import.meta.dirname, '../context-actions/src/index.ts'),
      },
    ],
  },
});
