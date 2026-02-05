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
    alias: {
      '@brainstrike/types': resolve(import.meta.dirname, '../types/src'),
      '@brainstrike/ui': resolve(import.meta.dirname, '../ui/src'),
      '@brainstrike/utils': resolve(import.meta.dirname, '../utils/src'),
      '@brainstrike/file-explorer': resolve(import.meta.dirname, '../file-explorer/src'),
      '@brainstrike/test-utils': resolve(import.meta.dirname, '../test-utils/src'),
      '@brainstrike/preferences': resolve(import.meta.dirname, '../preferences/src'),
      // Ensure test-utils dynamic import of Testing Library resolves under this workspace
      '@testing-library/react': resolve(import.meta.dirname, 'node_modules/@testing-library/react'),
      '@brainstrike/file-explorer-ui': resolve(import.meta.dirname, './src'),
    },
  },
});
