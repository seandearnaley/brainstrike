/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    deps: {
      external: ['electron'],
    },
  },
  resolve: {
    alias: {
      electron: path.resolve(__dirname, '__mocks__/electron.ts'),
    },
  },
});