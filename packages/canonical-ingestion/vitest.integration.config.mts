import path from 'node:path';
import { defineConfig } from 'vitest/config';
import config from './vitest.config.mts';

/** The Node integration lane: built native-process fixtures. */
export default defineConfig({
  resolve: {
    ...config.resolve,
    alias: [
      {
        find: /^@brainstrike\/indexer$/,
        replacement: path.resolve(import.meta.dirname, '../indexer/dist/index.js'),
      },
      ...(Array.isArray(config.resolve?.alias) ? config.resolve.alias : []),
    ],
  },
  test: {
    environment: 'node',
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    include: ['__tests__/**/*.integration.test.ts'],
    reporters: config.test?.reporters,
    setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
  },
});
