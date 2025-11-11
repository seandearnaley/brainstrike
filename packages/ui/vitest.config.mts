import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Standardize to happy-dom for unit/integration UI tests (2025 baseline)
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // Use all available cores for faster test execution
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 4,
      },
    },
    // Coverage consolidated at root vitest.config.ts
  },
});
