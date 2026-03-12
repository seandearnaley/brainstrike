import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@brainstrike/utils': path.resolve(import.meta.dirname, '../utils/src'),
      '@brainstrike/types': path.resolve(import.meta.dirname, '../types/src'),
    },
  },
});
