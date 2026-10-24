/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  },
});
