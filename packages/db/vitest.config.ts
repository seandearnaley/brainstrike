import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks', // Ensure proper isolation for WASM
    isolate: true,
    testTimeout: 30000, // Allow extra time for WASM initialization
    globals: true, // Enable globals for beforeEach, etc.
    // Use different environments based on file patterns
    environmentMatchGlobs: [
      ['**/*.{test,spec}.tsx', 'jsdom'], // React component tests
      ['**/*', 'node'], // Everything else (including .ts files)
    ],
  },
});
