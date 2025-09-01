import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Shared configuration
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks', // Ensure proper isolation for WASM
    isolate: true,
    testTimeout: 30000, // Allow extra time for WASM initialization
    globals: true, // Enable globals for beforeEach, etc.
    // Use projects to define different environments
    projects: [
      {
        test: {
          name: 'node',
          include: ['**/*.{test,spec}.ts'],
          environment: 'node',
          globals: true,
        },
      },
      {
        test: {
          name: 'jsdom',
          include: ['**/*.{test,spec}.tsx'],
          environment: 'jsdom',
          globals: true,
        },
      },
    ],
  },
});
