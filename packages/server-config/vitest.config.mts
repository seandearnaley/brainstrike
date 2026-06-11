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
    globals: true,
    environment: 'node',
    setupFiles: ['../test-utils/src/vitest.setup.ts'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Coverage consolidated at root vitest.config.mts
  },
});
