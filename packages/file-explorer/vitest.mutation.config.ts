import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [
      'node_modules',
      'dist',
      // Standard excludes for Stryker compatibility
    ],
    globals: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    reporters: 'basic',
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    silent: true,
  },
});
