import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Exclude integration tests by default (they require model downloads)
    // Also exclude CLI tests from unit runs; they are exercised separately.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.integration.test.*',
      '**/src/__tests__/cli.*.test.*',
    ],
    // Set a reasonable timeout for unit tests
    testTimeout: 10000,
    // Allow running integration tests with --run integration
    // Use: npx vitest run --reporter=verbose --testNamePattern="integration"
    // Or set environment variable: VITEST_RUN_INTEGRATION=true
    include: process.env.VITEST_RUN_INTEGRATION
      ? ['**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}']
      : ['**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', '!**/*.integration.test.*'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'lcov', 'json'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/dist/**',
        '**/node_modules/**',
        'src/cli/**',
        'bin/**',
      ],
    },
    // Keep memory bounded by using a single forked process for tests
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
