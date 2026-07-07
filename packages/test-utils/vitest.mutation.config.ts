import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}', '__tests__/**/*.test.{ts,tsx}'],
    isolate: true,
    // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
    maxWorkers: 1,
    pool: 'threads',
    reporters: 'basic',
    setupFiles: ['src/vitest.setup.ts'],
    silent: true,
    testTimeout: 30_000,
  },
});
