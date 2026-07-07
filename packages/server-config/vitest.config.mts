/// <reference types="vitest" />
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@brainstrike/platform-utils': resolve(import.meta.dirname, '../platform-utils/src'),
    },
  },
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    setupFiles: ['../test-utils/src/vitest.setup.ts'],
    // Coverage consolidated at root vitest.config.mts
  },
});
