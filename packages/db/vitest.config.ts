import { defineConfig } from 'vitest/config';

// In CI, skip tests that require real PGlite due to WASM compatibility issues
const isCI = process.env.CI === 'true';

const excludePatterns = ['node_modules', 'dist'];

if (isCI) {
  // In CI, exclude tests that require real database functionality due to WASM issues
  excludePatterns.push(
    '__tests__/file-chunk-repository.test.ts',
    '__tests__/file-record-repository.test.ts',
    '__tests__/migration-*.test.ts',
    '__tests__/repository-factory.test.ts',
    '__tests__/db-provider-migration.test.tsx',
    '__tests__/wasm-loader-coverage.test.ts'
  );
}

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['__tests__/**/*.test.{ts,tsx}'],
    exclude: excludePatterns,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    hookTimeout: 30000, // 30 seconds for hooks
    testTimeout: 20000, // 20 seconds for tests
  },
});
