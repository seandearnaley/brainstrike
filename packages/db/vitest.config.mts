import { defineConfig } from 'vitest/config';

/**
 * October 2025 Vitest configuration for @brainstrike/db
 *
 * All tests now use PGlite snapshot pattern for:
 * - 60-70% faster execution
 * - Consistent CI/local behavior
 * - Proper WASM loading without file:// URL issues
 *
 * CI exclusions removed - all tests run in CI with realistic timeouts.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    env: {
      TEST_PGLITE_MOCK: 'true',
    },
    pool: 'threads',
    poolOptions: {
      threads: {
        // DB/WASM interactions require deterministic ordering and avoid races
        // Keep singleThread to ensure stability across environments/CI
        singleThread: true,
      },
    },
    // October 2025: Reduced timeouts with snapshot pattern
    hookTimeout: 10000, // 10 seconds for hooks (down from 30s)
    testTimeout: 10000, // 10 seconds for tests (down from 20s)
  },
});
