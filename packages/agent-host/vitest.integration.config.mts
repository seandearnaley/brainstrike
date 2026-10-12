import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: [
      // Native process entrypoints are emitted JS siblings (BST-1977).
      {
        find: /^@brainstrike\/indexer$/,
        replacement: resolve(import.meta.dirname, '../indexer/dist/index.js'),
      },
      ...(Array.isArray(baseConfig.resolve?.alias) ? baseConfig.resolve.alias : []),
    ],
  },
  test: {
    ...baseConfig.test,
    coverage: { enabled: false },
    include: ['**/*.integration.test.?(c|m)[jt]s?(x)'],
  },
});
