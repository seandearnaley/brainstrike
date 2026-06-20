/// <reference types="vitest" />
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
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
});
