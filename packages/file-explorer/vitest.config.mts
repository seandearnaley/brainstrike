import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // Coverage consolidated at root vitest.config.ts
  },
  resolve: {
    alias: {
      '@brainstrike/storage': path.resolve(__dirname, '../storage/src'),
      '@brainstrike/file-system': path.resolve(__dirname, '../file-system/src'),
    },
  },
});
