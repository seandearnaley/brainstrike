import { resolve } from 'node:path';
import {
  buildNodeRuntimeBundle,
  NODE_RUNTIME_BUNDLE_ENV,
  nodeRuntimeBundleAliases,
} from '@brainstrike/test-utils/node-runtime-bundle';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

// The real-process suites fork the indexer's process entry and start its writer
// worker beside the indexer's own module, so they run a bundle of its source
// with those entries beside it.
const bundle = await buildNodeRuntimeBundle({
  consumerDir: import.meta.dirname,
  entries: {
    host: resolve(import.meta.dirname, 'src/process-core.ts'),
    index: resolve(import.meta.dirname, 'src/index.ts'),
    metadata: resolve(import.meta.dirname, 'src/metadata-reader.ts'),
    'process-entry': resolve(import.meta.dirname, 'src/process-entry.ts'),
    'schema-compatibility-crash': resolve(
      import.meta.dirname,
      '__tests__/fixtures/schema-compatibility-crash.mjs'
    ),
    'sqlite-native': resolve(import.meta.dirname, '../sqlite-native/src/index.ts'),
    transport: resolve(import.meta.dirname, 'src/transport.ts'),
  },
});

export default defineConfig({
  resolve: {
    alias: nodeRuntimeBundleAliases(bundle, {
      '@brainstrike/indexer': 'index',
      '@brainstrike/indexer/transport': 'transport',
    }),
  },
  test: {
    env: { [NODE_RUNTIME_BUNDLE_ENV]: bundle },
    environment: 'node',
    // The same real-process suites as coverage (vitest.config.mts), so the same budget.
    hookTimeout: getAdjustedTimeout('integration'),
    include: ['__tests__/**/*.integration.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: getAdjustedTimeout('integration'),
  },
});
