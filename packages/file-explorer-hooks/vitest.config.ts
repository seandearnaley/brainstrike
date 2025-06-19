import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    alias: {
      '@brainstrike/workers': path.resolve(__dirname, '../workers'),
      '@brainstrike/workers/file-content-worker': path.resolve(
        __dirname,
        '../workers/file-content-worker.ts'
      ),
    },
  },
});
