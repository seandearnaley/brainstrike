import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps (chunking-worker, db, embeddings, indexing-contract,
    // queue, text-splitter, types, utils, worker-runtime) from SOURCE, not dist.
    // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    // Coverage consolidated at root vitest.config.mts
    coverage: {
      enabled:
        process.env['COVERAGE'] !== 'false' &&
        (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true'),
      exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      provider: 'v8',
    },
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    pool: 'threads',
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  },
});
