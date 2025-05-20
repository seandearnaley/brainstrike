import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: {
      '@brainstrike/types': resolve(__dirname, '../types/src'),
      '@brainstrike/ui': resolve(__dirname, '../ui/src'),
      '@brainstrike/utils': resolve(__dirname, '../utils/src'),
      '@brainstrike/file-explorer': resolve(__dirname, '../file-explorer/src'),
      '@brainstrike/file-explorer-ui': resolve(__dirname, './src'),
    },
  },
});
