import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@brainstrike/indexing-contract': resolve(import.meta.dirname, '../indexing-contract/src'),
    },
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['__tests__/**/*.test.{ts,tsx}'],
    testTimeout: 10_000,
  },
});
