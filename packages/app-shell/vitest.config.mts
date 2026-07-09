/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasEntries } from '../agent/config/browser-safe-subpath-aliases.mjs';

export default defineConfig({
  define: {
    'import.meta.url': JSON.stringify('file:///mock/url'),
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
        find: '@brainstrike/indexing-contract',
        replacement: path.resolve(import.meta.dirname, '../indexing-contract/src/index.ts'),
      },
      {
        find: /^@brainstrike\/assistant-contract\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, '../assistant-contract/src/$1.ts'),
      },
      {
        find: '@brainstrike/assistant-contract',
        replacement: path.resolve(import.meta.dirname, '../assistant-contract/src/index.ts'),
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
        find: '@brainstrike/context-actions',
        replacement: path.resolve(import.meta.dirname, '../context-actions/src/index.ts'),
      },
      {
        find: '@brainstrike/db-explorer/context-actions',
        replacement: path.resolve(
          import.meta.dirname,
          '../db-explorer/src/context-actions/index.ts'
        ),
      },
      {
        find: '@brainstrike/db-explorer/database-demo-panel',
        replacement: path.resolve(
          import.meta.dirname,
          '../db-explorer/src/database-demo-panel.tsx'
        ),
      },
      {
        find: '@brainstrike/db-explorer/embedding-models',
        replacement: path.resolve(
          import.meta.dirname,
          '../db-explorer/src/utils/embedding-models.ts'
        ),
      },
      {
        find: /^@brainstrike\/workspace-search$/,
        replacement: path.resolve(import.meta.dirname, '../workspace-search/src/index.ts'),
      },
      {
        find: /^@brainstrike\/db-explorer$/,
        replacement: path.resolve(import.meta.dirname, '../db-explorer/src/index.ts'),
      },
      {
        find: /^@brainstrike\/db$/,
        replacement: path.resolve(import.meta.dirname, '../db/src/index.ts'),
      },
      {
        find: /^@brainstrike\/file-explorer-ui\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, '../file-explorer-ui/src/$1'),
      },
      {
        find: /^@brainstrike\/queue$/,
        replacement: path.resolve(import.meta.dirname, '../queue/src/index.ts'),
      },
      {
        find: '@brainstrike/storage',
        replacement: path.resolve(import.meta.dirname, '../storage/dist'),
      },
      {
        find: '@brainstrike/embeddings',
        replacement: path.resolve(import.meta.dirname, '__mocks__/embeddings.ts'),
      },
      ...createAgentBrowserSafeAliasEntries(path.resolve(import.meta.dirname, '../agent')),
      {
        find: '@brainstrike/text-splitter/chunking-core',
        replacement: path.resolve(import.meta.dirname, '../text-splitter/src/chunking-core.ts'),
      },
      {
        find: '@brainstrike/text-splitter/token-counting-heuristics',
        replacement: path.resolve(
          import.meta.dirname,
          '../text-splitter/src/token-counting-heuristics.ts'
        ),
      },
      {
        find: '@brainstrike/text-splitter/token-constants',
        replacement: path.resolve(import.meta.dirname, '../text-splitter/src/token-constants.ts'),
      },
      {
        find: '@brainstrike/text-splitter/token-utils-accurate-lite',
        replacement: path.resolve(
          import.meta.dirname,
          '../text-splitter/src/token-utils-accurate-lite.ts'
        ),
      },
      {
        find: /^@brainstrike\/text-splitter$/,
        replacement: path.resolve(import.meta.dirname, '../text-splitter/src/index.ts'),
      },
      {
        find: /^@brainstrike\/preferences\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, '../preferences/src/$1'),
      },
      {
        find: '@brainstrike/ui/assistant-ui-panel',
        replacement: path.resolve(import.meta.dirname, '../ui/src/assistant-ui-panel/index.ts'),
      },
      {
        find: /^@brainstrike\/ui$/,
        replacement: path.resolve(import.meta.dirname, '../ui/src/index.ts'),
      },
      {
        find: /^@brainstrike\/utils$/,
        replacement: path.resolve(import.meta.dirname, '../utils/src'),
      },
      {
        find: '@brainstrike/utils/crypto',
        replacement: path.resolve(import.meta.dirname, '../utils/src/crypto.ts'),
      },
      {
        find: /^@brainstrike\/utils\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, '../utils/src/$1.ts'),
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
        find: /^@brainstrike\/vector-management$/,
        replacement: path.resolve(import.meta.dirname, '../vector-management/src/index.ts'),
      },
      {
        find: '@brainstrike/workers/report-generation-worker',
        replacement: path.resolve(import.meta.dirname, '../workers/report-generation-worker.ts'),
      },
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: path.resolve(import.meta.dirname, '../workers/file-content-worker.ts'),
      },
      {
        find: '/worker-storage.worker.js',
        replacement: path.resolve(import.meta.dirname, '__mocks__/worker-storage.worker.js'),
      },
    ],
  },
  server: {
    fs: {
      allow: ['.'],
    },
  },
  test: {
    environment: 'jsdom',
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: true,
    hookTimeout: 30_000,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    pool: 'threads',
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
    unstubGlobals: true,
    // Coverage consolidated at root vitest.config.mts
  },
});
