/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['../test-utils/src/vitest.setup.ts'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/__tests__/**',
        '**/vitest.config.ts',
        '**/src/types.ts', // Type definitions only
        '**/src/index.ts', // Re-export file
        // '**/src/app-layout.tsx', // Simple wrapper component -- Commenting out for coverage
        '**/src/page-wrapper.tsx', // Simple wrapper component
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: {
      electron: path.resolve(__dirname, '../storage/__mocks__/electron.ts'),
      '@brainstrike/storage': path.resolve(__dirname, '../storage/dist'),
    },
  },
});
