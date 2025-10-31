import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Standardize to happy-dom for unit/integration UI tests (2025 baseline)
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // Disable isolation for fast unit tests to eliminate 50-200ms overhead per test
    isolate: false,
    // Cap threads to improve stability across environments
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 2,
      },
    },
    // Coverage consolidated at root vitest.config.ts
  },
});
