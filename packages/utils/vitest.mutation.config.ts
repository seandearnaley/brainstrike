import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    silent: true,
    reporters: 'basic',
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: [
      'node_modules',
      'dist',
      // Exclude the merge-coverage-script test as it depends on external scripts
      // that are not available in the Stryker sandbox environment
      'src/__tests__/merge-coverage-script.test.ts',
    ],
  },
});
