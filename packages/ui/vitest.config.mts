import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Standardize to happy-dom for unit/integration UI tests (2025 baseline)
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/__tests__/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // Use all available cores for faster test execution
    pool: 'threads',
    // Vitest 4: use maxWorkers instead of poolOptions.threads.maxThreads
    maxWorkers: 4,
    coverage: {
      // Only include actual source files (not type declarations or dist)
      include: ['src/**/*.{ts,tsx}'],
      // Exclude pure type-definition files and test infrastructure
      // These contain only TypeScript types with no runtime code to test
      exclude: [
        '**/__tests__/**',
        '**/*.d.ts',
        '**/types.ts',
        '**/types/**',
        '**/dist/**',
        '**/index.ts', // Re-export files have no logic to test
      ],
    },
  },
});
