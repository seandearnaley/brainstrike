import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['*.test.ts', '*.test.tsx', '**/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
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
  },
});
