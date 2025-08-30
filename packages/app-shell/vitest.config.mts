/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['../test-utils/src/vitest.setup.ts'],
    unstubGlobals: true,
    // Use threads and cap workers to avoid EPERM during Tinypool worker teardown in sandboxed environments
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 2,
      },
    },
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Coverage consolidated at root vitest.config.ts
  },
  resolve: {
    alias: {
      electron: path.resolve(__dirname, '../storage/__mocks__/electron.ts'),
      '@brainstrike/storage': path.resolve(__dirname, '../storage/dist'),
      '@brainstrike/embeddings': path.resolve(__dirname, '__mocks__/embeddings.ts'),
      '/worker-storage.worker.js': path.resolve(__dirname, '__mocks__/worker-storage.worker.js'),
    },
  },
  define: {
    'import.meta.url': JSON.stringify('file:///mock/url'),
  },
  server: {
    fs: {
      allow: ['.'],
    },
  },
});
