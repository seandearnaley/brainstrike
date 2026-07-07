import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@brainstrike/workers': path.resolve(import.meta.dirname, '../workers'),
      '@brainstrike/workers/file-content-worker': path.resolve(
        import.meta.dirname,
        '../workers/file-content-worker.ts'
      ),
    },
  },
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    isolate: true,
    // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
    maxWorkers: 1,
    pool: 'threads',
    reporters: 'basic',
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    silent: true,
    testTimeout: 30_000,
  },
});
