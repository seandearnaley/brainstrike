/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import path from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasEntries } from '../agent/config/browser-safe-subpath-aliases.mjs';

export default defineConfig({
  // Preserve real module URLs: source-boundary tests read files relative to them.
  // Vitest 5 applies define replacements to test modules too (BST-1689).
  resolve: {
    alias: [
      {
        find: '@brainstrike/embeddings/runtime-config',
        replacement: path.resolve(import.meta.dirname, '../embeddings/src/runtime-config.ts'),
      },
      {
        find: '@brainstrike/embeddings/inference-plan',
        replacement: path.resolve(import.meta.dirname, '../embeddings/src/inference-plan.ts'),
      },
      {
        find: '@brainstrike/embeddings/provider-core',
        replacement: path.resolve(import.meta.dirname, '../embeddings/src/provider-core.ts'),
      },
      {
        find: /^@brainstrike\/indexing-contract$/,
        replacement: path.resolve(import.meta.dirname, '../indexing-contract/src/index.ts'),
      },
      {
        find: /^@brainstrike\/assistant-contract\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, '../assistant-contract/src/$1.ts'),
      },
      {
        find: /^@brainstrike\/assistant-contract$/,
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
        // Anchored: a bare-string find would also capture the
        // './commands' subpath export, which the registry spread resolves.
        find: /^@brainstrike\/context-actions$/,
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
        find: '@brainstrike/workspace-search/chunk-selection-store',
        replacement: path.resolve(
          import.meta.dirname,
          '../workspace-search/src/bridge/chunk-selection-store.ts'
        ),
      },
      {
        find: '@brainstrike/workspace-search/workspace-search-store',
        replacement: path.resolve(
          import.meta.dirname,
          '../workspace-search/src/core/workspace-search-store.ts'
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
        find: '@brainstrike/embeddings',
        replacement: path.resolve(import.meta.dirname, '__mocks__/embeddings.ts'),
      },
      ...createAgentBrowserSafeAliasEntries(path.resolve(import.meta.dirname, '../agent')),
      {
        find: '@brainstrike/text-splitter/chunking-core',
        replacement: path.resolve(import.meta.dirname, '../text-splitter/src/chunking-core.ts'),
      },
      {
        find: /^@brainstrike\/text-splitter$/,
        replacement: path.resolve(import.meta.dirname, '../text-splitter/src/index.ts'),
      },
      {
        find: '@brainstrike/assistant-ui/context-usage-store',
        replacement: path.resolve(
          import.meta.dirname,
          '../assistant-ui/src/context-usage-store.ts'
        ),
      },
      {
        find: '@brainstrike/assistant-ui/follow-up-queue-store',
        replacement: path.resolve(
          import.meta.dirname,
          '../assistant-ui/src/follow-up-queue-store.ts'
        ),
      },
      {
        find: '@brainstrike/assistant-ui/rewind-composer-store',
        replacement: path.resolve(
          import.meta.dirname,
          '../assistant-ui/src/rewind-composer-store.ts'
        ),
      },
      {
        // Root aliases must be anchored because this package has subpath exports.
        find: /^@brainstrike\/assistant-ui$/,
        replacement: path.resolve(import.meta.dirname, '../assistant-ui/src/index.ts'),
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
        find: '@brainstrike/file-import/chunking-worker-context',
        replacement: path.resolve(
          import.meta.dirname,
          '../file-import/src/chunking-worker-context.tsx'
        ),
      },
      {
        // Regex-EXACT: a string find would also capture subpaths like
        // file-import/browser-queue-port and rewrite them onto index.ts/<sub>
        // (nonexistent). Subpaths resolve via the registry's exact entries.
        find: /^@brainstrike\/file-import$/,
        replacement: path.resolve(import.meta.dirname, '../file-import/src/index.ts'),
      },
      {
        find: /^@brainstrike\/vector-management$/,
        replacement: path.resolve(import.meta.dirname, '../vector-management/src/index.ts'),
      },
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: path.resolve(import.meta.dirname, '../workers/file-content-worker.ts'),
      },
      {
        find: '/worker-storage.worker.js',
        replacement: path.resolve(import.meta.dirname, '__mocks__/worker-storage.worker.js'),
      },
      // Registry fills gaps (commands, file-system, file-explorer-hooks,
      // file-explorer-ui root, etc. — previously resolved from built dist).
      // @brainstrike/storage now also comes from the registry (source): its old
      // `../storage/dist` pin traced to the #304 config standardization, not a
      // behavioral fix, and the suite passes from src with no dist present.
      // The deliberate local overrides above (embeddings -> mock, electron ->
      // mock, worker-storage.worker.js -> mock) win by first-match ordering.
      // See workspace-src-aliases (incident #1066/#1207).
      ...workspaceSrcAliases(path.resolve(import.meta.dirname, '..')),
    ],
  },
  server: {
    fs: {
      allow: ['.'],
    },
  },
  test: {
    environment: 'jsdom',
    // `*.compiled.test.*` suites run in vitest.compiled.config.mts.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.compiled.test.{ts,tsx}'],
    globals: true,
    hookTimeout: 30_000,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    pool: 'threads',
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.event-loop-watchdog.setup', './vitest.setup.ts'],
    testTimeout: 30_000,
    unstubGlobals: true,
    // Coverage consolidated at root vitest.config.mts
  },
});
