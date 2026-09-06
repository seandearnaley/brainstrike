import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    globals: true,
    include: ['test/bst-372-memory.measurement.spec.ts'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
