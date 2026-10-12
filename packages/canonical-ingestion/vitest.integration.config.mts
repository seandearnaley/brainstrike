import path from 'node:path';
import { defineConfig } from 'vitest/config';
import config from './vitest.config.mts';

export default defineConfig({
  ...config,
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
  test: { ...config.test, include: ['__tests__/**/*.integration.test.ts'] },
});
