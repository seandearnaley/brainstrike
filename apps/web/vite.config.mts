/// <reference types="vitest" />
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Replicate necessary config from vite.config.ts, especially aliases
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      src: path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/vitest.setup.ts',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      exclude: [
        '**/*.config.{ts,mts}',
        '**/*.config.js',
        '**/__mocks__/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/public/**',
        '**/e2e/**',
        '**/src/main.tsx',
        '**/src/test/**',
        '**/src/types/**'
      ],
    },
  },
});