/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['../test-utils/src/vitest.setup.ts'],
    unstubGlobals: true,
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 2,
      },
    },
  },
});
