/// <reference types="vitest" />
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve the workspace dep to its source so tests don't require a built
    // dist (mirrors the alias pattern used across the monorepo's vitest setups).
    alias: [
      {
        find: '@brainstrike/context-actions',
        replacement: resolve(import.meta.dirname, '../context-actions/src/index.ts'),
      },
    ],
  },
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  },
});
