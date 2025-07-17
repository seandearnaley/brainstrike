/// <reference types="vitest" />

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    server: {
      deps: {
        external: ['electron'],
      },
    },
  },
  resolve: {
    alias: {
      electron: path.resolve(__dirname, '__mocks__/electron.ts'),
    },
  },
});
