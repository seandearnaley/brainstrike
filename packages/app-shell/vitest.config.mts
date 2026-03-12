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
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'threads',
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Coverage consolidated at root vitest.config.mts
  },
  resolve: {
    alias: [
      {
        find: '@brainstrike/embeddings/runtime-config',
        replacement: path.resolve(import.meta.dirname, '../embeddings/src/runtime-config.ts'),
      },
      {
        find: '@brainstrike/embeddings/provider-core',
        replacement: path.resolve(import.meta.dirname, '../embeddings/src/provider-core.ts'),
      },
      {
        find: '@brainstrike/embeddings/backend',
        replacement: path.resolve(import.meta.dirname, '../embeddings/src/backend-entry.ts'),
      },
      {
        find: '@brainstrike/embeddings/factory',
        replacement: path.resolve(import.meta.dirname, '../embeddings/src/factory-entry.ts'),
      },
      {
        find: '@brainstrike/embeddings/service',
        replacement: path.resolve(import.meta.dirname, '../embeddings/src/service-entry.ts'),
      },
      {
        find: '@brainstrike/embeddings/worker',
        replacement: path.resolve(import.meta.dirname, '../embeddings/src/worker-entry.ts'),
      },
      {
        find: 'electron',
        replacement: path.resolve(import.meta.dirname, '../storage/__mocks__/electron.ts'),
      },
      {
        find: '@brainstrike/storage',
        replacement: path.resolve(import.meta.dirname, '../storage/dist'),
      },
      {
        find: '@brainstrike/embeddings',
        replacement: path.resolve(import.meta.dirname, '__mocks__/embeddings.ts'),
      },
      {
        find: '@brainstrike/agent/client',
        replacement: path.resolve(import.meta.dirname, '../agent/src/client.ts'),
      },
      {
        find: '@brainstrike/preferences',
        replacement: path.resolve(import.meta.dirname, '../preferences/src/index.ts'),
      },
      {
        find: '@brainstrike/file-import/chunking-worker-context',
        replacement: path.resolve(
          import.meta.dirname,
          '../file-import/src/chunking-worker-context.tsx'
        ),
      },
      {
        find: '@brainstrike/file-import',
        replacement: path.resolve(import.meta.dirname, '../file-import/src/index.ts'),
      },
      {
        find: '/worker-storage.worker.js',
        replacement: path.resolve(import.meta.dirname, '__mocks__/worker-storage.worker.js'),
      },
    ],
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
