import { coverageEnabled, sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
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
      exclude: ['**/node_modules/**', '**/dist/**'],
      // Anchor the __tests__ glob at the package root — this package is flat (no
      // src/), matching vitest.mutation.config.ts. The leading '**/' is the escape
      // mechanism: '**/__tests__/**' walks the pnpm symlink farm under node_modules
      // and picks up third-party and sibling-workspace specs (394 files here)
      // whenever the exclude list stops matching, so the include must not be the
      // only guard.
      include: ['*.test.ts', '*.test.tsx', '__tests__/**/*.test.{ts,tsx}'],
      setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
    },
  })
);
