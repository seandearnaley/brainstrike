/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import path from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

// CI splits this lane into native Vitest shards (the Unit app-shell rows in
// .github/workflows/test.yml). vitest.compiled.config.mts spreads this test
// block, so the compiled lane is sharded the same way.
export function resolveAppShellTestShard(
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const shard = environment['APP_SHELL_TEST_SHARD'];
  if (!shard) {
    if (environment['APP_SHELL_TEST_SHARD_REQUIRED'] === 'true') {
      throw new Error('APP_SHELL_TEST_SHARD is required for the App Shell native-shard task');
    }
    return;
  }
  const match = /^(?<index>[1-9]\d*)\/(?<count>[1-9]\d*)$/u.exec(shard);
  if (!match?.groups) {
    throw new Error(`APP_SHELL_TEST_SHARD must use Vitest's i/N form; received "${shard}"`);
  }
  if (Number(match.groups.index) > Number(match.groups.count)) {
    throw new Error(`APP_SHELL_TEST_SHARD index must not exceed its count; received "${shard}"`);
  }
  return shard;
}

const appShellTestShard = resolveAppShellTestShard();

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
        find: /^@brainstrike\/vector-management$/,
        replacement: path.resolve(import.meta.dirname, '../vector-management/src/index.ts'),
      },
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: path.resolve(import.meta.dirname, '../workers/file-content-worker.ts'),
      },
    ],
  },
  server: {
    fs: {
      allow: ['.'],
    },
  },
  test: {
    environment: 'happy-dom',
    // `*.compiled.test.*` suites run in vitest.compiled.config.mts.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.compiled.test.{ts,tsx}'],
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    ...(appShellTestShard ? { shard: appShellTestShard } : {}),
    globals: true,
    hookTimeout: 30_000,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
    unstubGlobals: true,
    // Coverage consolidated at root vitest.config.mts
  },
});
