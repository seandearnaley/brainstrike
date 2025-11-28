/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    unstubGlobals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    // Use all available cores for faster test execution
    pool: 'threads',
    // Vitest 4: use maxWorkers instead of poolOptions.threads.maxThreads
    maxWorkers: 4,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Coverage consolidated at root vitest.config.ts
  },
  resolve: {
    alias: {
      electron: path.resolve(__dirname, '../storage/__mocks__/electron.ts'),
      '@brainstrike/storage': path.resolve(__dirname, '../storage/dist'),
      '@brainstrike/embeddings': path.resolve(__dirname, '__mocks__/embeddings.ts'),
      '@brainstrike/agent/client': path.resolve(__dirname, '../agent/src/client.ts'),
      '@brainstrike/preferences': path.resolve(__dirname, '../preferences/src/index.ts'),
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
