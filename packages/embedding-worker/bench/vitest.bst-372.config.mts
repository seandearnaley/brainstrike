import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    include: ['test/bst-372-memory.measurement.spec.ts'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
