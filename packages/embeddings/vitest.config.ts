import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude integration tests by default (they require model downloads)
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.integration.test.*'
    ],
    // Set a reasonable timeout for unit tests
    testTimeout: 10000,
    // Allow running integration tests with --run integration
    // Use: npx vitest run --reporter=verbose --testNamePattern="integration" 
    // Or set environment variable: VITEST_RUN_INTEGRATION=true
    include: process.env.VITEST_RUN_INTEGRATION 
      ? ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}']
      : ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', '!**/*.integration.test.*'],
  },
});