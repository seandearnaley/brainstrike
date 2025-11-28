/// <reference types="vitest" />

import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Vitest 4 configuration for @brainstrike/storage
 *
 * Uses jsdom environment with mocked electron for unit tests.
 * Browser tests (*.browser.test.ts) are excluded from unit test runs
 * and can be run separately with a browser-specific config if needed.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', '**/*.browser.test.{ts,tsx}'],
    // Vitest 4: server.deps replaces the deprecated deps config
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
