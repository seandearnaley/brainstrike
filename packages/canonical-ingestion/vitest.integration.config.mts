import path from 'node:path';
import { defineConfig } from 'vitest/config';
import config from './vitest.config.mts';

/** The Node integration lane: built native-process fixtures, without the unit config's browser project. */
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
    globals: true,
    include: ['__tests__/**/*.integration.test.ts'],
    reporters: config.test?.reporters,
    setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
  },
});
