/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasEntries } from '../agent/config/browser-safe-subpath-aliases.mjs';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@brainstrike\/assistant-contract\/(.*)$/,
        replacement: resolve(import.meta.dirname, '../assistant-contract/src/$1.ts'),
      },
      {
        find: '@brainstrike/assistant-contract',
        replacement: resolve(import.meta.dirname, '../assistant-contract/src/index.ts'),
      },
      ...createAgentBrowserSafeAliasEntries(resolve(import.meta.dirname, '../agent')),
      {
        find: '@brainstrike/embeddings/provider-core',
        replacement: resolve(import.meta.dirname, '../embeddings/src/provider-core.ts'),
      },
      {
        find: '@brainstrike/embeddings/factory',
        replacement: resolve(import.meta.dirname, '../embeddings/src/factory-entry.ts'),
      },
      {
        find: '@brainstrike/embeddings/service',
        replacement: resolve(import.meta.dirname, '../embeddings/src/service-entry.ts'),
      },
      {
        find: '@brainstrike/storage',
        replacement: resolve(import.meta.dirname, '../storage/src/index.ts'),
      },
      {
        // Regex-EXACT: a string find would also capture subpaths like
        // ui/markdown-surface and rewrite them onto index.ts/<sub>
        // (nonexistent). Subpaths resolve via the registry's exact entries.
        find: /^@brainstrike\/ui$/,
        replacement: resolve(import.meta.dirname, '../ui/src/index.ts'),
      },
      // @brainstrike/workers has no src/ dir (worker files at the package root),
      // so the registry skips it; alias its remaining subpath explicitly — reached
      // transitively via file-explorer-hooks/file-explorer-ui src.
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: resolve(import.meta.dirname, '../workers/file-content-worker.ts'),
      },
      {
        find: '@brainstrike/file-import/browser-queue-port',
        replacement: resolve(import.meta.dirname, '../file-import/src/browser-queue-port.ts'),
      },
      {
        find: '@brainstrike/file-import/chunking-worker-context',
        replacement: resolve(import.meta.dirname, '../file-import/src/chunking-worker-context.tsx'),
      },
      {
        find: '@brainstrike/file-import/enhanced-import',
        replacement: resolve(import.meta.dirname, '../file-import/src/enhanced-import.ts'),
      },
      {
        find: '@brainstrike/file-explorer-ui/shell',
        replacement: resolve(import.meta.dirname, '../file-explorer-ui/src/shell'),
      },
      {
        find: '@brainstrike/pipeline',
        replacement: resolve(import.meta.dirname, '../pipeline/src'),
      },
      {
        // Anchored: a bare-string find would also capture the
        // './commands' subpath export, which the registry spread resolves.
        find: /^@brainstrike\/context-actions$/,
        replacement: resolve(import.meta.dirname, '../context-actions/src/index.ts'),
      },
      {
        find: '@brainstrike/indexing-contract',
        replacement: resolve(import.meta.dirname, '../indexing-contract/src'),
      },
      // Registry fills the gaps for workspace packages reached unmocked by
      // tests but not aliased above. Hand-rolled entries win by first-match.
      // See workspace-src-aliases (incident #1066/#1207).
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    coverage: {
      enabled: coverageEnabled,
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData/**',
        'src/**/__tests__/**',
      ],
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    environment: 'happy-dom',
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: [
      '@brainstrike/test-utils/vitest.event-loop-watchdog.setup',
      '@brainstrike/test-utils/vitest.setup',
    ],
    unstubGlobals: true,
  },
});
