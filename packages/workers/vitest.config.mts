import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
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
