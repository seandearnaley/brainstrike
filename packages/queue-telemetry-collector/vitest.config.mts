/// <reference types="vitest" />
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    exclude: ['dist', 'node_modules'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**'],
    },
  },
  resolve: {
    alias: {
      '@brainstrike/queue': resolve(__dirname, '../queue/src/index.ts'),
      '@brainstrike/utils': resolve(__dirname, '../utils/src/index.ts'),
    },
  },
});
