import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

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
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['*.test.ts', '*.test.tsx', '**/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  },
});
