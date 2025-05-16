import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['../../vitest.setup.ts'], // Point to root setup
    include: ['src/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: {
      '@brainstrike/types': resolve(__dirname, '../types/src'),
      '@brainstrike/ui': resolve(__dirname, '../ui/src'),
      '@brainstrike/utils': resolve(__dirname, '../utils/src'),
    },
  },
}); 